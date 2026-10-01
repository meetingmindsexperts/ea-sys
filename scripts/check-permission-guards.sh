#!/usr/bin/env bash
# Keep the route files already moved onto requirePermission() moved.
#
# WHY THIS EXISTS
# ---------------
# Custom roles Phase 2 (docs/CUSTOM_ROLES_PLAN.md §6) moves the routes, one
# domain at a time, from role checks (`denyReviewer`, the `*_ALLOW` lists,
# inline `role === "..."` comparisons) onto `requirePermission()`, whose
# permission and event scope come from one grant. A swept file that later
# gains a role check again has two authorities that can disagree, and the one
# a role editor cannot see wins. This gate fails CI on that, naming the file.
#
# A file joins SWEPT only after its domain's route status matrix
# (__tests__/api/route-matrix/) was recorded on the unswept code and matched
# byte for byte after the sweep. The list only grows.
#
# NOT FLAGGED, on purpose: `buildEventAccessWhere` (the external roles,
# REVIEWER / SUBMITTER / REGISTRANT, keep their row-linked branches; plan §1)
# and `requireOrgId` (the separate org-null refusal stays; plan G5).
#
# Usage: bash scripts/check-permission-guards.sh
# Exit:  0 = clean, 1 = a role check in a swept file

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SWEPT=(
  # events core (Oct 1, 2026)
  "src/app/api/events/route.ts"
  "src/app/api/events/[eventId]/route.ts"
  # registration types, tiers and promo codes (Oct 1, 2026)
  "src/app/api/events/[eventId]/tickets/route.ts"
  "src/app/api/events/[eventId]/tickets/[ticketId]/route.ts"
  "src/app/api/events/[eventId]/tickets/[ticketId]/tiers/route.ts"
  "src/app/api/events/[eventId]/tickets/[ticketId]/tiers/[tierId]/route.ts"
  "src/app/api/events/[eventId]/promo-codes/route.ts"
  "src/app/api/events/[eventId]/promo-codes/[promoCodeId]/route.ts"
)

# What a swept file may no longer contain, once comments are stripped.
PATTERN='denyReviewer\(|[A-Za-z_]+_ALLOW\b|role[[:space:]]*[!=]==|[!=]==[[:space:]]*session\.user\.role'

fail=0
for rel in "${SWEPT[@]}"; do
  f="$REPO_ROOT/$rel"
  if [[ ! -f "$f" ]]; then
    echo "check-permission-guards: swept file is missing: $rel (moved? update SWEPT)"
    fail=1
    continue
  fi
  stripped="$(sed -e 's|//.*$||' "$f" | perl -0777 -pe 's{/\*.*?\*/}{}gs')"
  hits="$(printf '%s\n' "$stripped" | grep -nE "$PATTERN" || true)"
  if [[ -n "$hits" ]]; then
    echo "check-permission-guards: $rel was moved onto requirePermission() and has a role check again:"
    printf '%s\n' "$hits" | sed 's/^/  /'
    fail=1
  fi
done

if [[ $fail -ne 0 ]]; then
  echo
  echo "Use requirePermission(session, \"<key>\", { route, eventId }) and gate.eventWhere instead."
  echo "If the role really needs something the catalogue cannot express, raise it; do not mix the two."
  exit 1
fi
echo "check-permission-guards: ${#SWEPT[@]} swept route files hold no role checks."
