#!/usr/bin/env bash
# Hermetic-build guard: no fonts fetched from the internet at build time.
#
# WHY THIS EXISTS
# ---------------
# `next/font/google` downloads .woff2 files from fonts.gstatic.com DURING
# `next build`. That makes every production image build depend on Google's CDN
# being available AND internally consistent at that instant.
#
# On 2026-08-11 it was not. Google rotated the Fraunces v38 file set; some of
# their edge nodes kept serving cached CSS pointing at files gstatic had
# already removed, and the deploy died on a 404 that Next reports as the
# thoroughly unhelpful:
#
#   Module not found: Can't resolve '@vercel/turbopack-next/internal/font/google/font'
#
# Two things made it worth a gate rather than a shrug:
#   * the GATING build job passed in the same run, because it is a separate
#     cold build minutes earlier against a mutable third party. A green gate
#     never protected the image build, and never can.
#   * the font that blocked the deploy is on /api-docs, a public reference
#     page. The least critical surface in the product could not be built, so
#     nothing could be shipped.
#
# The fonts are now vendored in src/app/fonts/ and loaded through
# `next/font/local` (see src/app/fonts.ts). This stops that regressing the next
# time someone reaches for a Google font, which is otherwise invisible: it
# builds fine every day until the day Google rotates a file.
#
# GENERAL RULE: anything the build downloads is a dependency of your ability to
# deploy. Vendor it, or accept that a third party can block your hotfix.

set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

hits=$(grep -rn "next/font/google" src/ 2>/dev/null | grep -v "^src/app/fonts.ts:" || true)
if [ -n "$hits" ]; then
  echo "✗ next/font/google downloads fonts at build time:"
  printf '%s\n' "$hits" | sed 's/^/    /'
  fail=1
fi

# A stylesheet <link> to Google Fonts is a runtime dependency rather than a
# build one, so it cannot break the deploy, but it leaks every visitor's IP to
# Google and is never what we want on public pages.
runtime=$(grep -rn "fonts.googleapis.com\|fonts.gstatic.com" src/ 2>/dev/null \
  | grep -v "^src/app/fonts.ts:" | grep -v "scripts/" || true)
if [ -n "$runtime" ]; then
  echo "✗ Google Fonts referenced at runtime:"
  printf '%s\n' "$runtime" | sed 's/^/    /'
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  cat <<'EOF'

──────────────────────────────────────────────────────────────────────────────
Add the .woff2 to src/app/fonts/ and export it from src/app/fonts.ts using
next/font/local. That file documents how to fetch the right file (Google
serves .woff2 only to a browser User-Agent, and you want the @font-face block
whose unicode-range begins U+0000-00FF).

See scripts/check-hermetic-build.sh for what this prevents.
──────────────────────────────────────────────────────────────────────────────
EOF
  exit 1
fi

echo "✓ hermetic build guard: no build-time or runtime font fetches"
