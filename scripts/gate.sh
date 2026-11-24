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
# `.githooks/pre-push` notes a push to main whose tip has no such record (until
# Nov 24, 2026 it refused one).
#
# HOW IT RUNS (Nov 24, 2026). Two lanes side by side, then the browser suite:
#   route types -> type check -> build   |   unit tests -> lint -> guards
# One after another the same steps took about 4 min 20 s. The type check and
# the build share a lane on purpose: the build rewrites .next/types, which the
# type check reads, so the two must never overlap. `GATE_SERIAL=1 npm run gate`
# runs the lanes one after the other (a machine short of memory).
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
# Only this script decides whether its build skips Next's type check. A value
# inherited from the caller would also reach the browser suite's server, which
# rebuilds when it finds no build (review of 9811bed4c).
unset GATE_TYPES_ALREADY_CHECKED

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

# A lane is a subshell with a tool running under it: stopping the subshell alone
# leaves the tool running in a folder that is about to be removed.
kill_tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child"; done
  kill "$1" 2>/dev/null
}

# Each lane writes its own file, so two tools never interleave in the log.
# Folded into the one log when the lanes end, and when the gate is killed: the
# output up to the kill is what explains it.
merge_lane_logs() {
  local part
  for part in "$LOG.build-lane" "$LOG.checks-lane"; do
    if [ -f "$part" ]; then cat "$part" >>"$LOG"; rm -f "$part"; fi
  done
}

LANES=""
FAILS=""
cleanup() {
  local pid
  # Stopped first, then killed from the leaves up (review of 9811bed4c). A lane
  # left running sees its tool die, prints a false FAIL and starts its next
  # step while the tree is being walked: on Ctrl-C a `next build` outlived the
  # gate and its worktree every time.
  for pid in $LANES; do kill -STOP "$pid" 2>/dev/null; done
  for pid in $LANES; do kill_tree "$pid"; kill -CONT "$pid" 2>/dev/null; done
  merge_lane_logs
  if [ -n "$FAILS" ]; then rm -f "$FAILS"; fi
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
# killed gate or another e2e run can leave one there: say so now, not minutes in.
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

# A failed step is a line in a file, not a variable: a lane is a subshell, and
# a variable set in one never reaches this shell.
FAILS="$DIR/$SHA.failed"
: > "$FAILS"
STEP_LOG="$LOG"
step() {
  local name=$1 began
  shift
  # $$ is the gate itself, also inside a lane. A gate killed outright (kill -9)
  # runs no cleanup: its lanes stop here, not at the end of every step left.
  kill -0 $$ 2>/dev/null || exit 1
  began=$(date +%s)
  printf '\n===== %s =====\n' "$name" >>"$STEP_LOG"
  if "$@" >>"$STEP_LOG" 2>&1; then
    printf 'PASS  %-36s %4ss\n' "$name" $(( $(date +%s) - began ))
    return 0
  fi
  printf 'FAIL  %-36s %4ss\n' "$name" $(( $(date +%s) - began ))
  printf '[%s]\n' "$name" >>"$FAILS"
  return 1
}

HEAP=--max-old-space-size=6144

step "prisma generate" npx prisma generate

# The route types the build's own TypeScript pass checks (a handler with the
# wrong arguments, a page whose params are not a Promise). Written first, so the
# type check below reads them with the rest of the repo. No file, no pass: the
# build may skip its own check only because this one covered the same ground.
route_types() {
  npx next typegen || return 1
  if [ -s .next/types/validator.ts ]; then return 0; fi
  echo "gate: next typegen wrote no .next/types/validator.ts, so the route types were not checked"
  return 1
}

# LANE 1. In this order and never overlapping: the build rewrites .next/types
# while the type check would be reading it. The build skips Next's TypeScript
# pass (GATE_TYPES_ALREADY_CHECKED, read by next.config.ts) only when both steps
# before it passed in this run; otherwise it type checks for itself, as CI's does.
lane_types_and_build() {
  local checked=1
  STEP_LOG="$LOG.build-lane"
  step "route types" route_types || checked=0
  step "type check" env NODE_OPTIONS=$HEAP npm run type-check || checked=0
  step "build" env NODE_OPTIONS=$HEAP GATE_TYPES_ALREADY_CHECKED=$checked npx next build
  return 0
}

# LANE 2. Nothing here depends on .next, so it is safe beside the build: lint
# ignores the folder, the guards read tracked sources, and the unit tests start
# first, while lane 1 is still type checking (their path plugin walks the tree
# once at startup, .next included, and reads only tsconfig files there).
lane_checks() {
  local guard
  STEP_LOG="$LOG.checks-lane"
  # A committed `.only` runs one test and skips the rest: CI refuses it, so the gate does.
  step "unit tests" npm test -- --allowOnly=false
  step "lint" npm run lint
  # Every guard on disk, found by name: a new scripts/check-* is gated the day it lands.
  for guard in scripts/check-*.sh; do step "guard $(basename "$guard" .sh)" bash "$guard"; done
  for guard in scripts/check-*.mjs; do step "guard $(basename "$guard" .mjs)" node "$guard"; done
  return 0
}

# Each lane is waited for BY PID and must end with status 0 (review of
# 9811bed4c). A lane only records the steps it reaches: one killed half way, or
# ended by a shell error, left no line for the steps it never ran, and a bare
# `wait` called that green. The same hole deploy.yml's type check had until Nov 10.
if [ "${GATE_SERIAL:-}" = "1" ]; then
  # The checks first: the unit tests then start without a build on disk, as they always have.
  lane_checks
  lane_types_and_build
else
  lane_types_and_build &
  LANES="$!"
  lane_checks &
  LANES="$LANES $!"
  for pid in $LANES; do
    wait "$pid" || printf '[a lane stopped before its last step]\n' >>"$FAILS"
  done
fi
LANES=""
STEP_LOG="$LOG"
merge_lane_logs

# The browser suite, which includes the route smoke test (e2e/route-smoke.spec.ts):
# every GET route asked on a real database as every role, none may answer 500.
# Alone and last: it serves the build just made, on port 3199.
step "browser suite + route smoke" npx playwright test --forbid-only

ELAPSED=$(( $(date +%s) - STARTED ))
grep -E "Tests +[0-9]+ passed|[0-9]+ passed \(|[0-9]+ failed|[0-9]+ flaky" "$LOG" | tail -4 | sed 's/^/      /'

if [ "$(git -C "$REPO" config core.hooksPath)" != ".githooks" ]; then
  echo "note: the git hooks are not installed in this checkout. Run: npm run hooks:install"
fi

# A record that cannot be read is a failure, never an empty list.
FAILED=$(tr '\n' ' ' < "$FAILS") || FAILED="[the record of failed steps could not be read]"
if [ -n "$FAILED" ]; then
  echo "GATE RED for $SHORT in ${ELAPSED}s: $FAILED"
  echo "log: $LOG"
  exit 1
fi

printf 'commit %s\npassed %s\nseconds %s\n' "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ELAPSED" > "$STAMP"
# Old per-commit logs only. The stamps are a few bytes each and are kept, and so
# are the two records the push hook keeps here (they were swept with the rest).
find "$DIR" -name '*.log' ! -name 'overrides.log' ! -name 'ungated-pushes.log' -mtime +30 -delete 2>/dev/null
echo "GATE GREEN for $SHORT in ${ELAPSED}s"
