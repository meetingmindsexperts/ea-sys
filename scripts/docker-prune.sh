#!/usr/bin/env bash
#
# scripts/docker-prune.sh
#
# Weekly Docker disk reclaim. Removes stale BUILD CACHE, DANGLING (untagged)
# image layers, AND old pulled ECR image tags so the root disk doesn't fill.
#
# ── Why this is needed (plain English) ───────────────────────────────────────
# Since the CI→ECR cutover (2026-07-01) the box no longer BUILDS the app image —
# it `docker compose pull`s a fresh `ea-sys:<sha>` web + `ea-sys:worker-<sha>`
# worker image from ECR on every deploy. That fixed the build-cache blowup, but
# introduces a new, slower leak: each deploy pulls TWO new tagged images
# (~290 MB web + ~487 MB worker ≈ 780 MB) and the PREVIOUS `:<sha>` images stay
# **tagged** — so `docker image prune -f` (dangling-only) never reaps them. Left
# alone the box grows ~780 MB/deploy forever. This script now also trims those,
# keeping the newest few for rollback. (The build cache prune is retained because
# deploy.sh can still fall back to an on-box build if an ECR pull fails.)
#
# ── Safe by design — it does NOT remove ──────────────────────────────────────
#   • running containers or their images (the live blue + green app slots +
#     worker — `docker rmi` refuses in-use images; we skip on failure)
#   • the newest KEEP_IMAGES web + worker `:<sha>` tags (rollback) + the moving
#     `:latest` / `:worker-latest` pointers
#   • named volumes  (the local volume, the uploads bind-mount, etc.)
# It removes ONLY: build cache (`builder prune`), untagged/dangling layers
# (`image prune` WITHOUT -a), and OLD `ea-sys:<sha>` repo tags beyond the keep
# window. It never runs `system prune -a` and never `--volumes`.
#
# ── Install (Mumbai box, ubuntu user) ────────────────────────────────────────
#   Fridays 03:00 UTC (07:00 GST — low traffic):
#   0 3 * * 5 /home/ubuntu/ea-sys/scripts/docker-prune.sh >> /home/ubuntu/cron-docker-prune.log 2>&1
#
# Logs structured JSON lines (grep-friendly, same style as dr-pg-dump.sh).

set -euo pipefail

# Full ECR repo the box pulls from, and how many recent :<sha> tags to keep per
# class (web + worker) for rollback. KEEP_IMAGES=3 → 3 deploys of rollback each.
ECR_REPO="${ECR_REPO:-803726282629.dkr.ecr.ap-south-1.amazonaws.com/ea-sys}"
KEEP_IMAGES="${KEEP_IMAGES:-3}"

log() {
  printf '{"ts":"%s","msg":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

# Trim old ECR repo image tags, keeping the newest KEEP_IMAGES of one class.
#   $1 = class: "web" (tags = <sha> / latest) or "worker" (tags = worker-<sha> /
#        worker-latest). `docker images` lists newest-first, so we keep the first
#        KEEP_IMAGES matching :<sha> tags and `docker rmi` the rest. The moving
#        `latest`/`worker-latest` pointers are never removed, and rmi refuses
#        (→ we skip) any image still in use by the running blue/green/worker.
prune_old_repo_images() {
  local kind="$1" kept=0 tag id
  while read -r tag id; do
    [ -z "$tag" ] && continue
    [ "$tag" = "<none>" ] && continue
    case "$tag" in
      latest|worker-latest) continue ;;                       # never touch pointers
      worker-*) [ "$kind" = "worker" ] || continue ;;
      *)        [ "$kind" = "web" ]    || continue ;;
    esac
    if [ "$kept" -lt "$KEEP_IMAGES" ]; then
      kept=$((kept + 1))
      continue
    fi
    if docker rmi "$ECR_REPO:$tag" >/dev/null 2>&1; then
      log "docker-prune:removed-old-image kind=$kind tag=$tag"
    else
      log "docker-prune:skip-in-use-or-failed kind=$kind tag=$tag"
    fi
  done < <(docker images "$ECR_REPO" --format '{{.Tag}} {{.ID}}' 2>/dev/null || true)
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

# Old pulled ECR image tags beyond the keep window (the CI→ECR-era leak). Runs
# after the dangling prune so any tag we untag here can be reclaimed same pass.
prune_old_repo_images web
prune_old_repo_images worker
log "docker-prune:old-repo-images-trimmed keep=${KEEP_IMAGES}"

AFTER=$(avail_gb)
log "docker-prune:done avail_gb_after=${AFTER} reclaimed_gb=$((AFTER - BEFORE))"
