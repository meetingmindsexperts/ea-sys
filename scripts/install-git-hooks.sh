#!/bin/bash
# Point this checkout at the versioned hooks in .githooks/ (pre-commit, pre-push).
# Once per clone: git keeps `core.hooksPath` in the local config, which is never
# pushed. Safe to run again.
set -eu
cd "$(git rev-parse --show-toplevel)"
chmod +x .githooks/pre-commit .githooks/pre-push scripts/gate.sh
git config core.hooksPath .githooks
echo "git hooks installed: core.hooksPath = $(git config core.hooksPath)"
echo "  pre-commit  lint and the guard scripts, on what is staged (about 10 seconds)"
echo "  pre-push    refuses a push to main while a deploy is running; notes a tip that has not passed: npm run gate"
