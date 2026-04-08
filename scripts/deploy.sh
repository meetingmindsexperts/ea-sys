#!/usr/bin/env bash
# Blue-green deploy script for ea-sys
# Builds the inactive slot, health-checks it, switches nginx, then stops the old slot.
# Zero downtime: nginx reload is graceful (in-flight requests finish on old slot).
#
# One-time server setup required before first run — see deploy/SERVER_SETUP.md

set -euo pipefail

SCRIPT_START=$(date +%s)
PHASE_START=$SCRIPT_START
phase_done() {
  local label="$1"
  local now
  now=$(date +%s)
  local took=$((now - PHASE_START))
  printf '⏱ %s took %ss\n' "$label" "$took"
  PHASE_START=$now
}

DEPLOY_DIR="/home/ubuntu/ea-sys"
SLOT_FILE="/home/ubuntu/.active-slot"
NGINX_UPSTREAM="/etc/nginx/conf.d/ea-sys-upstream.conf"
HEALTH_RETRIES=40   # 40 × 1s = 40 seconds max wait
COMPOSE="docker compose -f $DEPLOY_DIR/docker-compose.prod.yml"

cd "$DEPLOY_DIR"

# ── Determine slots ────────────────────────────────────────────────────────────
ACTIVE=$(cat "$SLOT_FILE" 2>/dev/null || echo "blue")
if [ "$ACTIVE" = "blue" ]; then
  INACTIVE="green"
  INACTIVE_PORT=3001
else
  INACTIVE="blue"
  INACTIVE_PORT=3000
fi

ACTIVE_PORT=3000
if [ "$ACTIVE" = "green" ]; then
  ACTIVE_PORT=3001
fi

echo "==> Active: $ACTIVE | Deploying to: $INACTIVE (port $INACTIVE_PORT)"

# ── Ensure bind-mounted directories exist with correct ownership ──────────────
# Docker bind mounts override container dir ownership, so host dirs must be
# writable by the container's "nextjs" user (uid 1001).
echo "==> Ensuring bind-mount directories..."
mkdir -p "$DEPLOY_DIR/logs" "$DEPLOY_DIR/public/uploads"
sudo chown -R 1001:1001 "$DEPLOY_DIR/logs" "$DEPLOY_DIR/public/uploads"
phase_done "Bind-mount dirs"

# ── Remove only dangling images in background (non-blocking) ──────────────────
docker image prune -f > /dev/null 2>&1 &
PRUNE_PID=$!

# ── Build inactive slot with BuildKit ─────────────────────────────────────────
echo "==> Building ea-sys-$INACTIVE..."
DOCKER_BUILDKIT=1 $COMPOSE build "ea-sys-$INACTIVE"
phase_done "Build ea-sys-$INACTIVE"

# Collect background prune (already finished by now, just reap the process)
wait $PRUNE_PID 2>/dev/null || true

# ── Run DB migrations using the builder stage (has full node_modules) ─────────
# The builder stage is already cached by BuildKit — tagging it is near-instant.
# docker run --env-file does NOT strip quotes from values (unlike dotenv), so we
# extract and unquote both URLs explicitly.
# - DIRECT_URL bypasses the connection pooler (required for schema migrations)
# - Both DATABASE_URL and DIRECT_URL must be set; schema.prisma references both
echo "==> Running database migrations..."
MIGRATION_DIRECT_URL=$(grep -E "^DIRECT_URL=" "$DEPLOY_DIR/.env" | head -1 | sed 's/^DIRECT_URL=//; s/^["'"'"']//; s/["'"'"']$//')
MIGRATION_DATABASE_URL=$(grep -E "^DATABASE_URL=" "$DEPLOY_DIR/.env" | head -1 | sed 's/^DATABASE_URL=//; s/^["'"'"']//; s/["'"'"']$//')
# Fall back to DATABASE_URL if DIRECT_URL is not set
if [ -z "$MIGRATION_DIRECT_URL" ]; then
  MIGRATION_DIRECT_URL="$MIGRATION_DATABASE_URL"
fi
DOCKER_BUILDKIT=1 docker build --target builder -t ea-sys-migrator "$DEPLOY_DIR"
if ! docker run --rm \
    -e "DATABASE_URL=$MIGRATION_DIRECT_URL" \
    -e "DIRECT_URL=$MIGRATION_DIRECT_URL" \
    ea-sys-migrator npx prisma migrate deploy; then
  echo "✗ Migration failed. Aborting deploy."
  docker rmi ea-sys-migrator || true
  exit 1
fi
docker rmi ea-sys-migrator || true
phase_done "Database migrations"

# ── Ensure target port is free before starting inactive slot ──────────────────
# Guards against orphan containers (e.g. old single-slot 'ea-sys' that held
# the port before the blue-green migration) causing "port already allocated".
echo "==> Ensuring port $INACTIVE_PORT is free..."
PORT_HOLDER=$(docker ps -q --filter "publish=$INACTIVE_PORT" 2>/dev/null || true)
if [ -n "$PORT_HOLDER" ]; then
  echo "  Port $INACTIVE_PORT is held by container(s): $PORT_HOLDER — stopping..."
  docker stop $PORT_HOLDER || true
  docker rm -f $PORT_HOLDER || true
  echo "  Orphan container(s) removed."
fi

# ── Ensure MediaMTX (RTMP/HLS streaming) is running ─────────────────────────
# MediaMTX is a long-running service, not part of blue-green rotation.
# Start it if not already running.
if ! docker ps --format '{{.Names}}' | grep -q "ea-sys-mediamtx"; then
  echo "==> Starting MediaMTX streaming server..."
  $COMPOSE up -d mediamtx
  phase_done "Start MediaMTX"
else
  echo "==> MediaMTX already running"
fi

# ── Start inactive slot (active slot still serving traffic) ───────────────────
# --remove-orphans also cleans up compose-project-labelled orphan containers.
echo "==> Starting ea-sys-$INACTIVE..."
$COMPOSE up -d --remove-orphans "ea-sys-$INACTIVE"
phase_done "Start ea-sys-$INACTIVE"

# ── Health check ──────────────────────────────────────────────────────────────
echo "==> Waiting for health check on :$INACTIVE_PORT..."
ATTEMPTS=0
until curl -sf "http://localhost:$INACTIVE_PORT/api/health" > /dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge "$HEALTH_RETRIES" ]; then
    echo "✗ Health check failed after ${HEALTH_RETRIES}s. Rolling back."
    $COMPOSE stop "ea-sys-$INACTIVE" || true
    $COMPOSE rm -f "ea-sys-$INACTIVE" || true
    exit 1
  fi
  sleep 1
done
echo "✓ Health check passed"
phase_done "Health check"

# ── Switch nginx upstream (graceful reload — zero dropped requests) ────────────
# Write a complete upstream block so the conf.d file is valid at the nginx http
# level (conf.d/*.conf is auto-included there by the default nginx.conf).
# A bare "server 127.0.0.1:PORT;" is only valid inside an upstream{} context.
echo "==> Switching nginx upstream to port $INACTIVE_PORT..."
printf 'upstream ea_sys_app {\n    server 127.0.0.1:%s;\n    keepalive 32;\n}\n' \
  "$INACTIVE_PORT" | sudo tee "$NGINX_UPSTREAM" > /dev/null
if sudo nginx -t; then
  sudo nginx -s reload
else
  echo "✗ nginx config test failed. Rolling back upstream and stopping ea-sys-$INACTIVE."
  printf 'upstream ea_sys_app {\n    server 127.0.0.1:%s;\n    keepalive 32;\n}\n' \
    "$ACTIVE_PORT" | sudo tee "$NGINX_UPSTREAM" > /dev/null
  sudo nginx -t && sudo nginx -s reload || true
  $COMPOSE stop "ea-sys-$INACTIVE" || true
  $COMPOSE rm -f "ea-sys-$INACTIVE" || true
  exit 1
fi
phase_done "Nginx switch + reload"

# ── Persist active slot ───────────────────────────────────────────────────────
echo "$INACTIVE" > "$SLOT_FILE"

# ── Stop old slot ─────────────────────────────────────────────────────────────
echo "==> Stopping old ea-sys-$ACTIVE..."
$COMPOSE stop "ea-sys-$ACTIVE"
phase_done "Stop old slot"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "✓ Blue-green deploy complete"
echo "  Active slot : $INACTIVE (port $INACTIVE_PORT)"
echo "  Idle slot   : $ACTIVE (stopped)"
TOTAL_TAKE=$(( $(date +%s) - SCRIPT_START ))
echo "  Total deploy time: ${TOTAL_TAKE}s"
echo ""
$COMPOSE ps
echo ""
echo "==> Recent logs (ea-sys-$INACTIVE):"
$COMPOSE logs --tail=30 "ea-sys-$INACTIVE"
