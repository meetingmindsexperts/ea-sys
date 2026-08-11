#!/usr/bin/env bash
# datetime-local round-trip guard.
#
# WHY THIS EXISTS
# ---------------
# An `<input type="datetime-local">` carries NO timezone: the browser reads
# whatever string you hand it as LOCAL wall-clock. So converting an instant for
# display and converting the form value back are NOT symmetric, and the classic
# mistake is to fake the display direction with string slicing:
#
#     input.value = isoInstant.slice(0, 16)              // or .toISOString().slice(0, 16)
#     save(new Date(input.value).toISOString())          // browser parses as LOCAL
#
# That pair is lossy in one direction, so EVERY re-save shifts the stored
# instant by the UTC offset - and it COMPOUNDS. It is invisible on the first
# save (typing a fresh value is correct) and only shows up after someone opens
# the form and presses Save.
#
# This has now been shipped and fixed THREE times in this codebase:
#   * the dinner console          (Survey/RSVP review B2, Jul 2026)
#   * abstract + proposal deadlines (Aug 2026 - reached prod, corrupted 6 live
#     events on a clean 4-hour ladder; one closed submissions 12 hours early)
#   * promo code validity windows  (Aug 2026, found while fixing the above)
#
# Three instances of one defect is the signal for a gate rather than a fourth
# code review. Unit tests cannot catch it: the helpers are correct in
# isolation, the bug is in which helper a form chose to call.
#
# WHAT TO USE INSTEAD
# -------------------
#   * Browser-local form  → toLocalDateTimeInput / fromLocalDateTimeInput
#                           (src/lib/datetime-local.ts)
#   * Event-timezone form → localDateTimeInTz / wallTimeInTzToIso
#                           (src/lib/event-time.ts)
# Both are exact inverses. Never slice.
#
# WHAT IT CHECKS
# --------------
# Any file that renders a `type="datetime-local"` input must not also contain a
# `.slice(0, 16)` on a date-ish expression. The check is deliberately narrow
# (same file, both signals present) so unrelated `slice(0, 16)` calls - token
# truncation in rate-limit keys, for instance - never trip it.
#
# EXEMPTIONS
# ----------
# Add a path to ALLOW only with a comment explaining why the pair is provably
# symmetric there. Removing an entry to make CI pass IS the regression.

set -uo pipefail
cd "$(dirname "$0")/.."

# Files permitted to contain both signals. Currently the settings page, whose
# remaining slice sits inside the SEPARATE hardcoded-Dubai helper used by the
# event Start/End fields (a known, recorded limitation tracked in ROADMAP -
# that pair is self-consistent and does not drift, unlike the pattern above).
ALLOW=(
  "src/app/(dashboard)/events/[eventId]/settings/page.tsx"
)

is_allowed() {
  local f="$1"
  for a in "${ALLOW[@]}"; do
    [ "$f" = "$a" ] && return 0
  done
  return 1
}

violations=0

# Every file that renders a datetime-local input.
while IFS= read -r file; do
  is_allowed "$file" && continue

  # A slice(0, 16) in the same file, ignoring comment lines (the write-ups
  # above quote the bad pattern on purpose).
  hits=$(grep -n "slice(0, *16)" "$file" 2>/dev/null | grep -v "^\s*[0-9]*: *\(//\|\*\|/\*\)" || true)
  [ -z "$hits" ] && continue

  # Only flag when the sliced value looks date-derived; a rate-limit key built
  # from `token.slice(0, 16)` is unrelated and must not fail the build.
  datey=$(printf '%s\n' "$hits" | grep -i "iso\|date\|time\|valid\|deadline\|start\|end\|scheduled" || true)
  [ -z "$datey" ] && continue

  echo "✗ $file renders a datetime-local input AND slices a date string:"
  printf '%s\n' "$datey" | sed 's/^/    /'
  violations=$((violations + 1))
done < <(grep -rl 'type="datetime-local"' src/ 2>/dev/null || true)

if [ "$violations" -gt 0 ]; then
  cat <<'EOF'

──────────────────────────────────────────────────────────────────────────────
A datetime-local input has no timezone. Slicing an ISO string into one puts the
UTC wall-clock in front of a user whose browser reads it as local time, so
saving shifts the stored instant - every single time, compounding.

Use an inverse pair instead:
  browser-local  → toLocalDateTimeInput / fromLocalDateTimeInput  (src/lib/datetime-local.ts)
  event timezone → localDateTimeInTz    / wallTimeInTzToIso       (src/lib/event-time.ts)

This defect has reached production three times. See scripts/check-datetime-local.sh.
──────────────────────────────────────────────────────────────────────────────
EOF
  exit 1
fi

echo "✓ datetime-local round-trip guard: no violations"
