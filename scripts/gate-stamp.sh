#!/bin/bash
# Where the gate records that a commit passed, shared by scripts/gate.sh (which
# writes it) and .githooks/pre-push (which reads it). One definition, so the
# two can never look in different places.
#
# The folder is inside the repository's COMMON git directory: never tracked,
# never in a diff, and the same folder from every worktree of this checkout.

gate_stamp_dir() {
  local common
  common=$(git rev-parse --git-common-dir) || return 1
  (cd "$common" && printf '%s/gate\n' "$(pwd)")
}

# gate_stamp_file <full commit sha>
gate_stamp_file() {
  printf '%s/%s.ok\n' "$(gate_stamp_dir)" "$1"
}
