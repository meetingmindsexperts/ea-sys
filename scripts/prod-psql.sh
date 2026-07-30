#!/usr/bin/env bash
#
# Deliberate, READ-ONLY psql into PRODUCTION. This is the ONLY sanctioned way to
# reach prod from a dev machine now that .env / .env.local point at the local dev
# DB (INC-002). Prod creds live only in .env.prod (gitignored) and are read here
# explicitly — never auto-loaded by the app or Prisma.
#
# The session is opened read-only (default_transaction_read_only=on), so a stray
# UPDATE/DELETE/DROP errors instead of running. It is a guardrail, not a vault —
# someone can still `SET default_transaction_read_only=off` on purpose. Don't.
#
# Usage:  npm run prod:psql              (interactive)
#         npm run prod:psql -- -c 'SELECT count(*) FROM "Event"'   (one query)
set -euo pipefail

if [ ! -f .env.prod ]; then
  echo "✋ .env.prod not found — cannot reach prod. (This is expected on most machines.)"
  exit 1
fi

URL=$(grep -E '^DIRECT_URL=' .env.prod | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
if [ -z "$URL" ]; then
  echo "✋ No DIRECT_URL in .env.prod."
  exit 1
fi

echo "→ Connecting to PRODUCTION (READ-ONLY session). Writes will error."
PGOPTIONS='-c default_transaction_read_only=on' psql "$URL" "$@"
