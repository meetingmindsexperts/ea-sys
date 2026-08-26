#!/usr/bin/env bash
#
# Restore one pg_dump (custom format) into the LOCAL dev database.
#
# Shared by scripts/db-restore.sh (a local snapshot) and scripts/dev-db-refresh.sh
# (the S3 DR dump). Both do the identical drop-schema / pg_restore / interpret-the
# -exit-code dance, and the moment there were two copies they started needing the
# same fixes — which is the house rule against cross-caller duplication doing its
# job. Callers keep what actually differs: where the dump came from, and what they
# verify afterwards.
#
# Addresses the container BY NAME and never reads a database URL, so it cannot be
# aimed at production.
#
# Usage: bash scripts/db-restore-into-local.sh <dump-file-on-host>
set -euo pipefail

CONTAINER="${LOCAL_DB_CONTAINER:-ea-sys-prod-local}"
DB="${LOCAL_DB_NAME:-ea_sys_prod_local}"
DOCKER="${DOCKER_BIN:-docker}"
ERRFILE="${RESTORE_ERR_FILE:-/tmp/local-restore.err}"
SRC="${1:-}"

[ -n "$SRC" ] && [ -f "$SRC" ] || { echo "db-restore-into-local: need a dump file" >&2; exit 2; }

"$DOCKER" cp "$SRC" "${CONTAINER}:/tmp/restore.dump"

# client_min_messages silences the ~100 "drop cascades to …" NOTICEs. They are
# accurate and completely uninformative, and they bury the lines that matter —
# in a recovery tool, output you have to scroll past is output you stop reading.
"$DOCKER" exec "$CONTAINER" psql -U postgres -d "$DB" -q \
  -c 'SET client_min_messages TO WARNING;' \
  -c 'DROP SCHEMA IF EXISTS public CASCADE;' \
  -c 'CREATE SCHEMA public;'

set +e
"$DOCKER" exec "$CONTAINER" pg_restore -U postgres --no-owner --no-privileges -d "$DB" /tmp/restore.dump 2>"$ERRFILE"
RC=$?
set -e
"$DOCKER" exec "$CONTAINER" rm -f /tmp/restore.dump

if [ "$RC" -eq 0 ]; then
  echo "   restore OK"
  exit 0
fi

# A dump taken with --schema=public carries its own CREATE SCHEMA public, and we
# just made one, so exactly that collision is expected. Saying "exit=1, benign
# warnings are expected" for every restore trains you to ignore the line that
# will one day be a real failure, so count instead of hand-waving.
ERRS=$(grep -c '^pg_restore: error' "$ERRFILE" 2>/dev/null || true)
BENIGN=$(grep -c 'schema "public" already exists' "$ERRFILE" 2>/dev/null || true)
if [ "${ERRS:-0}" -gt 0 ] && [ "${ERRS:-0}" -eq "${BENIGN:-0}" ]; then
  echo "   restore OK (ignored the expected 'schema public already exists')"
  exit 0
fi

echo "   ⚠  pg_restore exit=${RC} with ${ERRS:-?} error(s) — read these:"
grep '^pg_restore: error' "$ERRFILE" 2>/dev/null | head -5 | sed 's/^/      /'
echo "      full stderr: ${ERRFILE}"
exit 0   # the caller verifies row counts; a partial restore is still worth reporting on
