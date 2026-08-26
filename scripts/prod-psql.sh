#!/usr/bin/env bash
#
# Deliberate, READ-ONLY psql into PRODUCTION. This is the ONLY sanctioned way to
# reach prod from a dev machine now that .env / .env.local point at the local dev
# DB (INC-002). Prod creds live only in .env.prod (gitignored) and are read here
# explicitly — never auto-loaded by the app or Prisma.
#
# The session is opened read-only, so a stray UPDATE/DELETE/DROP errors instead
# of running. It is a guardrail, not a vault — someone can still turn it off on
# purpose. Don't.
#
# HOW, AND WHY NOT THE OBVIOUS WAY. This used PGOPTIONS, which does not work
# here and silently did nothing from July 30 to Aug 26 2026: `DIRECT_URL` points
# at `pooler.supabase.com`, and Supavisor does NOT forward libpq startup options
# to the backend. Every "READ-ONLY session" printed by this script was in fact
# read-write. Found by running a migration's UPDATE through it expecting a
# refusal and getting `UPDATE 1`.
#
# The lesson is bigger than the mechanism: a guard that announces itself and
# does nothing is WORSE than no guard, because you take risks on the strength of
# it. So the fix is two parts, and the second is the important one —
#
#   1. Set it with SQL, via a psqlrc that runs inside the session. The pooler
#      forwards queries even when it swallows startup parameters.
#   2. ASSERT it took effect, and REFUSE to open the session otherwise. Same
#      shape as src/lib/tenant/rls-assert.ts, which will not let the app boot if
#      row-level security is not actually active. Verify the guard, do not
#      assume it.
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

# psql runs PSQLRC before -c / -f / the interactive prompt, so this lands in the
# session ahead of anything the caller asked for.
RCFILE=$(mktemp)
trap 'rm -f "$RCFILE"' EXIT
# QUIET around the statement so its "SET" command tag does not prepend a line to
# every `-Atc` result — a caller parsing output would otherwise read the tag.
printf '\\set QUIET 1\nSET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;\n\\unset QUIET\n' > "$RCFILE"

# Prove it before trusting it.
#
# This is a SECOND connection, so strictly it proves the MECHANISM works against
# this pooler right now, not that the session opened below is read-only. Both run
# the same psqlrc against the same endpoint, so a divergence would mean the
# pooler treats two connections differently — far-fetched, and stated here
# rather than left as an unexamined assumption.
PROBE_ERR=$(mktemp)
# `|| true` is load-bearing under `set -euo pipefail`: without it a psql that
# exits non-zero fails the pipeline and kills the script HERE, before the branch
# below can print why — so the error-reporting path would be unreachable in
# exactly the case it exists for. Caught by prod-psql.test.sh, not by reading.
STATE=$(PSQLRC="$RCFILE" psql "$URL" -At -c 'SHOW transaction_read_only' 2>"$PROBE_ERR" | tail -1 || true)
if [ "$STATE" != "on" ]; then
  # Show what actually went wrong. Swallowing this reported an auth failure or an
  # unreachable host as "could not make this read-only", which sends you to fix
  # the guard when the guard was fine — a misleading diagnosis on the one script
  # whose failure mode already cost us once.
  if [ -s "$PROBE_ERR" ]; then
    echo "✋ Could not reach production:"
    sed 's/^/   /' "$PROBE_ERR"
    rm -f "$PROBE_ERR"
    exit 1
  fi
  rm -f "$PROBE_ERR"
  echo "✋ REFUSING: could not make this a read-only session (transaction_read_only=${STATE:-unknown})."
  echo "   Opening it anyway would print 'READ-ONLY' over a session that can write to"
  echo "   production, which is how a syntax check became an UPDATE on 2026-08-26."
  echo "   Fix the guard, or use the Supabase SQL editor for a one-off read."
  exit 1
fi
rm -f "$PROBE_ERR"

echo "→ Connecting to PRODUCTION (READ-ONLY session, verified). Writes will error."
PSQLRC="$RCFILE" psql "$URL" "$@"
