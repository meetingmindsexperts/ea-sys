#!/usr/bin/env bash
# Guard against the `organizationId!` footgun in event API routes.
#
# WHY THIS EXISTS
# ---------------
# Org-independent roles (REVIEWER / SUBMITTER / REGISTRANT) have
# `User.organizationId === null`. A route that writes
#   where: { organizationId: session.user.organizationId! }
# sends `organizationId: null` to Prisma, which is a VALIDATION ERROR on the
# non-nullable `Event.organizationId` column → a 500 (Sentry
# JAVASCRIPT-NEXTJS-1N / zoom:settings-fetch-failed). A null-org user walking an
# event's admin endpoints trips every route carrying this footgun.
#
# The whole src/app/api/events surface was swept to use requireOrgId
# (src/lib/require-org.ts); this gate keeps it swept — a new route that
# hand-rolls the `!` assertion fails CI.
#
# HOW TO FIX A HIT
# ----------------
# After the `!session?.user` check (and any denyReviewer/denyFinance guard):
#     import { requireOrgId } from "@/lib/require-org";
#     const org = requireOrgId(session, { eventId });
#     if ("error" in org) return org.error;
#     // ...use org.orgId instead of session.user.organizationId!
#
# Usage: bash scripts/check-org-guard.sh
# Exit:  0 = clean, 1 = footgun found

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCAN_DIR="$REPO_ROOT/src/app/api/events"

# Strip // line comments and /* */ blocks so a prose mention of the pattern
# (e.g. in a route's header doc) doesn't trip the gate.
hits="$(
  find "$SCAN_DIR" -name '*.ts' -type f | while IFS= read -r f; do
    stripped="$(sed -e 's|//.*$||' "$f" | perl -0777 -pe 's{/\*.*?\*/}{}gs')"
    if printf '%s' "$stripped" | grep -q 'session\.user\.organizationId!'; then
      echo "${f#"$REPO_ROOT"/}"
    fi
  done
)"

if [ -n "$hits" ]; then
  echo ""
  echo "✗ organizationId! footgun in event API route(s):"
  # shellcheck disable=SC2001  # sed reads clearer than a ${//} loop here
  echo "$hits" | sed 's/^/    /'
  cat <<'EOF'

  A null-org user (REVIEWER/SUBMITTER/REGISTRANT) hitting one of these sends
  `organizationId: null` to Prisma → a 500 (JAVASCRIPT-NEXTJS-1N).

  Fix — after the auth check (and any denyReviewer/denyFinance guard):
      import { requireOrgId } from "@/lib/require-org";
      const org = requireOrgId(session, { eventId });
      if ("error" in org) return org.error;
      // ...use org.orgId instead of session.user.organizationId!

EOF
  exit 1
fi

echo "✓ Org guard: no organizationId! footgun in event API routes"
