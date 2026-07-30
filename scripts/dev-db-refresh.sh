#!/usr/bin/env bash
#
# Refresh the LOCAL dev database (ea_sys_prod_local) from the latest production
# DR pg_dump in the Singapore S3 bucket. This is how you get realistic, prod-like
# data locally WITHOUT ever pointing your app or Prisma at prod (the cause of
# INC-002 — see docs/INCIDENTS.md). Doubles as a DR restore drill.
#
# Everything happens against the LOCAL container on localhost:54322 — it can
# never touch prod. Restore runs inside the postgres:17 container so we don't
# depend on a matching host pg_restore version (the DR dumps are PG17).
#
# Usage:  npm run db:refresh        (or: bash scripts/dev-db-refresh.sh)
# Reqs:   docker running, the ea-sys-prod-local container up
#         (docker compose up -d postgres-prod-local), AWS creds with read on the
#         DR bucket.
set -euo pipefail

CONTAINER="ea-sys-prod-local"
DB="ea_sys_prod_local"
BUCKET="ea-sys-dr-singapore"
REGION="ap-southeast-1"
TMP_DUMP="/tmp/${DB}.dump"

echo "== dev-db-refresh → LOCAL ${DB} (localhost:54322) =="

# 1. Container must be up.
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "✋ ${CONTAINER} is not running. Start it first:"
  echo "     docker compose up -d postgres-prod-local"
  exit 1
fi

# 2. Locate the latest dump (keys sort lexically; the newest is last).
echo "-- locating latest DR dump in s3://${BUCKET}/db/ --"
KEY=$(aws s3 ls "s3://${BUCKET}/db/" --recursive --region "$REGION" | sort | tail -1 | awk '{print $4}')
if [ -z "${KEY:-}" ]; then
  echo "✋ No dump found in s3://${BUCKET}/db/ (check AWS creds / region)."
  exit 1
fi
echo "   latest: ${KEY}"

# 3. Download.
aws s3 cp "s3://${BUCKET}/${KEY}" "$TMP_DUMP" --region "$REGION" >/dev/null
SIZE=$(stat -f%z "$TMP_DUMP" 2>/dev/null || stat -c%s "$TMP_DUMP")
echo "   downloaded ${SIZE} bytes"
if [ "$SIZE" -lt 100000 ]; then
  echo "✋ Dump is suspiciously small (<100KB) — aborting rather than restoring a broken snapshot."
  exit 1
fi

# 4. Reset the public schema + restore inside the container (PG17 tools).
echo "-- resetting public schema + restoring (this drops all LOCAL data) --"
docker cp "$TMP_DUMP" "${CONTAINER}:/tmp/d.dump"
docker exec "$CONTAINER" psql -U postgres -d "$DB" -q \
  -c 'DROP SCHEMA IF EXISTS public CASCADE;' -c 'CREATE SCHEMA public;'
# --no-owner/--no-privileges drops role/ACL noise; one "schema public already
# exists" style warning is expected and harmless, so don't --exit-on-error.
set +e
docker exec "$CONTAINER" pg_restore -U postgres --no-owner --no-privileges -d "$DB" /tmp/d.dump 2>/tmp/dr-restore.err
RC=$?
set -e
if [ "$RC" -eq 0 ]; then
  echo "   restore OK"
else
  echo "   pg_restore exit=${RC} (benign owner/ACL/schema warnings are expected):"
  tail -4 /tmp/dr-restore.err 2>/dev/null || true
fi
docker exec "$CONTAINER" rm -f /tmp/d.dump

# 5. Verify.
echo "-- verify (LOCAL ${DB}) --"
for q in 'SELECT count(*) FROM "Organization"' 'SELECT count(*) FROM "Event"' \
         'SELECT count(*) FROM "Registration"' 'SELECT count(*) FROM "User"' \
         'SELECT count(*) FROM "_prisma_migrations"'; do
  printf '   %-45s = ' "$q"
  docker exec "$CONTAINER" psql -U postgres -d "$DB" -Atc "$q" 2>&1
done

rm -f "$TMP_DUMP"
echo "✓ Local dev DB refreshed from ${KEY}"
