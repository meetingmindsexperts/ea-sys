#!/usr/bin/env bash
#
# scripts/docker-prune.sh
#
# Weekly Docker disk reclaim. Removes stale BUILD CACHE and DANGLING (untagged)
# image layers so the root disk doesn't slowly fill.
#
# ── Why this is needed (plain English) ───────────────────────────────────────
# Docker keeps a "build cache": every step of building an image is saved so the
# NEXT build is faster. The prod box rebuilds the app image on EVERY deploy
# (`docker compose build` in scripts/deploy.sh), so that cache — plus the old
# image layers each new build replaces — piles up over time. It's invisible in a
# normal `df` ("where did my disk go?") but `docker system df` shows it. On this
# box it reached ~38 GB reclaimable at 74% full. None of it is live data; it's
# just rebuildable scratch.
#
# The durable fix is to stop building on the box at all (build in CI → push to
# ECR → box only `docker pull`s — see the "CI → ECR" item in docs/ROADMAP.md and
# INC-001 in docs/INCIDENTS.md). Until then, this weekly prune keeps it in check.
#
# ── Safe by design — it does NOT remove ──────────────────────────────────────
#   • running containers or their images (the live blue + green app slots)
#   • TAGGED images  → your last-3 rollback image tags stay intact
#   • named volumes  (the local volume, the uploads bind-mount, etc.)
# It removes ONLY: build cache (`builder prune`) + untagged/dangling image layers
# (`image prune` WITHOUT -a). It deliberately never runs `system prune -a` (that
# would delete the rollback image tags) and never `--volumes`.
#
# ── Install (Mumbai box, ubuntu user) ────────────────────────────────────────
#   Fridays 03:00 UTC (07:00 GST — low traffic):
#   0 3 * * 5 /home/ubuntu/ea-sys/scripts/docker-prune.sh >> /home/ubuntu/cron-docker-prune.log 2>&1
#
# Logs structured JSON lines (grep-friendly, same style as dr-pg-dump.sh).

set -euo pipefail

log() {
  printf '{"ts":"%s","msg":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

avail_gb() {
  # Portable "GB available on /" as an integer.
  df -BG / | awk 'NR==2 { gsub(/G/, "", $4); print $4 }'
}

BEFORE=$(avail_gb)
log "docker-prune:start avail_gb_before=${BEFORE}"

# Build cache — usually the biggest reclaim. -a = all cache not in use by an
# active build; -f = no interactive prompt.
if docker builder prune -af >/dev/null 2>&1; then
  log "docker-prune:builder-cache-pruned"
else
  log "docker-prune:builder-prune-FAILED"
fi

# Dangling (untagged) image layers ONLY — no -a, so tagged rollback images stay.
if docker image prune -f >/dev/null 2>&1; then
  log "docker-prune:dangling-images-pruned"
else
  log "docker-prune:image-prune-FAILED"
fi

AFTER=$(avail_gb)
log "docker-prune:done avail_gb_after=${AFTER} reclaimed_gb=$((AFTER - BEFORE))"
