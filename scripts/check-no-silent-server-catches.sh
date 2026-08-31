#!/usr/bin/env bash
#
# A server-side catch callback must leave evidence behind.
#
# `.catch(() => {})` is the shape that hides an incident. The call fails, the
# request returns 200, nothing reaches /logs, and the only symptom is data that
# quietly stopped appearing. Every one of these in src/ and worker/ was a
# best-effort cleanup — expired verification tokens, spent OAuth codes — so a
# database incident could silently accumulate live public tokens with no trace.
#
# The rule this pins is AGENTS.md's "every failure path logs". Fixing the nine
# sites is a commit; keeping them fixed is this.
#
# PORTABILITY IS DELIBERATE. Plain `grep` with a POSIX character class, no `rg`
# and no `mapfile`: macOS ships bash 3.2 (no mapfile) and BSD grep (no \s), and
# every other gate in this directory runs on a developer's Mac. A CI check you
# can only reproduce by pushing is one you debug by pushing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Allow-list. Each entry states its OWN reason, because a single blanket
# justification stops being true the moment the second entry is added — the
# first draft of this file called both of these "browser media playback", and
# one of them is a fetch beacon.
#
#   live-player.tsx                     video.play() rejects under autoplay
#                                       policy. Expected, recoverable by a user
#                                       gesture, no server-side incident.
#   e/[slug]/session/[sessionId]/page   a keepalive fetch reporting a Zoom join
#                                       failure, fired as the page may be
#                                       unloading. If the report itself cannot
#                                       be sent there is no second channel and
#                                       no console anybody reads.
ALLOWED='^src/components/zoom/live-player\.tsx:|^src/app/e/\[slug\]/session/\[sessionId\]/page\.tsx:'

matches=$(
  grep -rn --include='*.ts' --include='*.tsx' -E \
    '\.catch\(\(\)[[:space:]]*=>[[:space:]]*\{[[:space:]]*\}\)' src worker 2>/dev/null \
    | grep -Ev "$ALLOWED" || true
)

if [ -n "$matches" ]; then
  echo "✗ Silent server-side catch callbacks found:"
  echo "$matches" | sed 's/^/  /'
  cat <<'MSG'

Log the failure with the domain logger, including enough context to act on it
(ids, not secrets). If a browser-only no-op is genuinely expected, add the file
to this script's allow-list WITH its own reason.
MSG
  exit 1
fi

echo "✓ Silent server-side catch guard: no unlogged empty catch callbacks"
