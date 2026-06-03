#!/usr/bin/env bash
#
# scripts/dr-pg-dump.sh
#
# Twice-daily Postgres logical backup → Singapore DR bucket. Closes the
# database-side DR gap on top of the existing uploads + .env crons.
#
# Cron (Mumbai box, ubuntu user):
#   0 11,23 * * * /home/ubuntu/ea-sys/scripts/dr-pg-dump.sh \
#     >> /home/ubuntu/cron-dr-db-backup.log 2>&1
#
# Design notes — see infra/dr/POSTGRES_BACKUP_PLAN.md for the full plan.
#
# Why DIRECT_URL not DATABASE_URL: pg_dump issues session-level commands
# (LOCK TABLE, SET LOCAL ...) that PgBouncer's transaction-pooling mode
# does NOT support. DATABASE_URL routes through the pooler; DIRECT_URL
# is the direct 5432 connection.
#
# Why -Fc: custom-format dump is 5-10x smaller than plain SQL, supports
# selective restore via `pg_restore -t TABLE`, and `pg_restore -l` lets
# you peek inside without applying.
#
# Why --no-owner --no-acl: avoids ownership/grant errors when restoring
# to a different cluster (which is the whole point of having the dump).
#
# Failure handling — every error path:
#   1. writes a structured JSON log line to stdout (→ cron-dr-db-backup.log)
#   2. fires an SES alert email so silent failure can't hide
#   3. cleans /tmp so we don't accumulate half-written dumps
#   4. exits non-zero so the cron line surfaces the failure in mailx if
#      it's ever wired up later.

set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────
ENV_FILE="${ENV_FILE:-/home/ubuntu/ea-sys/.env}"
DR_BUCKET="${DR_BUCKET:-ea-sys-dr-singapore}"
DR_REGION="${DR_REGION:-ap-southeast-1}"
PG_VERSION="${PG_VERSION:-15}"  # Match Supabase server major version; verify per checklist §6.1
ALERT_EMAIL_FROM="${ALERT_EMAIL_FROM:-alerts@meetingmindsexperts.com}"
ALERT_EMAIL_TO="${ALERT_EMAIL_TO:-krishna@meetingmindsdubai.com}"
SES_REGION="${SES_REGION:-ap-south-1}"
TMP_DIR="${TMP_DIR:-/tmp}"

# ── Derived ──────────────────────────────────────────────────────────────
TS_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DATE_PREFIX=$(date -u +%Y/%m)
FILENAME=$(date -u +%d-%H)-mumbai.dump
LOCAL_DUMP="${TMP_DIR}/${FILENAME}"
S3_KEY="db/${DATE_PREFIX}/${FILENAME}"
S3_URI="s3://${DR_BUCKET}/${S3_KEY}"
START_EPOCH=$(date -u +%s)

# ── Helpers ──────────────────────────────────────────────────────────────
log() {
  # Structured JSON line; grep + jq-friendly. Quotes inside ${1} are
  # not escaped because we control all log strings — no user data here.
  printf '{"ts":"%s","msg":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

send_failure_email() {
  local exit_code="$1"
  local last_cmd="$2"
  # Single-line body keeps SES shorthand syntax happy. Recipient SSHs
  # into the Mumbai box for the full picture; we just need to flag that
  # something went wrong + when + which command died.
  local subject="DR pg_dump FAILED on Mumbai (${TS_UTC})"
  local body
  body="Exit ${exit_code} at ${TS_UTC}. Failed command: ${last_cmd}. See /home/ubuntu/cron-dr-db-backup.log on the Mumbai box for full output."

  # `|| true` so a SES outage doesn't mask the original error — we still
  # exit with the real exit_code from the trap caller.
  aws ses send-email \
    --region "${SES_REGION}" \
    --from "${ALERT_EMAIL_FROM}" \
    --destination "ToAddresses=${ALERT_EMAIL_TO}" \
    --message "Subject={Data=${subject}},Body={Text={Data=${body}}}" \
    >/dev/null 2>&1 \
    || log "dr-pg-dump:ses-alert-failed-too"
}

# ── Failure trap ─────────────────────────────────────────────────────────
on_error() {
  local exit_code=$?
  local last_cmd="${BASH_COMMAND:-unknown}"
  log "dr-pg-dump:FAILED exit=${exit_code} cmd=\"${last_cmd}\""
  send_failure_email "${exit_code}" "${last_cmd}"
  rm -f "${LOCAL_DUMP}" 2>/dev/null || true
  exit "${exit_code}"
}
trap on_error ERR

# ── Ensure pg_dump is installed ─────────────────────────────────────────
# Idempotent — apt is a no-op if the package is already there. First-run
# install adds ~30s; subsequent runs skip in milliseconds.
if ! command -v pg_dump >/dev/null 2>&1; then
  log "dr-pg-dump:installing postgresql-client-${PG_VERSION}"
  sudo apt-get update -qq
  sudo apt-get install -y -qq "postgresql-client-${PG_VERSION}"
fi

# ── Parse DIRECT_URL from .env ──────────────────────────────────────────
# We do NOT `source` the .env — would run any code in there as shell.
# grep + cut is safer for the one variable we actually need.
if [[ ! -r "${ENV_FILE}" ]]; then
  log "dr-pg-dump:env-not-readable path=${ENV_FILE}"
  exit 1
fi

DIRECT_URL=$(grep -E '^DIRECT_URL=' "${ENV_FILE}" | head -1 | cut -d= -f2- | sed 's/^["'\'']//;s/["'\'']$//')

if [[ -z "${DIRECT_URL}" ]]; then
  log "dr-pg-dump:DIRECT_URL-missing-in-env"
  exit 1
fi

# ── Run the dump ─────────────────────────────────────────────────────────
log "dr-pg-dump:start ts=${TS_UTC} target=${S3_URI}"

# `--no-password` so pg_dump errors instead of hanging on a TTY prompt
# if the connection string somehow has no password (would only happen
# under serious misconfiguration but we'd rather fail fast).
pg_dump \
  "${DIRECT_URL}" \
  --format=custom \
  --no-owner \
  --no-acl \
  --no-password \
  --file="${LOCAL_DUMP}"

DUMP_BYTES=$(stat -c %s "${LOCAL_DUMP}")
log "dr-pg-dump:dump-complete size_bytes=${DUMP_BYTES}"

# Sanity: an "empty" dump is almost always a misconfiguration. A real
# EA-SYS dump is multi-MB even on a quiet day. Tiny files are usually
# pg_dump giving us an empty file because of a connection or version
# error that didn't surface as a non-zero exit.
if (( DUMP_BYTES < 100000 )); then
  log "dr-pg-dump:dump-suspiciously-small bytes=${DUMP_BYTES}"
  exit 2
fi

# ── Upload to Singapore ──────────────────────────────────────────────────
aws s3 cp "${LOCAL_DUMP}" "${S3_URI}" --region "${DR_REGION}"

# ── Clean up + final log ────────────────────────────────────────────────
rm -f "${LOCAL_DUMP}"
END_EPOCH=$(date -u +%s)
DURATION_S=$((END_EPOCH - START_EPOCH))
log "dr-pg-dump:ok duration_s=${DURATION_S} size_bytes=${DUMP_BYTES} s3_key=${S3_KEY}"
