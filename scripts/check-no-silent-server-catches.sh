#!/usr/bin/env bash
# Server-side catch callbacks must preserve operational evidence. Browser media
# playback rejections are intentionally ignored: autoplay policy is expected and
# there is no server-side incident to investigate.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

mapfile -t matches < <(
  rg -n --glob '*.{ts,tsx}' '\.catch\(\(\)\s*=>\s*\{\s*\}\)' src worker \
    | rg -v '^src/components/zoom/live-player\.tsx:' \
    | rg -v '^src/app/e/\[slug\]/session/\[sessionId\]/page\.tsx:' || true
)

if ((${#matches[@]} > 0)); then
  echo "✗ Silent server-side catch callbacks found:"
  printf '  %s\n' "${matches[@]}"
  cat <<'EOF'

Log the failure with the domain logger. If a browser-only no-op is genuinely
expected, add the exact file to this script's intentionally small allow-list.
EOF
  exit 1
fi

echo "✓ Silent server-side catch guard: no unlogged empty catch callbacks"
