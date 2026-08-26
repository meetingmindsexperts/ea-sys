#!/usr/bin/env bash
#
# scripts/prod-psql.test.sh
#
# Exercises the production read-only guard against a FAKE psql, so no real
# connection is made and no credential is needed. Run directly, or via the
# vitest wrapper at __tests__/scripts/prod-psql.test.ts.
#
# THIS SUITE EXISTS BECAUSE THE GUARD SILENTLY DID NOTHING FOR A MONTH. It set
# read-only with PGOPTIONS, and DIRECT_URL points at a Supavisor pooler, which
# does not forward libpq startup options — so every session that printed
# "READ-ONLY" was read-write. Nothing failed, nothing logged, and it was found
# only by running a write through it expecting a refusal.
#
# The load-bearing case is therefore the SOURCE assertion that PGOPTIONS never
# comes back, plus the refusal path: a guard that cannot prove it is in force
# must decline to open the session rather than announce a protection it does
# not have.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/prod-psql.sh"
TMP="$(mktemp -d)"
BIN="$TMP/bin"; mkdir -p "$BIN" "$TMP/work"
PASS=0; FAIL=0

cat > "$BIN/psql" <<'EOF'
#!/usr/bin/env bash
for a in "$@"; do
  if [ "$a" = "SHOW transaction_read_only" ]; then
    if [ -n "${PROBE_ERR_TEXT:-}" ]; then printf '%s\n' "$PROBE_ERR_TEXT" >&2; exit 2; fi
    echo "${PROBE_STATE:-on}"
    exit 0
  fi
done
printf '%s\n' "$*" >> "$CALLS"
exit 0
EOF
chmod +x "$BIN/psql"

reset() { rm -f "$TMP/calls"; printf 'DIRECT_URL="postgresql://u:p@pooler.example:5432/postgres"\n' > "$TMP/work/.env.prod"; }
run() { (cd "$TMP/work" && env PATH="$BIN:$PATH" CALLS="$TMP/calls" "$@" bash "$SCRIPT" -Atc 'SELECT 1' 2>&1); }
opened() { [ -s "$TMP/calls" ] && echo yes || echo no; }

check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; PASS=$((PASS+1));
          else echo "  FAIL $1 — expected [$2] got [$3]"; FAIL=$((FAIL+1)); fi }
contains() { if printf '%s' "$3" | grep -q "$2"; then echo "  ok   $1"; PASS=$((PASS+1));
             else echo "  FAIL $1 — [$3] does not contain [$2]"; FAIL=$((FAIL+1)); fi }
absent() { if printf '%s' "$3" | grep -q "$2"; then echo "  FAIL $1 — [$3] should not contain [$2]"; FAIL=$((FAIL+1));
           else echo "  ok   $1"; PASS=$((PASS+1)); fi }

echo "== a verified read-only session opens, and passes the caller's arguments through"
reset; out=$(run PROBE_STATE=on)
check "session opened" yes "$(opened)"
contains "passes -Atc through" "SELECT 1" "$(cat "$TMP/calls")"
contains "says it verified" "verified" "$out"

echo "== a session that is NOT read-only is refused, and no session is opened"
reset; out=$(run PROBE_STATE=off)
check "no session opened" no "$(opened)"
contains "refuses" "REFUSING" "$out"
contains "names the state it saw" "transaction_read_only=off" "$out"
absent "does not claim to be read-only" "READ-ONLY session, verified" "$out"

echo "== a connection failure reports the CONNECTION error, not a guard failure"
reset; out=$(run PROBE_ERR_TEXT='psql: error: password authentication failed')
check "no session opened" no "$(opened)"
contains "shows the real error" "password authentication failed" "$out"
# The whole point: reporting this as "could not make it read-only" sends you to
# fix a guard that was working.
absent "does not blame the guard" "REFUSING" "$out"

echo "== no .env.prod means no connection is attempted at all"
reset; rm -f "$TMP/work/.env.prod"; out=$(run PROBE_STATE=on)
check "no session opened" no "$(opened)"
contains "says why" "env.prod not found" "$out"

echo "== the guard is set with SQL, and PGOPTIONS never comes back"
code=$(grep -v '^\s*#' "$SCRIPT")
if printf '%s' "$code" | grep -q 'TRANSACTION READ ONLY'; then
  echo "  ok   sets read-only with SQL"; PASS=$((PASS+1))
else
  echo "  FAIL the read-only SET is gone"; FAIL=$((FAIL+1))
fi
if printf '%s' "$code" | grep -q 'PGOPTIONS'; then
  echo "  FAIL PGOPTIONS is back — Supavisor does not forward it, so the guard is inert"; FAIL=$((FAIL+1))
else
  echo "  ok   does not rely on PGOPTIONS"; PASS=$((PASS+1))
fi
if printf '%s' "$code" | grep -q "SHOW transaction_read_only"; then
  echo "  ok   verifies the guard rather than assuming it"; PASS=$((PASS+1))
else
  echo "  FAIL nothing checks the guard took effect"; FAIL=$((FAIL+1))
fi

rm -rf "$TMP"
echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
