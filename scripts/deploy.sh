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

# ── Failure alerting ──────────────────────────────────────────────────────────
# A deploy that dies half-way is the worst state this system can be in: the
# migration has already run, so the OLD slot may be serving live traffic against
# the NEW schema. Until now that failed silently into a terminal nobody was
# watching. Every abort path below now pages a human.
alert_failure() {
  local what="$1"
  bash "$DEPLOY_DIR/scripts/ops-alert.sh" \
    "EA-SYS DEPLOY FAILED on the box — $what" \
    "Deploy of ${IMAGE_TAG:-latest} aborted: ${what}

Active slot (per $SLOT_FILE): $(cat "$SLOT_FILE" 2>/dev/null || echo unknown)
Running containers:
$(docker ps --format '  {{.Names}}  {{.Status}}' 2>/dev/null || echo '  (docker ps failed)')

NOTE: migrations run BEFORE the nginx swap, so the new schema may already be
live while the old code serves traffic.

Roll back to a known-good image:
  IMAGE_TAG=<previous-full-40-char-sha> bash scripts/deploy.sh
Or flip the upstream back without redeploying:
  bash scripts/deploy.sh --rollback
Runbook: docs/ROLLBACK.md" || true
}

# ── Rollback mode ─────────────────────────────────────────────────────────────
# `bash scripts/deploy.sh --rollback`
#
# Recovering from a bad promote used to mean hand-editing the nginx upstream
# file and manually `docker compose up`-ing the other slot, from memory, at 3am.
# The old slot is only `stop`ped (never `rm`ed), so the previous container is
# still sitting there with the previous image — flipping back is a few seconds.
if [ "${1:-}" = "--rollback" ]; then
  CURRENT=$(cat "$SLOT_FILE" 2>/dev/null || echo "blue")
  if [ "$CURRENT" = "blue" ]; then
    PREVIOUS="green"; PREVIOUS_PORT=3001
  else
    PREVIOUS="blue"; PREVIOUS_PORT=3000
  fi

  echo "==> ROLLBACK: $CURRENT → $PREVIOUS (port $PREVIOUS_PORT)"
  echo "    This flips nginx back to the PREVIOUS container. It does NOT undo"
  echo "    database migrations — those are forward-only. See docs/ROLLBACK.md."

  cd "$DEPLOY_DIR"
  $COMPOSE up -d "ea-sys-$PREVIOUS"

  echo "==> Waiting for ea-sys-$PREVIOUS to answer..."
  ATTEMPTS=0
  until curl -sf "http://localhost:$PREVIOUS_PORT/api/health" > /dev/null 2>&1; do
    ATTEMPTS=$((ATTEMPTS + 1))
    if [ "$ATTEMPTS" -ge 30 ]; then
      echo "✗ ea-sys-$PREVIOUS did not become healthy. NOT switching nginx."
      echo "  Both slots are now unhealthy — this needs hands-on debugging:"
      $COMPOSE logs --tail=50 "ea-sys-$PREVIOUS" || true
      alert_failure "rollback FAILED — previous slot ($PREVIOUS) will not start"
      exit 1
    fi
    sleep 1
  done

  printf 'upstream ea_sys_app {\n    server 127.0.0.1:%s;\n    keepalive 32;\n}\n' \
    "$PREVIOUS_PORT" | sudo tee "$NGINX_UPSTREAM" > /dev/null
  sudo nginx -t && sudo nginx -s reload
  echo "$PREVIOUS" > "$SLOT_FILE"

  echo ""
  echo "✓ Rolled back. Serving from ea-sys-$PREVIOUS (port $PREVIOUS_PORT)."
  echo "  The bad slot (ea-sys-$CURRENT) is left RUNNING so you can read its logs:"
  echo "    docker logs ea-sys-$CURRENT --tail 200"
  exit 0
fi

# ── ECR image config ──────────────────────────────────────────────────────────
# CI (the "build-push" job) builds + pushes the web + worker images to ECR and
# the deploy job passes IMAGE_TAG=<git-sha>. The box then just `docker compose
# pull`s (seconds) instead of building on-box (~8 min). A manual/unparameterised
# run (no IMAGE_TAG) falls back to the moving :latest / :worker-latest tags.
# If the pull fails (ECR unreachable / image missing) the deploy falls back to
# building on the box — so a deploy never hard-fails on ECR.
ECR_REGISTRY="803726282629.dkr.ecr.ap-south-1.amazonaws.com"
ECR_REPO="$ECR_REGISTRY/ea-sys"
AWS_REGION="ap-south-1"
IMAGE_TAG="${IMAGE_TAG:-latest}"
# Exported so docker-compose's `build.args: GIT_SHA: ${IMAGE_TAG}` resolves on
# the on-box fallback build path (ECR unreachable). Without this the fallback
# image would report GIT_SHA=unknown and /api/health could not identify itself.
export IMAGE_TAG
if [ "$IMAGE_TAG" = "latest" ]; then
  export EA_SYS_WEB_IMAGE="$ECR_REPO:latest"
  export EA_SYS_WORKER_IMAGE="$ECR_REPO:worker-latest"
else
  export EA_SYS_WEB_IMAGE="$ECR_REPO:$IMAGE_TAG"
  export EA_SYS_WORKER_IMAGE="$ECR_REPO:worker-$IMAGE_TAG"
fi

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

# ── Free disk BEFORE pulling: trim old tagged images + build cache (INC-002 fix) ─
# docker-prune.sh keeps the newest KEEP_IMAGES web + worker :<sha> tags + the
# latest/worker-latest pointers + every in-use image (docker rmi refuses those),
# and removes old tagged per-deploy images + build cache + dangling layers. Run
# SYNCHRONOUSLY here so the space is actually free before the pull extracts new
# layers. Non-fatal — a prune hiccup must never abort a deploy (guarded `|| echo`).
# This replaces the old dangling-only background prune, which never reaped the
# TAGGED per-deploy images and let the disk fill (see docs/INCIDENTS.md INC-002);
# the weekly cron stays as a backstop.
echo "==> Pruning old Docker images + build cache before pull..."
bash "$DEPLOY_DIR/scripts/docker-prune.sh" || echo "⚠ docker-prune failed (continuing)"
phase_done "Prune old images"

# ── Pull images from ECR (fall back to on-box build) ──────────────────────────
# Fast path: CI already built + pushed the web + worker images, so the box just
# pulls (seconds). Fallback: if ECR login or pull fails (unreachable / image
# missing), build on the box exactly as before so a deploy never hard-fails.
# Both the web slot's `image:` and the worker's `image:` in the compose file
# resolve to EA_SYS_WEB_IMAGE / EA_SYS_WORKER_IMAGE (exported above), so `pull`
# and `up -d` both reference the same pinned tags.
echo "==> Logging in to ECR + pulling images ($IMAGE_TAG)..."
IMAGE_SOURCE="ecr-pull"
if aws ecr get-login-password --region "$AWS_REGION" 2>/dev/null \
     | docker login --username AWS --password-stdin "$ECR_REGISTRY" > /dev/null 2>&1 \
   && $COMPOSE pull "ea-sys-$INACTIVE" ea-sys-worker; then
  echo "✓ Pulled web + worker images from ECR"
else
  echo "⚠ ECR login/pull failed — falling back to on-box build"
  DOCKER_BUILDKIT=1 $COMPOSE build "ea-sys-$INACTIVE" ea-sys-worker
  IMAGE_SOURCE="on-box-build"
fi
phase_done "Pull/build images ($IMAGE_SOURCE)"

# ── Run DB migrations from the worker image (ships the full node_modules) ─────
# The worker image (Dockerfile.worker) carries the full node_modules — including
# the Prisma CLI + generated client — and prisma/ (schema + migrations), so it
# can run `prisma migrate deploy` directly. No separate builder-image build, and
# the DB creds stay in .env on the box (never in CI / GitHub). We pulled/built
# this image above, so this step is fast.
# docker run --env-file does NOT strip quotes from values (unlike dotenv), so we
# extract and unquote both URLs explicitly.
# - DIRECT_URL bypasses the connection pooler (required for schema migrations)
# - Both DATABASE_URL and DIRECT_URL must be set; schema.prisma references both
# - --user root avoids any write-permission surprises from the image's default
#   non-root user during the migration run
echo "==> Running database migrations (from worker image)..."
MIGRATION_DIRECT_URL=$(grep -E "^DIRECT_URL=" "$DEPLOY_DIR/.env" | head -1 | sed 's/^DIRECT_URL=//; s/^["'"'"']//; s/["'"'"']$//')
MIGRATION_DATABASE_URL=$(grep -E "^DATABASE_URL=" "$DEPLOY_DIR/.env" | head -1 | sed 's/^DATABASE_URL=//; s/^["'"'"']//; s/["'"'"']$//')
# Fall back to DATABASE_URL if DIRECT_URL is not set
if [ -z "$MIGRATION_DIRECT_URL" ]; then
  MIGRATION_DIRECT_URL="$MIGRATION_DATABASE_URL"
fi
if ! docker run --rm --user root \
    -e "DATABASE_URL=$MIGRATION_DIRECT_URL" \
    -e "DIRECT_URL=$MIGRATION_DIRECT_URL" \
    "$EA_SYS_WORKER_IMAGE" npx prisma migrate deploy; then
  echo "✗ Migration failed. Aborting deploy."
  echo "  The old slot is still serving traffic and is UNTOUCHED — this is the"
  echo "  safe failure. Fix the migration and redeploy."
  alert_failure "database migration failed (old slot still serving, no swap made)"
  exit 1
fi
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
    # Dump the evidence BEFORE destroying the container. Previously this printed
    # "health check failed" and immediately `rm -f`d the only thing that could
    # tell you why — so you were told it failed and nothing about the cause.
    echo ""
    echo "──── last 60 lines from ea-sys-$INACTIVE ────"
    $COMPOSE logs --tail=60 "ea-sys-$INACTIVE" 2>&1 || echo "(could not read logs)"
    echo "──── /api/health said ────"
    curl -s -m 5 "http://localhost:$INACTIVE_PORT/api/health" 2>&1 || echo "(no response at all)"
    echo ""
    echo "───────────────────────────────────────────────"
    echo ""
    $COMPOSE stop "ea-sys-$INACTIVE" || true
    $COMPOSE rm -f "ea-sys-$INACTIVE" || true
    echo "✓ Old slot ($ACTIVE) is still serving traffic — this is the safe failure."
    alert_failure "new slot failed its health check (old slot still serving, no swap made)"
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
  alert_failure "nginx config test failed (upstream reverted to the old slot)"
  exit 1
fi
phase_done "Nginx switch + reload"

# ── Smoke-test THROUGH nginx before we stop the old slot ──────────────────────
# The health gate above hits the container directly on its port. That proves the
# app booted; it does not prove that real traffic REACHES it. If nginx is now
# pointing somewhere that 502s, the deploy would previously have reported success
# and then stopped the only working container.
#
# The old slot is still up at this point, so a failure here flips straight back
# with zero downtime.
#
# ⚠ Hard-won detail: you MUST request the real hostname. nginx uses name-based
# virtual hosts, so `curl http://localhost/` carries `Host: localhost`, matches no
# server block, falls through to the default server and 404s — on a completely
# healthy app. (That is exactly what happened the first time this shipped: a false
# alarm that reverted a good deploy. Safely, but for no reason.) --resolve pins the
# real hostname to the local box so we test the actual vhost without leaving it.
SMOKE_URL=$(grep -E "^(NEXT_PUBLIC_APP_URL|NEXTAUTH_URL)=" "$DEPLOY_DIR/.env" 2>/dev/null \
  | head -1 | sed 's/^[A-Z_]*=//; s/^["'"'"']//; s/["'"'"']$//; s#/*$##')
SMOKE_HOST=$(echo "$SMOKE_URL" | sed -E 's#^https?://##; s#/.*##')

if [ -z "$SMOKE_HOST" ]; then
  # Fail OPEN, not closed. If we cannot work out our own hostname we do not know
  # what a correct response looks like, and a gate that wrongly refuses to ship is
  # its own hazard on a live system.
  echo "⚠ Could not determine the public hostname from .env — skipping the nginx smoke test."
else
  echo "==> Smoke-testing through nginx (https://${SMOKE_HOST} → 127.0.0.1)..."

  smoke_code() {
    curl -s -o /dev/null -w "%{http_code}" -m 10 \
      --resolve "${SMOKE_HOST}:443:127.0.0.1" \
      "https://${SMOKE_HOST}$1" 2>/dev/null || echo "000"
  }

  # /api/health is the ONLY veto. It is deterministic: 200 when the app is up.
  HEALTH_CODE=$(smoke_code "/api/health")
  case "$HEALTH_CODE" in
    2*|3*) echo "  ✓ /api/health → ${HEALTH_CODE}" ;;
    *)
      echo "  ✗ /api/health → ${HEALTH_CODE}"
      echo "✗ Traffic through nginx is NOT reaching the new slot. Reverting upstream."
      printf 'upstream ea_sys_app {\n    server 127.0.0.1:%s;\n    keepalive 32;\n}\n' \
        "$ACTIVE_PORT" | sudo tee "$NGINX_UPSTREAM" > /dev/null
      sudo nginx -t && sudo nginx -s reload || true
      echo "✓ Reverted to ea-sys-$ACTIVE (still running — no downtime)."
      echo "  New slot left up for inspection: docker logs ea-sys-$INACTIVE --tail 200"
      alert_failure "post-swap smoke test failed through nginx (reverted to the old slot)"
      exit 1
      ;;
  esac

  # The homepage is a WARNING, never a veto. It can legitimately redirect, gate on
  # auth, or change shape — an unexpected code here is far more likely to mean the
  # check is wrong than that the deploy is bad, and blocking a good deploy is worse
  # than shipping one with a noisy line in the log.
  ROOT_CODE=$(smoke_code "/")
  case "$ROOT_CODE" in
    2*|3*) echo "  ✓ / → ${ROOT_CODE}" ;;
    *)     echo "  ⚠ / → ${ROOT_CODE} (not blocking the deploy — /api/health is the gate)" ;;
  esac
fi
phase_done "Smoke test via nginx"

# ── Persist active slot ───────────────────────────────────────────────────────
echo "$INACTIVE" > "$SLOT_FILE"

# ── Stop old slot ─────────────────────────────────────────────────────────────
echo "==> Stopping old ea-sys-$ACTIVE..."
$COMPOSE stop "ea-sys-$ACTIVE"
phase_done "Stop old slot"

# ── Restart worker container with the new image ───────────────────────────────
# The worker doesn't participate in blue/green (no traffic to fail over).
# We restart it AFTER the web swap so:
#   - nginx is already pointing at the new web slot
#   - a brief gap in the worker is safe (job state in Postgres survives;
#     advisory locks are session-scoped so the dying process releases
#     them automatically at connection close)
#
# `up -d` is idempotent — if the worker is already running with an older
# image, compose recreates the container against the new image. If the
# worker has never been started before (first deploy with worker support),
# it boots cleanly.
echo "==> (Re)starting ea-sys-worker..."
$COMPOSE up -d ea-sys-worker

# Quick health check — give it 30s to boot (Prisma client load + node-cron
# bootstrap + health server up) then poll /health from inside the container.
echo "==> Waiting for worker /health..."
WORKER_ATTEMPTS=0
until docker exec ea-sys-worker curl -sf http://localhost:3099/health > /dev/null 2>&1; do
  WORKER_ATTEMPTS=$((WORKER_ATTEMPTS + 1))
  if [ "$WORKER_ATTEMPTS" -ge 30 ]; then
    # Soft failure — don't roll back the web deploy because the worker
    # tier is independent. Log it loudly and continue; the operator can
    # follow up with `docker logs ea-sys-worker`. Phase 3 dual-write means
    # the legacy /api/cron/* routes will still drain queues while we
    # debug.
    echo "⚠ Worker /health did not respond within ${WORKER_ATTEMPTS}s."
    echo "  Web deploy continues; investigate with:"
    echo "    docker logs ea-sys-worker --since 2m"
    break
  fi
  sleep 1
done
if [ "$WORKER_ATTEMPTS" -lt 30 ]; then
  echo "✓ Worker /health responding (took ${WORKER_ATTEMPTS}s)"
  phase_done "Start ea-sys-worker"
fi

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
