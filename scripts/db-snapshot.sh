#!/usr/bin/env bash
#
# Snapshot the LOCAL dev database, so any destructive local operation is a
# five-second undo instead of a 30-second S3 round trip that also loses whatever
# scratch data you were half-way through creating.
#
# WHY THIS EXISTS. On Aug 25 2026 a
#   npx prisma migrate diff --from-migrations … --shadow-database-url "$DIRECT_URL"
# emptied the entire local prod copy. `--shadow-database-url` names a scratch
# database and Prisma RESETS it — the destructive behaviour is implied by a
# NOUN, not announced by a flag like `--accept-data-loss`. No allow-list of
# "dangerous commands" would have caught it, because the command did not look
# dangerous. A snapshot catches that one and every future one nobody has
# thought of yet, which is the whole argument for a seatbelt over a rule.
#
# IT TALKS TO THE CONTAINER BY NAME, NEVER BY URL. That is the point, not an
# implementation detail: a script that read DATABASE_URL could be aimed at
# production by an environment variable (INC-002's exact shape). This one
# structurally cannot be, so there is no check to write and nothing to get
# wrong. A test pins that the file contains no *_URL read.
#
# Usage:
#   npm run db:snapshot                  # take one
#   npm run db:snapshot -- --label wip   # take one, named
#   npm run db:snapshot -- --list        # what is on hand
#
# Env: LOCAL_SNAPSHOT_DIR (default .local-snapshots), LOCAL_SNAPSHOT_KEEP
#      (default 10), LOCAL_DB_CONTAINER, LOCAL_DB_NAME, DOCKER_BIN.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="${LOCAL_DB_CONTAINER:-ea-sys-prod-local}"
DB="${LOCAL_DB_NAME:-ea_sys_prod_local}"
DIR="${LOCAL_SNAPSHOT_DIR:-$ROOT/.local-snapshots}"
KEEP="${LOCAL_SNAPSHOT_KEEP:-10}"
DOCKER="${DOCKER_BIN:-docker}"

LABEL=""
LIST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="${2:-}"; shift 2 ;;
    --list)  LIST=1; shift ;;
    *)
      # Name what is accepted rather than only what was rejected: the usual way
      # to land here is a typo or a shell comment that zsh did not strip
      # (interactive_comments is off by default), and a bare refusal sends you
      # to the source to find out why.
      echo "db-snapshot: unknown argument: $1" >&2
      echo "usage: npm run db:snapshot [-- --label <name>] [-- --list]" >&2
      exit 2
      ;;
  esac
done

if [ "$LIST" = "1" ]; then
  if ! ls -1 "$DIR"/*.dump >/dev/null 2>&1; then
    echo "No snapshots in ${DIR}."
    exit 0
  fi
  echo "Snapshots in ${DIR} (newest first):"
  # shellcheck disable=SC2045  # names are timestamp+sanitised-label, never spaces
  for f in $(ls -1t "$DIR"/*.dump); do
    sz=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")
    printf '   %-40s %8s bytes\n' "$(basename "$f")" "$sz"
  done
  exit 0
fi

# Sanitise the label rather than quoting it: it becomes part of a filename, and
# a label is a convenience, not a place to accept arbitrary path characters.
if [ -n "$LABEL" ]; then
  LABEL=$(printf '%s' "$LABEL" | tr -c 'A-Za-z0-9._-' '-' | cut -c1-40)
fi

if ! "$DOCKER" ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
  echo "✋ ${CONTAINER} is not running — NO snapshot was taken."
  echo "   Start it:  docker compose up -d postgres-prod-local"
  exit 1
fi

mkdir -p "$DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="${DIR}/${STAMP}${LABEL:+-$LABEL}.dump"

# --schema=public mirrors the DR dumps, so a snapshot restores through the same
# DROP SCHEMA public / pg_restore path scripts/dev-db-refresh.sh already uses.
"$DOCKER" exec "$CONTAINER" pg_dump -U postgres -Fc --schema=public -d "$DB" -f /tmp/snap.dump
"$DOCKER" cp "${CONTAINER}:/tmp/snap.dump" "$OUT"
"$DOCKER" exec "$CONTAINER" rm -f /tmp/snap.dump

SIZE=$(stat -f%z "$OUT" 2>/dev/null || stat -c%s "$OUT")

count() {
  "$DOCKER" exec "$CONTAINER" psql -U postgres -d "$DB" -Atc "SELECT count(*) FROM \"$1\"" 2>/dev/null || echo "?"
}
EVENTS=$(count Event)
REGS=$(count Registration)

echo "✓ snapshot ${OUT#"$ROOT"/}  (${SIZE} bytes · ${EVENTS} events · ${REGS} registrations)"
# Say so out loud rather than refusing. Snapshotting an empty database is
# harmless and blocking it would stop legitimate work on a fresh container —
# but silently banking a worthless restore point is how you find out too late.
if [ "$EVENTS" = "0" ] && [ "$REGS" = "0" ]; then
  echo "  ⚠  that database is empty, so this snapshot restores nothing."
  echo "     If you expected data, run 'npm run db:refresh' before continuing."
fi

# Prune oldest beyond KEEP. Snapshots are ~1MB, so 10 covers a day's work.
if [ "$KEEP" -gt 0 ]; then
  # shellcheck disable=SC2012
  ls -1t "$DIR"/*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old"
    echo "  pruned $(basename "$old")"
  done
fi
