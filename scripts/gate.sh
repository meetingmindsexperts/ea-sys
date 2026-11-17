#!/bin/bash
# THE gate (Nov 17, 2026): everything that must pass before a commit is pushed,
# in one command, on exactly the commit named.
#
#   npm run gate            # the commit at HEAD
#   npm run gate -- <sha>   # any other commit
#
# WHY IT EXISTS. AGENTS.md rule 5 listed four commands; CI runs about twenty
# (fifteen guard scripts among them), and the script that ran them all lived in
# one agent's temp folder. Five of eighty pushes went red on GitHub in a month.
# `__tests__/scripts/gate-parity.test.ts` fails when CI gains a step this file
# does not run or explicitly leaves to CI.
#
# WHY A CLEAN WORKTREE. Several sessions work in this checkout at once. A gate
# run on the working tree passes or fails on files that are not in the commit.
# This checks out the commit alone, beside the checkout, and gates that.
#
# ON GREEN it records the commit in <git dir>/gate/ (scripts/gate-stamp.sh).
# `.githooks/pre-push` refuses a push to main whose tip has no such record.
#
# LEFT TO CI, where they already block the deploy: the tenancy and integration
# database suites and the migration replay (they need containers agents do not
# start), and the lockfile sync check (it rewrites package-lock.json to compare).
set -u

REPO=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "gate: not inside a git repository"; exit 2; }
cd "$REPO" || exit 2
# shellcheck source=scripts/gate-stamp.sh
. "$REPO/scripts/gate-stamp.sh"

SHA=$(git rev-parse --verify --quiet "${1:-HEAD}^{commit}") || { echo "gate: not a commit: ${1:-HEAD}"; exit 2; }
SHORT=$(git rev-parse --short=8 "$SHA")
DIR=$(gate_stamp_dir) || exit 2
mkdir -p "$DIR"
LOG="$DIR/$SHA.log"
STAMP=$(gate_stamp_file "$SHA")
WORKDIR="${GATE_WORKDIR:-${TMPDIR:-/tmp}}"
WORKDIR="${WORKDIR%/}"
WT="$WORKDIR/ea-sys-gate-$SHORT"
STARTED=$(date +%s)

# One gate at a time: every run uses port 3199 and rebuilds the e2e database.
LOCK="$DIR/lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  HOLDER=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$HOLDER" ] && kill -0 "$HOLDER" 2>/dev/null; then
    echo "gate: another gate is running (pid $HOLDER, commit $(cat "$LOCK/sha" 2>/dev/null))."
    echo "      They share port 3199 and the e2e database, so only one runs at a time. Try again when it ends."
    exit 3
  fi
  rm -rf "$LOCK"
  mkdir "$LOCK" || { echo "gate: cannot take the lock at $LOCK"; exit 3; }
fi
echo $$ > "$LOCK/pid"
echo "$SHORT" > "$LOCK/sha"

cleanup() {
  rm -rf "$LOCK"
  cd "$REPO" && git worktree remove --force "$WT" >/dev/null 2>&1
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# The lock is held, so any other gate folder here was left by a run that was
# killed. They hold copies of .env and node_modules: gone before this one starts.
for stale in "$WORKDIR"/ea-sys-gate-*; do
  [ -d "$stale" ] || continue
  git worktree remove --force "$stale" >/dev/null 2>&1 || rm -rf "$stale"
done
git worktree prune >/dev/null 2>&1

# The browser suite starts its own server on 3199 and refuses a port in use. A
# killed gate or another e2e run can leave one there: say so now, not after four minutes.
PORT_HOLDER=$(lsof -nP -iTCP:3199 -sTCP:LISTEN -t 2>/dev/null | head -1)
if [ -n "$PORT_HOLDER" ]; then
  echo "gate: port 3199 is in use by pid $PORT_HOLDER (a killed gate, or a browser suite run). Stop it, then run the gate again."
  exit 3
fi

: > "$LOG"
rm -f "$STAMP"
echo "gate: $SHORT $(git log -1 --pretty=%s "$SHA" | cut -c1-90)"

git worktree add --detach "$WT" "$SHA" >>"$LOG" 2>&1 || { echo "gate: could not check out $SHORT at $WT (see $LOG)"; exit 2; }

# Dependencies: a copy of this checkout's when the lockfile is the commit's
# (a clone on macOS, so it costs seconds), a clean install when it is not.
if [ -d node_modules ] && git diff --quiet "$SHA" -- package.json package-lock.json; then
  cp -cR node_modules "$WT/" 2>/dev/null || cp -R node_modules "$WT/"
else
  echo "gate: package.json or the lockfile differs from this checkout's: installing in the worktree"
  (cd "$WT" && npm ci >>"$LOG" 2>&1) || { echo "gate: npm ci failed (see $LOG)"; exit 2; }
fi
for f in .env .env.local; do
  if [ -f "$f" ]; then cp "$f" "$WT/"; fi
done
cd "$WT" || exit 2

FAILED=""
step() {
  local name=$1 began
  shift
  began=$(date +%s)
  printf '\n===== %s =====\n' "$name" >>"$LOG"
  if "$@" >>"$LOG" 2>&1; then
    printf 'PASS  %-36s %4ss\n' "$name" $(( $(date +%s) - began ))
  else
    printf 'FAIL  %-36s %4ss\n' "$name" $(( $(date +%s) - began ))
    FAILED="$FAILED [$name]"
  fi
}

HEAP=--max-old-space-size=6144

step "prisma generate" npx prisma generate
step "type check" env NODE_OPTIONS=$HEAP npm run type-check
step "lint" npm run lint
# Every guard on disk, found by name: a new scripts/check-* is gated the day it lands.
for guard in scripts/check-*.sh; do step "guard $(basename "$guard" .sh)" bash "$guard"; done
for guard in scripts/check-*.mjs; do step "guard $(basename "$guard" .mjs)" node "$guard"; done
# A committed `.only` runs one test and skips the rest: CI refuses it, so the gate does.
step "unit tests" npm test -- --allowOnly=false
step "build" env NODE_OPTIONS=$HEAP npx next build
# The browser suite, which includes the route smoke test (e2e/route-smoke.spec.ts):
# every GET route asked on a real database as every role, none may answer 500.
step "browser suite + route smoke" npx playwright test --forbid-only

ELAPSED=$(( $(date +%s) - STARTED ))
grep -E "Tests +[0-9]+ passed|[0-9]+ passed \(|[0-9]+ failed|[0-9]+ flaky" "$LOG" | tail -4 | sed 's/^/      /'

if [ "$(git -C "$REPO" config core.hooksPath)" != ".githooks" ]; then
  echo "note: the git hooks are not installed in this checkout. Run: npm run hooks:install"
fi

if [ -n "$FAILED" ]; then
  echo "GATE RED for $SHORT in ${ELAPSED}s:$FAILED"
  echo "log: $LOG"
  exit 1
fi

printf 'commit %s\npassed %s\nseconds %s\n' "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ELAPSED" > "$STAMP"
# Old logs only; the stamps are a few bytes each and are kept.
find "$DIR" -name '*.log' -mtime +30 -delete 2>/dev/null
echo "GATE GREEN for $SHORT in ${ELAPSED}s"
