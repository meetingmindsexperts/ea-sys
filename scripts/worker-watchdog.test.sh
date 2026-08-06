#!/usr/bin/env bash
#
# scripts/worker-watchdog.test.sh
#
# Exercises the watchdog's state machine against a FAKE docker, so every
# branch is proven without needing a real frozen container. Run directly
# (`bash scripts/worker-watchdog.test.sh`) or via the vitest wrapper at
# __tests__/scripts/worker-watchdog.test.ts, which is what makes CI enforce it.
#
# The cases that matter most are the two that keep it from doing harm:
#   - a deploy blip (unhealthy → healthy) must NEVER restart anything;
#   - the restart budget must cap a loop rather than churn the box.
set -uo pipefail
WD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/worker-watchdog.sh"
ROOT="$(mktemp -d)"
FAKE="$ROOT/fakedocker"
PASS=0; FAIL=0

mkfake() { # $1 = health output, $2 = inspect exit code, $3 = restart exit code
  cat > "$FAKE" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "inspect" ]; then echo "$1"; exit $2; fi
if [ "\$1" = "restart" ]; then echo "restarted" >> "$ROOT/restarts-called"; exit $3; fi
exit 0
EOF
  chmod +x "$FAKE"
}

run() { APP_DIR="$ROOT/app" STATE_DIR="$ROOT/state" DISABLE_FILE="$ROOT/app/.watchdog-disabled" \
        DOCKER_BIN="$FAKE" SEND_ALERTS=0 bash "$WD" 2>&1; }

reset() { rm -rf "$ROOT/state" "$ROOT/restarts-called" "$ROOT/app"; mkdir -p "$ROOT/app"; }

check() { # $1 = label, $2 = expected, $3 = actual
  if [ "$2" = "$3" ]; then echo "  ok   $1"; PASS=$((PASS+1));
  else echo "  FAIL $1 — expected [$2] got [$3]"; FAIL=$((FAIL+1)); fi
}

echo "== healthy: no restart, counter stays 0"
reset; mkfake healthy 0 0
run > /dev/null; run > /dev/null
check "no restart called" "0" "$(cat "$ROOT/restarts-called" 2>/dev/null | wc -l | tr -d ' ')"
check "fail count 0" "0" "$(cat "$ROOT/state/fail-count")"

echo "== unhealthy: restarts on the 3rd strike, not before"
reset; mkfake unhealthy 0 0
run > /dev/null
check "strike 1 no restart" "0" "$(cat "$ROOT/restarts-called" 2>/dev/null | wc -l | tr -d ' ')"
run > /dev/null
check "strike 2 no restart" "0" "$(cat "$ROOT/restarts-called" 2>/dev/null | wc -l | tr -d ' ')"
run > /dev/null
check "strike 3 RESTARTS" "1" "$(cat "$ROOT/restarts-called" 2>/dev/null | wc -l | tr -d ' ')"
check "counter reset after restart" "0" "$(cat "$ROOT/state/fail-count")"

echo "== a deploy blip (unhealthy then healthy) never restarts"
reset; mkfake unhealthy 0 0
run > /dev/null; run > /dev/null      # 2 strikes
mkfake healthy 0 0
run > /dev/null                        # recovered
check "no restart" "0" "$(cat "$ROOT/restarts-called" 2>/dev/null | wc -l | tr -d ' ')"
check "counter reset on recovery" "0" "$(cat "$ROOT/state/fail-count")"
mkfake unhealthy 0 0
run > /dev/null; run > /dev/null
check "re-armed: needs 3 fresh strikes" "0" "$(cat "$ROOT/restarts-called" 2>/dev/null | wc -l | tr -d ' ')"

echo "== 'starting' counts as healthy (container is booting, not frozen)"
reset; mkfake unhealthy 0 0
run > /dev/null; run > /dev/null
mkfake starting 0 0
run > /dev/null
check "counter reset" "0" "$(cat "$ROOT/state/fail-count")"

echo "== restart budget: 4th restart is refused"
reset; mkfake unhealthy 0 0
for _ in $(seq 1 12); do run > /dev/null; done
check "capped at MAX_RESTARTS=3" "3" "$(cat "$ROOT/restarts-called" 2>/dev/null | wc -l | tr -d ' ')"

echo "== container missing: alerts, never tries to recreate"
reset; mkfake "" 1 0
run > /dev/null; run > /dev/null; OUT=$(run)
check "no restart attempted" "0" "$(cat "$ROOT/restarts-called" 2>/dev/null | wc -l | tr -d ' ')"
check "logged inspect-failed" "yes" "$(echo "$OUT" | grep -q inspect-failed && echo yes || echo no)"

echo "== disable file stops it dead"
reset; mkfake unhealthy 0 0
touch "$ROOT/app/.watchdog-disabled"
OUT=$(run; run; run)
check "no restart" "0" "$(cat "$ROOT/restarts-called" 2>/dev/null | wc -l | tr -d ' ')"
check "logged disabled" "yes" "$(echo "$OUT" | grep -q disabled && echo yes || echo no)"

echo "== docker restart failing is reported, not swallowed"
reset; mkfake unhealthy 0 1
run > /dev/null; run > /dev/null; OUT=$(run)
check "logged restart-failed" "yes" "$(echo "$OUT" | grep -q restart-failed && echo yes || echo no)"

echo
echo "PASS=$PASS FAIL=$FAIL"
rm -rf "$ROOT"
[ "$FAIL" -eq 0 ]
