#!/usr/bin/env bash
#
# The guarded path to a destructive Prisma command against the LOCAL dev
# database. Wraps `npm run db:push` and `npm run db:reset`.
#
# Four gates, in this order, and the order is the design:
#
#   1. NOT PRODUCTION (scripts/guard-db-target.sh, INC-002). First, because a
#      prod target must be refused before anything else happens — including the
#      snapshot, which addresses the local container and would be both useless
#      and misleading in that case.
#   2. `migrate reset` is refused. CLAUDE.md forbids it outright: it is the
#      command that wiped production on 2026-07-30. An npm script that runs a
#      forbidden command is worse than no script, because its existence reads
#      as permission.
#   3. Data-loss flags are opt-in (LOCAL_DATA_LOSS_OK=1). A speed bump, not a
#      wall — gate 4 is what actually makes this recoverable.
#   4. Snapshot first, and FAIL CLOSED if it cannot be taken. A seatbelt that
#      silently is not there on the one day you need it is worse than no
#      seatbelt, because you drove differently believing in it.
#
# Env: DB_LOCAL_OP=push|reset (required), LOCAL_DATA_LOSS_OK=1,
#      SKIP_LOCAL_SNAPSHOT=1, ALLOW_MIGRATE_RESET=1, ALLOW_PROD_DB=1, PRISMA_BIN.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRISMA="${PRISMA_BIN:-npx prisma}"
OP="${DB_LOCAL_OP:-}"

case "$OP" in
  push|reset) ;;
  *) echo "db-local-op: set DB_LOCAL_OP=push or DB_LOCAL_OP=reset" >&2; exit 2 ;;
esac

# ── 1. Never against production ──
bash "$ROOT/scripts/guard-db-target.sh"

# ── 2. migrate reset is on the forbidden list ──
if [ "$OP" = "reset" ] && [ "${ALLOW_MIGRATE_RESET:-}" != "1" ]; then
  echo "✋ REFUSING: 'prisma migrate reset' is forbidden in this repo (see CLAUDE.md)."
  echo "   It is the command that wiped production on 2026-07-30 (INC-002), and"
  echo "   locally it buys nothing you cannot get more safely:"
  echo "     • want a clean, prod-shaped database?   npm run db:refresh"
  echo "     • want your own data back?              npm run db:restore"
  echo "     • want the chain replayed from empty?   CI already does that (migration-replay)"
  echo "   ALLOW_MIGRATE_RESET=1 overrides, if you are certain."
  exit 1
fi

# ── 3. Data-loss flags are opt-in ──
for arg in "$@"; do
  case "$arg" in
    --accept-data-loss|--force-reset)
      if [ "${LOCAL_DATA_LOSS_OK:-}" != "1" ]; then
        echo "✋ REFUSING: '${arg}' discards data and was not asked for explicitly."
        echo "   Re-run as:  LOCAL_DATA_LOSS_OK=1 npm run db:${OP} -- ${arg}"
        echo "   A snapshot is taken either way, so this is a pause, not a wall."
        exit 1
      fi
      echo "⚠  ${arg} allowed via LOCAL_DATA_LOSS_OK=1."
      ;;
  esac
done

# ── 4. Snapshot first, fail closed ──
if [ "${SKIP_LOCAL_SNAPSHOT:-}" = "1" ]; then
  echo "⚠  SKIP_LOCAL_SNAPSHOT=1 — no undo point for this ${OP}."
else
  if ! bash "$ROOT/scripts/db-snapshot.sh" --label "$OP"; then
    echo "✋ REFUSING: could not snapshot the local database, so this ${OP} would"
    echo "   not be undoable. Fix the snapshot (is the container up?), or accept"
    echo "   the risk deliberately with SKIP_LOCAL_SNAPSHOT=1."
    exit 1
  fi
fi

# ── run it ──
case "$OP" in
  push)  exec $PRISMA db push "$@" ;;
  reset) exec $PRISMA migrate reset "$@" ;;
esac
