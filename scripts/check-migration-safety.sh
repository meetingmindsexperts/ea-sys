#!/usr/bin/env bash
# Blue-green migration safety guard.
#
# WHY THIS EXISTS
# ---------------
# scripts/deploy.sh runs `prisma migrate deploy` BEFORE it starts the new slot
# and switches nginx. So between migrate-time and the nginx swap, the OLD code
# is serving live production traffic against the NEW schema.
#
# That makes a whole class of SQL actively dangerous here, even though it is
# perfectly normal SQL elsewhere:
#
#   DROP COLUMN      → old code still SELECTs it            → live 500s
#   RENAME COLUMN    → same, plus the new name doesn't exist yet on old code
#   SET NOT NULL     → old code INSERTs a null              → live write failures
#   ALTER COLUMN TYPE→ old code sends/reads the old type    → live errors
#   DROP TABLE       → obvious
#
# And critically: `docs/ROLLBACK.md`'s code rollback re-runs `migrate deploy`.
# It CANNOT undo a schema change. A destructive migration is a one-way door on
# a live production database.
#
# The safe pattern is expand/contract: ship the additive half now (add the new
# column, dual-write), and only contract (drop the old one) in a LATER deploy,
# once no running code references it.
#
# HOW TO ACKNOWLEDGE
# ------------------
# If you have genuinely thought it through and the destructive migration is safe
# (e.g. the column has no readers left, or the table is provably empty in prod),
# add the migration's directory name to prisma/destructive-migrations-ack.txt
# with a one-line reason. That file shows up in review, which is the whole point:
# this guard does not forbid the operation, it forbids doing it by accident.
#
# We deliberately do NOT ask you to annotate the migration.sql itself — Prisma
# stores a checksum of every applied migration in `_prisma_migrations` and
# `migrate deploy` rejects a file that changed after it was applied. Applied
# migrations are immutable. Never edit one.
#
# Usage: bash scripts/check-migration-safety.sh
# Exit:  0 = clean, 1 = unacknowledged destructive migration found

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/prisma/migrations"
ACK_FILE="$REPO_ROOT/prisma/destructive-migrations-ack.txt"

# Statements that break the old slot while it is still serving traffic.
# Deliberately NOT included: DROP CONSTRAINT (Prisma emits it constantly for FK
# churn and it rarely breaks reads) and DROP INDEX (same). A guard that cries
# wolf is a guard people learn to skip.
DESTRUCTIVE_PATTERN='DROP[[:space:]]+TABLE|DROP[[:space:]]+COLUMN|RENAME[[:space:]]+(COLUMN|TO)|SET[[:space:]]+NOT[[:space:]]+NULL|ALTER[[:space:]]+COLUMN[^;]*[[:space:]]TYPE[[:space:]]|TRUNCATE'

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "✗ No migrations directory at $MIGRATIONS_DIR"
  exit 1
fi

# Acknowledged migration directory names (ignore blank lines + # comments).
acked() {
  local name="$1"
  [ -f "$ACK_FILE" ] || return 1
  grep -vE '^\s*(#|$)' "$ACK_FILE" | awk '{print $1}' | grep -qxF "$name"
}

# Strip SQL comments before matching, so a migration that merely *mentions*
# "DROP COLUMN" in an explanatory header comment isn't flagged. (One of ours
# does exactly that.)
executable_sql() {
  sed -e 's|--.*$||' "$1" | perl -0777 -pe 's{/\*.*?\*/}{}gs'
}

violations=0

for sql in "$MIGRATIONS_DIR"/*/migration.sql; do
  [ -e "$sql" ] || continue
  dir_name="$(basename "$(dirname "$sql")")"

  hits="$(executable_sql "$sql" | grep -inE "$DESTRUCTIVE_PATTERN" || true)"
  [ -n "$hits" ] || continue

  if acked "$dir_name"; then
    continue
  fi

  if [ "$violations" -eq 0 ]; then
    echo ""
    echo "✗ Unacknowledged destructive migration(s) — these break the OLD slot"
    echo "  while it is still serving traffic (deploy.sh migrates before the swap),"
    echo "  and a code rollback cannot undo them."
    echo ""
  fi
  violations=$((violations + 1))

  echo "  $dir_name"
  echo "$hits" | sed 's/^/      /'
  echo ""
done

if [ "$violations" -gt 0 ]; then
  cat <<EOF
  Fix it one of two ways:

  1. PREFERRED — split into expand/contract. Ship the additive half now
     (add the new column, dual-write in code). Drop the old column in a
     LATER deploy, once no running code reads it.

  2. If it is genuinely safe, acknowledge it deliberately by adding a line to
     prisma/destructive-migrations-ack.txt:

         <migration_dir_name>   # why this is safe

     e.g. "no readers left after <commit>", or "table is empty in prod".

  Do NOT edit the migration.sql to silence this — Prisma checksums applied
  migrations and 'migrate deploy' will reject a modified file.

EOF
  exit 1
fi

echo "✓ Migration safety: no unacknowledged destructive SQL"
