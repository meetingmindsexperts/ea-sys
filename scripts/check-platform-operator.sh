#!/usr/bin/env bash
# Platform-operator boundary guard (multi-tenancy).
#
# WHY THIS EXISTS
# ---------------
# `src/lib/platform-operator.ts` answers one question that no other predicate in
# this codebase answers: *may this caller act across tenant boundaries?* It was
# written correctly in August 2026 — and then only eight files adopted it. The
# Aug 21 ADMIN-gate sweep found ten more places still deciding the same question
# with a bare `role === "SUPER_ADMIN"` test, six of which let a caller swap the
# acting organisation by setting an `x-org-id` request header.
#
# That is the failure this gate exists to prevent, and it generalises well
# beyond this repo: WRITING the right predicate is half the job, and the sweep
# that ADOPTS it is the other half. A guard that exists but is not called is
# indistinguishable from no guard — and is worse than none, because its
# existence reads as coverage to the next person.
#
# Both checks are INERT on master by design. `PLATFORM_ORG_ID` is unset there,
# so `canActAsPlatformOperator` reduces to the previous `role === "SUPER_ADMIN"`
# test. Nothing below changes master behaviour; it pins the shape so the
# platform inherits it.
#
# WHAT IT CHECKS
# --------------
#   1. ONE READER for `x-org-id`. The header is a cross-tenant org override, so
#      exactly one module may read it: platform-operator.ts, which gates it.
#      A second reader is how the un-gated version comes back.
#   2. PLATFORM_SURFACES adopt the predicate. Each listed file serves data that
#      spans tenants or belongs to us rather than to any tenant, so it must
#      reference `denyNonOperator(` or `canActAsPlatformOperator(`.
#      Deliberately a POSITIVE check ("did you call it?") rather than a ban on
#      the string SUPER_ADMIN: some of these files legitimately keep a coarse
#      `ADMIN || SUPER_ADMIN` gate in front of the operator check, and a rule
#      that forbade the string would push authors into working around it.
#
# HOW TO GROW IT
# --------------
# Add any new cross-tenant or operator-only surface to PLATFORM_SURFACES. Never
# remove an entry to make CI pass — that is precisely the regression it guards.
#
# Usage: bash scripts/check-platform-operator.sh
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

# ---------------------------------------------------------------------------
# 1. x-org-id has exactly one reader.
# ---------------------------------------------------------------------------
# `use-api.ts` SETS the header (the org switcher) and `proxy.ts` names it in the
# CORS allow-list; neither reads it to make an authorisation decision.
allowed_readers="src/lib/platform-operator.ts"

readers=$(grep -rln --include='*.ts' --include='*.tsx' \
  -e 'headers.get("x-org-id")' -e "headers.get('x-org-id')" \
  src/ 2>/dev/null | sort || true)

for f in $readers; do
  case " $allowed_readers " in
    *" $f "*) ;;
    *)
      echo "FAIL: $f reads the x-org-id header directly."
      echo "      That header swaps the acting organisation. It must be resolved"
      echo "      through resolveActingOrgId() in src/lib/platform-operator.ts,"
      echo "      which honours it for a platform operator only and logs both"
      echo "      the honoured and the refused case."
      fail=1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# 2. Platform surfaces call the operator predicate.
# ---------------------------------------------------------------------------
PLATFORM_SURFACES=(
  # Our system logs — cross-tenant by nature, and DELETE-capable.
  "src/app/api/logs/route.ts"
  "src/app/api/logs/archive/route.ts"
  # Silences OUR paging, not any tenant's.
  "src/app/api/admin/alerts/silence/route.ts"
  # Enumerates every tenant.
  "src/app/api/organizations/route.ts"
  # Our repository.
  "src/app/api/admin/docs/tree/route.ts"
  "src/app/api/admin/docs/file/route.ts"
  "src/app/api/admin/docs/search/route.ts"
  "src/app/admin/docs/[...path]/route.ts"
  # Our host, our AWS account, our deploy history.
  "src/app/api/admin/infra/route.ts"
  "src/app/api/admin/infra/traffic/route.ts"
  # Captured questions from every tenant's users.
  "src/app/api/help-chat/queries/route.ts"
  # The org override itself.
  "src/lib/api-auth.ts"
  "src/app/api/organization/route.ts"
  "src/app/api/organization/branding/route.ts"
  "src/app/api/events/route.ts"
)

for f in "${PLATFORM_SURFACES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "FAIL: $f is listed as a platform surface but does not exist."
    echo "      If it moved, update this list; do not delete the entry."
    fail=1
    continue
  fi
  if ! grep -qE 'denyNonOperator\(|canActAsPlatformOperator\(|resolveActingOrgId\(' "$f"; then
    echo "FAIL: $f is a platform surface but never calls the operator predicate."
    echo "      It serves data that spans tenants or belongs to us. Gate it with"
    echo "      denyNonOperator(session, { route: \"…\" }) — a bare"
    echo "      role === \"SUPER_ADMIN\" check is not enough, because on the"
    echo "      platform a TENANT can hold that role."
    fail=1
  fi
done

# ---------------------------------------------------------------------------
# 3. No STANDALONE SUPER_ADMIN gate on a platform surface.
# ---------------------------------------------------------------------------
# Check 2 is per-file, so a route with two handlers still passes it when only
# ONE keeps the predicate — which is exactly how a regression would land. This
# check closes that: on a platform surface, a `role === "SUPER_ADMIN"`
# comparison may not stand alone as the authorisation decision.
#
# The coarse form `role !== "ADMIN" && role !== "SUPER_ADMIN"` IS allowed and
# is used deliberately: infra and organization run it as a cheap pre-filter in
# front of the real operator check. It is recognised by the presence of the
# separate "ADMIN" literal on the same line (note `"SUPER_ADMIN"` does not
# contain `"ADMIN"` — the opening quote is what distinguishes them).
for f in "${PLATFORM_SURFACES[@]}"; do
  [ -f "$f" ] || continue
  bare=$(grep -nE '(!==|===)[[:space:]]*"SUPER_ADMIN"' "$f" \
    | grep -vE '^[0-9]+:[[:space:]]*(\*|//|/\*)' \
    | grep -v '"ADMIN"' || true)
  if [ -n "$bare" ]; then
    echo "FAIL: $f decides authorisation with a standalone SUPER_ADMIN check:"
    echo "$bare" | sed 's/^/        /'
    echo "      On the platform a TENANT can hold SUPER_ADMIN, so that test does"
    echo "      not mean \"one of us\". Use denyNonOperator(session, { route })."
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "Platform-operator boundary check FAILED."
  exit 1
fi

echo "Platform-operator boundary check passed (${#PLATFORM_SURFACES[@]} surfaces, x-org-id single-reader, no standalone SUPER_ADMIN gates)."
