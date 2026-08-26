#!/usr/bin/env bash
#
# Restore the LOCAL dev database from a snapshot taken by scripts/db-snapshot.sh.
# This is the undo for a local wipe: `npm run db:restore` and you are back where
# you were, including the scratch rows a `db:refresh` from S3 would not have.
#
# It SNAPSHOTS BEFORE IT RESTORES. Restoring is itself destructive — it replaces
# whatever is in the database now — so picking the wrong file would otherwise be
# a second, unrecoverable mistake on top of the first. With the pre-restore
# snapshot there is no way to lose data through this tool at all, which is worth
# more than the second or two it costs.
#
# Like its sibling it addresses the container BY NAME and never reads a URL, so
# it cannot be aimed at production.
#
# Usage:
#   npm run db:restore                       # newest snapshot
#   npm run db:restore -- 20260826-141530.dump
#   npm run db:snapshot -- --list            # see what is on hand
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="${LOCAL_DB_CONTAINER:-ea-sys-prod-local}"
DB="${LOCAL_DB_NAME:-ea_sys_prod_local}"
DIR="${LOCAL_SNAPSHOT_DIR:-$ROOT/.local-snapshots}"
DOCKER="${DOCKER_BIN:-docker}"

WANT="${1:-}"

# --list is delegated rather than duplicated: it is the same listing, and this is
# where people reach for it (you list in order to pick what to restore).
case "$WANT" in
  --list) exec bash "$ROOT/scripts/db-snapshot.sh" --list ;;
  --*)
    echo "db-restore: unknown option: $WANT" >&2
    echo "usage: npm run db:restore [-- <snapshot.dump>] [-- --list]" >&2
    exit 2
    ;;
esac

if ! "$DOCKER" ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
  echo "✋ ${CONTAINER} is not running."
  echo "   Start it:  docker compose up -d postgres-prod-local"
  exit 1
fi

if [ -n "$WANT" ]; then
  # Accept a bare filename or a path, but resolve it inside the snapshot dir so
  # a stray argument cannot reach for an arbitrary file on disk.
  SRC="${DIR}/$(basename "$WANT")"
else
  # shellcheck disable=SC2012  # names are timestamp+sanitised-label, never spaces
  SRC=$(ls -1t "$DIR"/*.dump 2>/dev/null | head -1 || true)
fi

if [ -z "${SRC:-}" ] || [ ! -f "$SRC" ]; then
  echo "✋ No snapshot to restore${WANT:+ matching $WANT} in ${DIR}."
  echo "   Take one with 'npm run db:snapshot', or rebuild from the DR dump"
  echo "   with 'npm run db:refresh'."
  exit 1
fi

echo "== db-restore → LOCAL ${DB} (localhost:54322) =="
echo "   from ${SRC#"$ROOT"/}"

# Undo for the undo. If this fails we stop: proceeding would mean the current
# state is unrecoverable, which is the exact situation this script exists to
# prevent. SKIP_LOCAL_SNAPSHOT=1 overrides on purpose.
if [ "${SKIP_LOCAL_SNAPSHOT:-}" = "1" ]; then
  echo "   ⚠  SKIP_LOCAL_SNAPSHOT=1 — the current state will NOT be recoverable."
else
  bash "$ROOT/scripts/db-snapshot.sh" --label pre-restore
fi

echo "-- resetting public schema + restoring (this drops all LOCAL data) --"
"$DOCKER" cp "$SRC" "${CONTAINER}:/tmp/restore.dump"
"$DOCKER" exec "$CONTAINER" psql -U postgres -d "$DB" -q \
  -c 'DROP SCHEMA IF EXISTS public CASCADE;' -c 'CREATE SCHEMA public;'
# Owner/ACL warnings are expected on a --no-owner restore, so don't --exit-on-error.
set +e
"$DOCKER" exec "$CONTAINER" pg_restore -U postgres --no-owner --no-privileges -d "$DB" /tmp/restore.dump 2>/tmp/local-restore.err
RC=$?
set -e
"$DOCKER" exec "$CONTAINER" rm -f /tmp/restore.dump
if [ "$RC" -ne 0 ]; then
  echo "   pg_restore exit=${RC} (benign owner/ACL warnings are expected):"
  tail -4 /tmp/local-restore.err 2>/dev/null || true
fi

count() {
  "$DOCKER" exec "$CONTAINER" psql -U postgres -d "$DB" -Atc "SELECT count(*) FROM \"$1\"" 2>/dev/null || echo "?"
}
echo "✓ restored — ${DB} now has $(count Event) events, $(count Registration) registrations, $(count User) users"
echo "  If the snapshot predates a schema change, run 'npx prisma generate'."
