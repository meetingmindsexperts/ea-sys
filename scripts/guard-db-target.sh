#!/usr/bin/env bash
#
# INC-002 preflight (2026-07-30). Refuse a DESTRUCTIVE Prisma command (db push,
# migrate reset) when the target database resolves to PRODUCTION. Wired in front
# of the db:push / db:reset npm scripts. This is defence-in-depth on top of the
# real fix (prod creds are no longer in the .env files Prisma auto-reads) and the
# runtime guard in src/lib/db.ts — it catches the `npm run …` path specifically.
#
# NOTE: a *direct* `npx prisma db push --force-reset` bypasses this script; the
# primary protection there is that .env / .env.local no longer contain prod creds
# (so Prisma defaults to local). Rotating the prod password is the ultimate belt.
#
# Override (deliberate, you almost never should): ALLOW_PROD_DB=1 npm run db:push
set -euo pipefail

PROD_MARKER="nifaqvgnfwddgsusxapy"  # master prod Supabase project ref

if [ "${ALLOW_PROD_DB:-}" = "1" ]; then
  echo "⚠  ALLOW_PROD_DB=1 — skipping the production-DB guard. Be sure."
  exit 0
fi

# Effective URL for each key: a shell env var wins over the .env file (Prisma
# resolves it the same way), so check both so `DIRECT_URL=<prod> npm run db:push`
# is caught too.
for key in DATABASE_URL DIRECT_URL; do
  val="${!key:-}"
  if [ -z "$val" ] && [ -f .env ]; then
    val=$(grep -E "^${key}=" .env 2>/dev/null | head -1)
  fi
  if printf '%s' "$val" | grep -q "$PROD_MARKER"; then
    echo "✋ REFUSING: ${key} points at PRODUCTION (Supabase project ${PROD_MARKER})."
    echo "   This is a destructive Prisma command and would put prod at risk (see INC-002)."
    echo "   Point at your local dev DB, or set ALLOW_PROD_DB=1 to override on purpose."
    exit 1
  fi
done

echo "✓ DB target is not production — proceeding."
