#!/usr/bin/env bash
#
# scripts/db-local-op.test.sh
#
# Exercises the local-database guards against a FAKE docker and a FAKE prisma,
# so every branch is proven without a container and without ever running a real
# destructive command. Run directly (`bash scripts/db-local-op.test.sh`) or via
# the vitest wrapper at __tests__/scripts/db-local-op.test.ts, which is what
# makes CI enforce it.
#
# It composes the REAL guard-db-target.sh and the REAL db-snapshot.sh — only the
# two external binaries are faked. A test that stubbed the scripts out would
# prove the wrapper calls something, not that the gates actually hold.
#
# The cases that matter most are the ones that keep it honest in BOTH
# directions: a data-loss flag must refuse AND the documented override must
# work, because a gate that blocks everything gets deleted by whoever hits it
# at 6pm on a Friday.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OP="$ROOT/scripts/db-local-op.sh"
SNAP="$ROOT/scripts/db-snapshot.sh"
TMP="$(mktemp -d)"
FAKE="$TMP/bin"
mkdir -p "$FAKE"
PASS=0; FAIL=0

# A fake `docker` standing in for a healthy local container. CONTAINER_UP=0
# makes `docker ps` return nothing, which is how a snapshot failure is staged.
cat > "$FAKE/docker" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "ps" ]; then
  [ "${CONTAINER_UP:-1}" = "1" ] && echo "ea-sys-prod-local"
  exit 0
fi
if [ "$1" = "cp" ]; then
  # docker cp container:/tmp/x  /host/path   → materialise a plausible dump
  dst="$3"
  case "$2" in *:*) printf 'PGDMP-fake-dump-bytes' > "$dst" ;; *) : ;; esac
  exit 0
fi
if [ "$1" = "exec" ]; then
  shift 2  # drop "exec" + container
  case "$1" in
    psql) echo "7" ;;   # any count query answers 7
    pg_restore)
      if [ -n "${PG_RESTORE_ERR:-}" ]; then printf '%s\n' "$PG_RESTORE_ERR" >&2; exit 1; fi
      ;;
    *) : ;;             # pg_dump / rm succeed silently
  esac
  exit 0
fi
exit 0
EOF

# A fake `prisma` that records that it ran, and with which arguments.
cat > "$FAKE/prisma" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TMP/prisma-calls"
exit 0
EOF
chmod +x "$FAKE/docker" "$FAKE/prisma"

reset() { rm -rf "$TMP/snaps" "$TMP/prisma-calls"; mkdir -p "$TMP/snaps"; }

# Local-looking URLs are passed explicitly so the suite is hermetic: it must not
# depend on whatever .env happens to hold on this machine.
run() {
  env DOCKER_BIN="$FAKE/docker" PRISMA_BIN="$FAKE/prisma" \
      LOCAL_SNAPSHOT_DIR="$TMP/snaps" RESTORE_ERR_FILE="$TMP/restore.err" \
      DATABASE_URL="postgresql://postgres:postgres@localhost:54322/ea_sys_prod_local" \
      DIRECT_URL="postgresql://postgres:postgres@localhost:54322/ea_sys_prod_local" \
      "$@" 2>&1
}

prisma_ran()  { [ -s "$TMP/prisma-calls" ] && echo yes || echo no; }
prisma_args() { cat "$TMP/prisma-calls" 2>/dev/null | tr -d '\n'; }
# shellcheck disable=SC2012  # fixture names are timestamps, never spaces
snap_count()  { ls -1 "$TMP/snaps"/*.dump 2>/dev/null | wc -l | tr -d ' '; }

check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; PASS=$((PASS+1));
          else echo "  FAIL $1 — expected [$2] got [$3]"; FAIL=$((FAIL+1)); fi }
contains() { if printf '%s' "$3" | grep -q "$2"; then echo "  ok   $1"; PASS=$((PASS+1));
             else echo "  FAIL $1 — [$3] does not contain [$2]"; FAIL=$((FAIL+1)); fi }

echo "== a plain push snapshots first, then runs"
reset; out=$(run DB_LOCAL_OP=push bash "$OP")
check "prisma ran" yes "$(prisma_ran)"
check "one snapshot taken" 1 "$(snap_count)"
contains "snapshot is labelled" "push" "$(ls -1 "$TMP/snaps")"

echo "== a data-loss flag refuses, and runs NOTHING"
reset; out=$(run DB_LOCAL_OP=push bash "$OP" --accept-data-loss)
check "prisma did NOT run" no "$(prisma_ran)"
contains "says why" "REFUSING" "$out"
contains "names the override" "LOCAL_DATA_LOSS_OK=1" "$out"

echo "== --force-reset refuses too"
reset; out=$(run DB_LOCAL_OP=push bash "$OP" --force-reset)
check "prisma did NOT run" no "$(prisma_ran)"

echo "== the documented override works (a gate that blocks everything gets deleted)"
reset; out=$(run LOCAL_DATA_LOSS_OK=1 DB_LOCAL_OP=push bash "$OP" --accept-data-loss)
check "prisma ran" yes "$(prisma_ran)"
check "snapshot still taken" 1 "$(snap_count)"

echo "== a failed snapshot BLOCKS the operation (fail closed)"
reset; out=$(run CONTAINER_UP=0 DB_LOCAL_OP=push bash "$OP")
check "prisma did NOT run" no "$(prisma_ran)"
check "no snapshot on disk" 0 "$(snap_count)"
contains "explains the block" "not be undoable" "$out"

echo "== SKIP_LOCAL_SNAPSHOT=1 proceeds without one, loudly"
reset; out=$(run SKIP_LOCAL_SNAPSHOT=1 DB_LOCAL_OP=push bash "$OP")
check "prisma ran" yes "$(prisma_ran)"
check "no snapshot taken" 0 "$(snap_count)"
contains "warns" "no undo point" "$out"

echo "== migrate reset is refused by default, and points somewhere useful"
reset; out=$(run DB_LOCAL_OP=reset bash "$OP")
check "prisma did NOT run" no "$(prisma_ran)"
contains "points at db:refresh" "db:refresh" "$out"
contains "points at db:restore" "db:restore" "$out"

echo "== ALLOW_MIGRATE_RESET=1 overrides it"
reset; out=$(run ALLOW_MIGRATE_RESET=1 DB_LOCAL_OP=reset bash "$OP")
check "prisma ran" yes "$(prisma_ran)"
contains "as migrate reset" "migrate reset" "$(prisma_args)"

echo "== a production target refuses BEFORE anything is snapshotted"
reset
out=$(env DOCKER_BIN="$FAKE/docker" PRISMA_BIN="$FAKE/prisma" LOCAL_SNAPSHOT_DIR="$TMP/snaps" \
      DATABASE_URL="postgresql://u:p@db.nifaqvgnfwddgsusxapy.supabase.co:5432/postgres" \
      DIRECT_URL="postgresql://u:p@db.nifaqvgnfwddgsusxapy.supabase.co:5432/postgres" \
      DB_LOCAL_OP=push bash "$OP" 2>&1)
check "prisma did NOT run" no "$(prisma_ran)"
check "nothing snapshotted" 0 "$(snap_count)"
contains "names production" "PRODUCTION" "$out"

echo "== arguments reach prisma unchanged"
reset; out=$(run DB_LOCAL_OP=push bash "$OP" --skip-generate)
contains "passes the flag through" "db push --skip-generate" "$(prisma_args)"

echo "== an unknown DB_LOCAL_OP is refused rather than guessed"
reset; out=$(run DB_LOCAL_OP=drop bash "$OP")
check "prisma did NOT run" no "$(prisma_ran)"

echo "== snapshots prune to LOCAL_SNAPSHOT_KEEP, newest kept"
reset
for i in 1 2 3 4; do
  run LOCAL_SNAPSHOT_KEEP=2 bash "$SNAP" --label "n$i" >/dev/null
  sleep 1   # the filename stamp is per-second, so space them to keep order real
done
check "kept exactly 2" 2 "$(snap_count)"
contains "kept the newest" "n4" "$(ls -1 "$TMP/snaps")"

echo "== a label cannot escape the snapshot directory"
reset; run bash "$SNAP" --label '../../escaped' >/dev/null
check "still one file, inside the dir" 1 "$(snap_count)"
# shellcheck disable=SC2012
check "nothing written a level up" 0 "$(ls -1 "$TMP"/*.dump 2>/dev/null | wc -l | tr -d ' ')"

echo "== restore snapshots the current state before replacing it"
reset; run bash "$SNAP" --label original >/dev/null
before=$(snap_count)
out=$(run bash "$ROOT/scripts/db-restore.sh")
check "one more snapshot exists than before" $((before + 1)) "$(snap_count)"
contains "and it is the pre-restore one" "pre-restore" "$(ls -1 "$TMP/snaps")"

echo "== restore refuses when there is nothing to restore"
reset; out=$(run bash "$ROOT/scripts/db-restore.sh")
contains "points at db:refresh" "db:refresh" "$out"

echo "== the expected schema collision is reported as a clean restore"
reset; run bash "$SNAP" --label a >/dev/null
out=$(run PG_RESTORE_ERR='pg_restore: error: could not execute query: ERROR:  schema "public" already exists' \
          bash "$ROOT/scripts/db-restore.sh")
contains "reads as OK" "restore OK (ignored" "$out"

echo "== a real restore error is surfaced, not waved through as benign"
reset; run bash "$SNAP" --label a >/dev/null
out=$(run PG_RESTORE_ERR='pg_restore: error: could not execute query: ERROR:  relation "Event" does not exist' \
          bash "$ROOT/scripts/db-restore.sh")
contains "tells you to read it" "read these" "$out"
contains "shows the error" "relation .Event. does not exist" "$out"

echo "== an unknown argument is refused with a usage line, not guessed"
reset
out=$(run bash "$SNAP" '#'); rc=$?
check "exit 2" 2 "$rc"
contains "shows usage" "usage: npm run db:snapshot" "$out"
check "nothing written" 0 "$(snap_count)"

echo "== --list works on restore too, and restores nothing"
reset; run bash "$SNAP" --label listable >/dev/null
out=$(run bash "$ROOT/scripts/db-restore.sh" --list)
contains "lists the snapshot" "listable" "$out"
check "no pre-restore snapshot taken" 1 "$(snap_count)"

echo "== an unknown option on restore is refused rather than treated as a filename"
reset; out=$(run bash "$ROOT/scripts/db-restore.sh" --newest); rc=$?
check "exit 2" 2 "$rc"
contains "shows usage" "usage: npm run db:restore" "$out"

echo "== the snapshot tools read no database URL at all (structural, not checked)"
for f in "$SNAP" "$ROOT/scripts/db-restore.sh" "$ROOT/scripts/db-restore-into-local.sh"; do
  # Strip comments first: the header explains the rule and would otherwise
  # trip a guard written to enforce it (the check-datetime-local lesson).
  code=$(grep -v '^\s*#' "$f")
  if printf '%s' "$code" | grep -qE 'DATABASE_URL|DIRECT_URL'; then
    echo "  FAIL $(basename "$f") reads a database URL — it must address the container by name"; FAIL=$((FAIL+1))
  else
    echo "  ok   $(basename "$f") addresses the container by name only"; PASS=$((PASS+1))
  fi
done

rm -rf "$TMP"
echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
