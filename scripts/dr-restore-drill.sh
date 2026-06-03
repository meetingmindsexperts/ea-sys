#!/usr/bin/env bash
#
# scripts/dr-restore-drill.sh
#
# Quarterly restore drill — proves the dumps in s3://ea-sys-dr-singapore/
# db/ actually restore cleanly. Untested backups aren't backups.
#
# Cadence: 15th of every quarter (Jan/Apr/Jul/Oct). Manual run, no cron.
# Automating this catches zero additional problems and adds CI surface.
#
# What it does:
#   1. Spins up a throwaway Postgres 15 in Docker (ea-sys-dr-drill)
#   2. Pulls the latest dump from the DR bucket
#   3. pg_restore --jobs=4 into the scratch DB
#   4. Row counts on critical tables (Event, Registration, IssuedCertificate,
#      Payment, EmailLog, Speaker, Abstract, CertificateTemplate, AuditLog)
#   5. Tears down the container
#   6. Reports pass/fail with the dump key + row counts
#
# Run anywhere with docker + aws CLI + pg_restore + psql. Local Mac with
# Docker Desktop works; the Mumbai box itself works too. No DB connection
# strings or secrets needed — the dump is self-contained.

set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────
DR_BUCKET="${DR_BUCKET:-ea-sys-dr-singapore}"
DR_REGION="${DR_REGION:-ap-southeast-1}"
CONTAINER="${CONTAINER:-ea-sys-dr-drill}"
PG_PASS="${PG_PASS:-drillpass}"
PG_PORT="${PG_PORT:-55432}"  # non-standard port so it can't clash with a local Postgres
PG_IMAGE="${PG_IMAGE:-postgres:17}"  # Match the dumping pg_dump version (Supabase = PG 17)
WORK_DIR="${WORK_DIR:-/tmp}"
DRILL_DUMP="${WORK_DIR}/dr-drill-restore.dump"

# Tables we expect to find data in. If any return 0 rows, the drill
# isn't a definite failure (a fresh test event may genuinely have no
# Payments), but it's worth flagging.
CRITICAL_TABLES=(
  "Event"
  "Registration"
  "IssuedCertificate"
  "Payment"
  "EmailLog"
  "Speaker"
  "Abstract"
  "CertificateTemplate"
  "AuditLog"
)

# ── Helpers ──────────────────────────────────────────────────────────────
log() {
  printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"
}

cleanup() {
  log "tearing down scratch container ${CONTAINER}"
  docker stop "${CONTAINER}" >/dev/null 2>&1 || true
  rm -f "${DRILL_DUMP}" 2>/dev/null || true
}
trap cleanup EXIT

# ── Preflight ────────────────────────────────────────────────────────────
for cmd in docker aws pg_restore psql; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    log "MISSING: ${cmd} — install before running the drill"
    exit 1
  fi
done

if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  log "stale ${CONTAINER} found; removing"
  docker rm -f "${CONTAINER}" >/dev/null
fi

# ── 1. Spin up scratch Postgres ─────────────────────────────────────────
log "starting scratch ${PG_IMAGE} on port ${PG_PORT}"
docker run --rm -d \
  --name "${CONTAINER}" \
  -e POSTGRES_PASSWORD="${PG_PASS}" \
  -p "${PG_PORT}:5432" \
  "${PG_IMAGE}" >/dev/null

# Wait for ready — docker run -d returns before Postgres listens.
log "waiting for Postgres to accept connections"
for i in $(seq 1 30); do
  if PGPASSWORD="${PG_PASS}" psql -h localhost -p "${PG_PORT}" -U postgres -d postgres -c '\q' >/dev/null 2>&1; then
    break
  fi
  if (( i == 30 )); then
    log "FAILED — Postgres did not become ready within 30s"
    exit 1
  fi
  sleep 1
done

# Drop the auto-created `public` schema so the dump's own
# `CREATE SCHEMA public` doesn't collide. pg_dump --schema=public
# includes the schema definition itself (it's the boundary of what
# we're dumping); fresh postgres:17 ships with `public` already
# present; pg_restore --exit-on-error then dies on the very first
# statement. Dropping it here keeps the dump portable AND the drill
# strict-mode (we still bail on any real errors during restore).
log "dropping pre-existing public schema in scratch DB"
PGPASSWORD="${PG_PASS}" psql \
  -h localhost -p "${PG_PORT}" -U postgres -d postgres \
  -c 'DROP SCHEMA public CASCADE;' >/dev/null

# ── 2. Find the latest dump in the bucket ───────────────────────────────
log "locating latest dump in s3://${DR_BUCKET}/db/"
LATEST_KEY=$(aws s3 ls "s3://${DR_BUCKET}/db/" --recursive --region "${DR_REGION}" \
  | sort -k1,2 \
  | tail -1 \
  | awk '{print $4}')

if [[ -z "${LATEST_KEY}" ]]; then
  log "FAILED — no dumps found in s3://${DR_BUCKET}/db/. Has the cron run yet?"
  exit 1
fi

log "latest dump: ${LATEST_KEY}"

# ── 3. Pull it down ─────────────────────────────────────────────────────
log "downloading dump to ${DRILL_DUMP}"
aws s3 cp "s3://${DR_BUCKET}/${LATEST_KEY}" "${DRILL_DUMP}" --region "${DR_REGION}" >/dev/null
DUMP_BYTES=$(stat -c %s "${DRILL_DUMP}" 2>/dev/null || stat -f %z "${DRILL_DUMP}")
log "dump size: ${DUMP_BYTES} bytes"

# ── 4. Restore ──────────────────────────────────────────────────────────
RESTORE_START=$(date -u +%s)
log "restoring into scratch DB (jobs=4)"

# --exit-on-error so any row-level issue surfaces immediately rather
# than racking up warnings. --no-owner/--no-acl matches how the dump
# was taken.
if ! PGPASSWORD="${PG_PASS}" pg_restore \
  -h localhost -p "${PG_PORT}" -U postgres -d postgres \
  --no-owner --no-acl --jobs=4 --exit-on-error \
  "${DRILL_DUMP}" 2>&1 | tail -20; then
  log "FAILED — pg_restore exited non-zero. Drill failed."
  exit 1
fi

RESTORE_END=$(date -u +%s)
RESTORE_S=$((RESTORE_END - RESTORE_START))
log "restore complete in ${RESTORE_S}s"

# ── 5. Smoke: row counts on critical tables ─────────────────────────────
log ""
log "row counts on critical tables:"
log "──────────────────────────────"
FAILED_TABLES=()
for table in "${CRITICAL_TABLES[@]}"; do
  count=$(PGPASSWORD="${PG_PASS}" psql \
    -h localhost -p "${PG_PORT}" -U postgres -d postgres \
    -tAc "SELECT COUNT(*) FROM \"${table}\";" 2>/dev/null || echo "ERR")
  printf '  %-25s %s\n' "${table}" "${count}"
  if [[ "${count}" == "ERR" ]]; then
    FAILED_TABLES+=("${table}")
  fi
done
log "──────────────────────────────"

if (( ${#FAILED_TABLES[@]} > 0 )); then
  log "FAILED — could not read these tables: ${FAILED_TABLES[*]}"
  exit 1
fi

# ── 6. Report ───────────────────────────────────────────────────────────
log ""
log "✓ DR RESTORE DRILL PASSED"
log "  Dump:        ${LATEST_KEY}"
log "  Dump size:   ${DUMP_BYTES} bytes"
log "  Restore:     ${RESTORE_S}s"
log "  Tables:      ${#CRITICAL_TABLES[@]} verified"
log ""
log "Next drill: 15th of next quarter (Jan/Apr/Jul/Oct)."
