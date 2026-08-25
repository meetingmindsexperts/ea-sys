#!/usr/bin/env bash
#
# denyReviewer / denyFinance must keep naming the route they refused on.
#
# WHY A GATE AND NOT JUST THE TYPE. `route` is a required field today, so the
# compiler already forces every CALL to pass one. What the compiler cannot stop
# is someone making it optional again to get past a build — which is exactly how
# it drifted to 3-of-226 the first time. This pins the contract itself.
#
# It also pins that the value is a real label. `route: ""` would satisfy the
# type and tell a reader nothing, and a refusal that does not say where is
# close to useless: on Aug 24 2026, tracing one 403 meant grepping a page's
# React hooks to work out which endpoint had refused.
#
# Run from the repo root. Exits non-zero on violation.
set -euo pipefail

GUARDS_FILE="src/lib/auth-guards.ts"
fail=0

say_fail() {
  echo "✋ $1"
  fail=1
}

if [ ! -f "$GUARDS_FILE" ]; then
  echo "✋ $GUARDS_FILE not found — run from the repo root."
  exit 1
fi

# ── 1. The contract itself: neither guard may make `route` optional again ──
#
# Comments are stripped first. An earlier gate in this repo failed on a comment
# that explained its own rule, which is a guard that cannot tell prose from code.
#
# Comments are stripped so prose about the rule cannot satisfy the rule.
#
# This is the SAME strip that scripts/check-tenant-als.sh uses, deliberately:
# it is already proven on the Ubuntu runner. Keep them in step if either
# changes. `perl -0777` with a non-greedy match handles multi-line blocks and
# cannot over-delete.
#
# The first version of this script rolled its own with sed, and it passed on
# macOS and failed the first CI run. It deleted `*`-prefixed lines BEFORE a
# `/\*/,/\*\//d` range, so on GNU sed (which honours `\s`, unlike BSD) it
# removed the closing ` */` — the range's own terminator — and the range then
# ran to end of file, taking both function signatures with it. The gate
# reported the contract had been loosened when nothing had changed.
#
# Lesson worth more than the fix: a line-range delete that can lose its own
# terminator fails OPEN in one direction and CLOSED in the other, and which
# one you get depends on the platform.
code_only() {
  sed -e 's|//.*$||' "$1" | perl -0777 -pe 's{/\*.*?\*/}{}gs'
}

guards_code=$(code_only "$GUARDS_FILE")

if echo "$guards_code" | grep -qE 'route\?:[[:space:]]*string'; then
  say_fail "$GUARDS_FILE declares 'route?: string'. It must stay REQUIRED on
   denyReviewer and denyFinance. Making it optional is how it drifted to 3 of
   226 call sites the first time, and the refusal log is the line you read when
   someone says 'it doesn't work for me'."
fi

for guard in denyReviewer denyFinance; do
  if ! echo "$guards_code" | grep -qE "route:[[:space:]]*string"; then
    say_fail "$guard no longer requires 'route: string'."
  fi
done

# ── 2. No empty or placeholder labels in application code ──
#
# Tests legitimately pass "test"; src must name a real route.
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  say_fail "empty or placeholder route label: $hit"
done < <(
  grep -rn -E 'deny(Reviewer|Finance)\(' src --include="*.ts" \
    | grep -v "$GUARDS_FILE" \
    | grep -E 'route:[[:space:]]*("([[:space:]]*|test|TODO|xxx)")' || true
)

# ── 3. Every call in src actually carries one ──
#
# The compiler catches this, but only for single-line calls it can see; this
# also catches a call re-introduced inside a file that skips typechecking.
missing=0
while IFS= read -r file; do
  [ -z "$file" ] && continue
  # Calls spanning lines put `route:` on a following line, so look at the call
  # plus the next three lines together.
  while IFS= read -r lineno; do
    [ -z "$lineno" ] && continue
    window=$(sed -n "${lineno},$((lineno + 3))p" "$file")
    if ! echo "$window" | grep -q 'route:'; then
      say_fail "no route label: $file:$lineno"
      missing=$((missing + 1))
    fi
  done < <(
    grep -n -E 'deny(Reviewer|Finance)\(' "$file" \
      | grep -vE ':[[:space:]]*(\*|//)' \
      | cut -d: -f1 || true
  )
done < <(grep -rl -E 'deny(Reviewer|Finance)\(' src --include="*.ts" | grep -v "$GUARDS_FILE" || true)

if [ "$fail" -eq 0 ]; then
  total=$(grep -rc -E 'deny(Reviewer|Finance)\(' src --include="*.ts" \
    | grep -v "$GUARDS_FILE" | cut -d: -f2 | paste -sd+ - | bc)
  echo "✓ guard route labels: $total call sites, all named"
fi

exit "$fail"
