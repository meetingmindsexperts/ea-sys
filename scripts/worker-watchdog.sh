#!/usr/bin/env bash
#
# scripts/worker-watchdog.sh
#
# Restart ea-sys-worker when it FREEZES.
#
# Cron (Mumbai box, ubuntu user):
#   */2 * * * * /home/ubuntu/ea-sys/scripts/worker-watchdog.sh \
#     >> /home/ubuntu/cron-worker-watchdog.log 2>&1
#
# ── Why this exists ──────────────────────────────────────────────────────
# A process can stop working two ways, and only one of them self-heals:
#
#   crashes  → the container EXITS → `restart: unless-stopped` restarts it.
#   freezes  → the container keeps RUNNING, doing nothing (event-loop stall,
#              DB pool exhaustion, a wedged fetch). Nothing restarts it.
#
# Docker already detects the second case — docker-compose.prod.yml gives the
# worker a healthcheck (curl :3099/health, every 30s, 3 retries) and Docker
# faithfully flips the label to "unhealthy". It just never ACTS on it: plain
# Compose only records the status; only Swarm restarts on it. So a frozen
# worker sat there indefinitely, silently not sending emails or issuing
# certificates, until a human noticed.
#
# This script is that missing action layer, and deliberately nothing more —
# it does not re-implement health checking. Docker's label is already a
# considered verdict (three consecutive failed probes), which is far better
# evidence than one ping from a cron job.
#
# ── Why `docker restart`, not `docker compose up -d` ─────────────────────
# `compose up` re-resolves the image from EA_SYS_WORKER_IMAGE, which
# scripts/deploy.sh exports and a cron shell does not — so it could silently
# swap the running worker to a different (older `:worker-latest`) build. A
# restart of the EXISTING container keeps the exact image that is deployed,
# which is precisely what the frozen-process case calls for.
#
# Consequently, if the container is GONE entirely this script alerts and
# stops rather than trying to recreate it: recreation is a deploy concern
# (`bash scripts/deploy.sh`) and guessing an image tag is how you quietly
# roll production backwards.
#
# ── Safety properties ────────────────────────────────────────────────────
#   * Three consecutive unhealthy observations (~6 min at */2) before acting,
#     so the few-second gap while a deploy recreates the worker can never
#     trigger a restart.
#   * A restart BUDGET — at most MAX_RESTARTS in RESTART_WINDOW_MIN. A worker
#     that is broken in a way restarting cannot fix (bad env, bad image, a
#     poison job) must not be churned in a loop; past the budget the script
#     escalates to a human and goes quiet.
#   * An escape hatch — `touch .watchdog-disabled` in the app dir stops it
#     dead, so deliberate maintenance is never fought by a robot.
#   * Every restart and every give-up emails the operator. A watchdog that
#     silently papers over a daily freeze is worse than no watchdog: the
#     freezes stop being visible and nobody ever fixes the cause.

set -uo pipefail   # NOT -e: this script must reach its own error handling.

# ── Config (all env-overridable so the state machine is testable) ─────────
APP_DIR="${APP_DIR:-/home/ubuntu/ea-sys}"
CONTAINER="${CONTAINER:-ea-sys-worker}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
STATE_DIR="${STATE_DIR:-${APP_DIR}/.watchdog}"
DISABLE_FILE="${DISABLE_FILE:-${APP_DIR}/.watchdog-disabled}"

# Consecutive unhealthy observations before restarting. At the */2 cron this
# is ~6 minutes of confirmed sickness.
FAIL_THRESHOLD="${FAIL_THRESHOLD:-3}"
# Restart budget — beyond this, stop and escalate.
MAX_RESTARTS="${MAX_RESTARTS:-3}"
RESTART_WINDOW_MIN="${RESTART_WINDOW_MIN:-60}"

ALERT_EMAIL_FROM="${ALERT_EMAIL_FROM:-alerts@meetingmindsexperts.com}"
ALERT_EMAIL_TO="${ALERT_EMAIL_TO:-krishna@meetingmindsdubai.com}"
SES_REGION="${SES_REGION:-ap-south-1}"
SEND_ALERTS="${SEND_ALERTS:-1}"   # 0 in tests

FAIL_FILE="${STATE_DIR}/fail-count"
RESTART_LOG="${STATE_DIR}/restarts"

# ── Helpers ──────────────────────────────────────────────────────────────
log() {
  printf '{"ts":"%s","job":"worker-watchdog","msg":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

alert() {
  # $1 = subject, $2 = body. Never fatal: an alert that cannot send must not
  # stop the watchdog from doing the restart it was about to do.
  [ "$SEND_ALERTS" = "1" ] || { log "alert suppressed (SEND_ALERTS=0): $1"; return 0; }
  aws ses send-email \
    --region "$SES_REGION" \
    --from "$ALERT_EMAIL_FROM" \
    --destination "ToAddresses=${ALERT_EMAIL_TO}" \
    --message "Subject={Data=$1},Body={Text={Data=$2}}" \
    >/dev/null 2>&1 \
    || log "alert-send-failed subject=$1"
}

read_count() { cat "$FAIL_FILE" 2>/dev/null || echo 0; }
write_count() { printf '%s' "$1" > "$FAIL_FILE"; }

# Restarts inside the rolling window, one epoch-seconds timestamp per line.
recent_restarts() {
  local cutoff=$(( $(date -u +%s) - RESTART_WINDOW_MIN * 60 ))
  [ -f "$RESTART_LOG" ] || { echo 0; return; }
  awk -v c="$cutoff" '$1 >= c' "$RESTART_LOG" | wc -l | tr -d ' '
}

prune_restart_log() {
  local cutoff=$(( $(date -u +%s) - RESTART_WINDOW_MIN * 60 ))
  [ -f "$RESTART_LOG" ] || return 0
  awk -v c="$cutoff" '$1 >= c' "$RESTART_LOG" > "${RESTART_LOG}.tmp" 2>/dev/null \
    && mv "${RESTART_LOG}.tmp" "$RESTART_LOG"
}

# ── Escape hatch ─────────────────────────────────────────────────────────
if [ -f "$DISABLE_FILE" ]; then
  log "disabled (${DISABLE_FILE} present) — skipping"
  exit 0
fi

mkdir -p "$STATE_DIR" 2>/dev/null || true

# ── Observe ──────────────────────────────────────────────────────────────
# `timeout` guards against a wedged Docker daemon hanging the cron slot.
HEALTH=$(timeout 10 "$DOCKER_BIN" inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null)
INSPECT_RC=$?

if [ "$INSPECT_RC" -ne 0 ]; then
  # Container missing, or the daemon is unresponsive. Deliberately NOT a
  # restart trigger — see the header. Escalate instead.
  COUNT=$(( $(read_count) + 1 ))
  write_count "$COUNT"
  log "inspect-failed rc=${INSPECT_RC} count=${COUNT} (container missing or docker unresponsive)"
  if [ "$COUNT" -eq "$FAIL_THRESHOLD" ]; then
    alert "🔴 EA-SYS worker: container missing" \
"docker inspect ${CONTAINER} failed ${COUNT} times in a row (exit ${INSPECT_RC}).

The container is gone, or the Docker daemon is not responding. The watchdog
deliberately does NOT recreate it — that would guess an image tag and could
roll production backwards.

On the box:
  docker ps -a | grep ${CONTAINER}
  cd ${APP_DIR} && bash scripts/deploy.sh   # recreates from the deployed image"
  fi
  exit 1
fi

case "$HEALTH" in
  healthy|starting)
    # "starting" = inside the container's start_period, i.e. booting, not
    # frozen. Resetting here means a restart is never counted against the
    # very container that just came back up.
    if [ "$(read_count)" != "0" ]; then
      log "recovered health=${HEALTH} — resetting fail count"
    fi
    write_count 0
    exit 0
    ;;
esac

# ── Unhealthy ────────────────────────────────────────────────────────────
COUNT=$(( $(read_count) + 1 ))
write_count "$COUNT"
log "unhealthy health=${HEALTH} count=${COUNT}/${FAIL_THRESHOLD}"

if [ "$COUNT" -lt "$FAIL_THRESHOLD" ]; then
  # Not yet convinced. A deploy's restart gap lives and dies in here.
  exit 0
fi

# ── Budget check ─────────────────────────────────────────────────────────
prune_restart_log
RECENT=$(recent_restarts)
if [ "$RECENT" -ge "$MAX_RESTARTS" ]; then
  log "budget-exhausted restarts=${RECENT}/${MAX_RESTARTS} in ${RESTART_WINDOW_MIN}min — escalating, no restart"
  # Reset the counter so we re-arm rather than alerting every 2 minutes; the
  # next threshold breach (~6 min) re-checks the budget and, once the window
  # rolls, resumes restarting on its own.
  write_count 0
  alert "🔴 EA-SYS worker: restart loop — watchdog giving up" \
"${CONTAINER} has been restarted ${RECENT} times in the last ${RESTART_WINDOW_MIN} minutes
and is unhealthy again. Restarting is not fixing it, so the watchdog has
stopped to avoid churning the database.

This needs a human. Likely causes: a bad deploy, exhausted DB connections, or
a job wedging on every tick.

  docker logs --tail 200 ${CONTAINER}
  curl -s https://events.meetingmindsgroup.com/worker/health
  # /logs → search 'worker:'  (or /admin/infra → Cron / Jobs)

To silence the watchdog while investigating:  touch ${DISABLE_FILE}"
  exit 1
fi

# ── Restart ──────────────────────────────────────────────────────────────
log "restarting container=${CONTAINER} after ${COUNT} unhealthy checks (restart ${RECENT}/${MAX_RESTARTS} this window)"
if timeout 60 "$DOCKER_BIN" restart "$CONTAINER" >/dev/null 2>&1; then
  date -u +%s >> "$RESTART_LOG"
  write_count 0
  log "restart-ok container=${CONTAINER}"
  alert "🟠 EA-SYS worker was frozen — watchdog restarted it" \
"${CONTAINER} reported unhealthy for ${COUNT} consecutive checks and has been
restarted automatically. Background jobs (scheduled emails, certificates,
webinar sync) should resume within a minute.

Nothing was lost — job state lives in Postgres, and every job re-reads what is
due rather than replaying missed ticks. Anything owed is simply sent late.

Worth a look at WHY it froze — a watchdog that quietly restarts a daily freeze
is how a real problem becomes invisible:
  docker logs --tail 200 ${CONTAINER}
  /logs → search 'worker:'

Restarts in the last ${RESTART_WINDOW_MIN} min: $(( RECENT + 1 ))/${MAX_RESTARTS}"
  exit 0
fi

log "restart-failed container=${CONTAINER}"
write_count 0
alert "🔴 EA-SYS worker: restart FAILED" \
"${CONTAINER} was unhealthy and 'docker restart' itself failed. The Docker
daemon may be wedged or the box may be out of resources.

  ssh/ssm to the box, then:
  docker ps -a
  systemctl status docker
  df -h && free -h"
exit 1
