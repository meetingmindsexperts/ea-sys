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
HEALTH_RETRIES=30   # 30 × 2s = 60 seconds max wait
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

# ── Remove only dangling images (preserve build cache for fast rebuilds) ───────
docker image prune -f
phase_done "Image prune"

# ── Build inactive slot with BuildKit ─────────────────────────────────────────
echo "==> Building ea-sys-$INACTIVE..."
DOCKER_BUILDKIT=1 $COMPOSE build "ea-sys-$INACTIVE"
phase_done "Build ea-sys-$INACTIVE"

# ── Run DB migrations using the builder stage (has full node_modules) ─────────
# The builder stage is already cached by BuildKit — tagging it is near-instant.
# docker run --env-file does NOT strip quotes from values (unlike dotenv), so we
# extract and unquote the URL explicitly. DIRECT_URL bypasses the connection
# pooler, which is required for schema migrations.
echo "==> Running database migrations..."
MIGRATION_DB_URL=$(grep -E "^DIRECT_URL=" "$DEPLOY_DIR/.env" | head -1 | sed 's/^DIRECT_URL=//; s/^["'"'"']//; s/["'"'"']$//')
if [ -z "$MIGRATION_DB_URL" ]; then
  MIGRATION_DB_URL=$(grep -E "^DATABASE_URL=" "$DEPLOY_DIR/.env" | head -1 | sed 's/^DATABASE_URL=//; s/^["'"'"']//; s/["'"'"']$//')
fi
DOCKER_BUILDKIT=1 docker build --target builder -t ea-sys-migrator "$DEPLOY_DIR"
if ! docker run --rm \
    -e "DATABASE_URL=$MIGRATION_DB_URL" \
    ea-sys-migrator npx prisma migrate deploy; then
  echo "✗ Migration failed. Aborting deploy."
  docker rmi ea-sys-migrator || true
  exit 1
fi
docker rmi ea-sys-migrator || true
phase_done "Database migrations"

# ── Start inactive slot (active slot still serving traffic) ───────────────────
echo "==> Starting ea-sys-$INACTIVE..."
$COMPOSE up -d "ea-sys-$INACTIVE"
phase_done "Start ea-sys-$INACTIVE"

# ── Health check ──────────────────────────────────────────────────────────────
echo "==> Waiting for health check on :$INACTIVE_PORT..."
ATTEMPTS=0
until curl -sf "http://localhost:$INACTIVE_PORT/api/health" > /dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge "$HEALTH_RETRIES" ]; then
    echo "✗ Health check failed after $((HEALTH_RETRIES * 2))s. Rolling back."
    $COMPOSE stop "ea-sys-$INACTIVE" || true
    $COMPOSE rm -f "ea-sys-$INACTIVE" || true
    exit 1
  fi
  sleep 2
done
echo "✓ Health check passed"
phase_done "Health check"

# ── Switch nginx upstream (graceful reload — zero dropped requests) ────────────
echo "==> Switching nginx upstream to port $INACTIVE_PORT..."
echo "server 127.0.0.1:$INACTIVE_PORT;" | sudo tee "$NGINX_UPSTREAM" > /dev/null
if sudo nginx -t; then
  sudo nginx -s reload
else
  echo "✗ nginx config test failed. Rolling back upstream and stopping ea-sys-$INACTIVE."
  echo "server 127.0.0.1:$ACTIVE_PORT;" | sudo tee "$NGINX_UPSTREAM" > /dev/null
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
