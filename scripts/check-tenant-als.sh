#!/usr/bin/env bash
# runWithTenant regression guard for SWEPT tenancy domains (multi-tenancy Phase 2).
#
# WHY THIS EXISTS
# ---------------
# A domain that has been through the Phase-2 isolation sweep wraps every
# org-context-resolving handler body in `runWithTenant(orgId, …)`
# (docs/MULTI_TENANCY.md §13, step C2). That wrap is INERT on master
# (RLS_SET_LOCAL off → runWithTenant just runs the callback) but LOAD-BEARING on
# the future platform instance: without it the SET LOCAL Prisma extension has no
# tenant in the AsyncLocalStorage store, so every query in that handler
# fail-closes to zero rows — or, if the policy were somehow off, LEAKS.
#
# The danger is that dropping a wrap is SILENT on master: tests pass, no
# behavior changes, master never turns the flag on. The regression only
# surfaces the day the platform enables RLS — as data loss or a leak. This gate
# is the ONLY thing that catches it before then, which is why it is worth a
# dedicated CI step even while just one domain is swept.
#
# WHAT IT CHECKS
# --------------
#   * SWEPT_ROUTE_DIRS: every route.ts under the dir must have at least as many
#     `runWithTenant(` calls as it has exported HTTP handlers
#     (GET/POST/PUT/PATCH/DELETE) — i.e. no handler can silently lose its wrap.
#     (Coarse-but-robust: a contrived double-wrap-in-one-handler could mask a
#     missing wrap in another; the realistic regression — deleting a wrap —
#     is always caught.)
#   * SWEPT_MODULES: the file must contain a `runWithTenant(` call
#     (module-level granularity — the agent/MCP executor path is
#     API-key/admin-equivalent, so the coarser check is acceptable; the public
#     HTTP routes are the primary leak surface).
#
# HOW TO GROW IT
# --------------
# When a new domain finishes its Phase-2 sweep, add its route dir to
# SWEPT_ROUTE_DIRS (and any executor module to SWEPT_MODULES). The gate then
# pins that domain's wrap forever. NEVER remove a swept entry to make CI pass —
# that is exactly the regression this guards.
#
# Usage: bash scripts/check-tenant-als.sh
# Exit:  0 = clean, 1 = a swept handler lost its runWithTenant wrap

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Domains that have completed the Phase-2 isolation sweep (org-bound queries +
# runWithTenant wrap + RLS policy). GROW this as domains are swept.
SWEPT_ROUTE_DIRS=(
  "src/app/api/contacts"   # Contacts pilot (July 23, 2026)
)
SWEPT_MODULES=(
  "src/lib/agent/tools/contacts.ts"   # contact agent / MCP executors
)

# Strip // line comments and /* */ blocks so prose / commented-out code isn't
# counted (same technique as check-tenant-scoping.sh).
executable_ts() {
  sed -e 's|//.*$||' "$1" | perl -0777 -pe 's{/\*.*?\*/}{}gs'
}

# Count matches without letting a zero-match grep abort under pipefail.
count_re()    { printf '%s' "$1" | { grep -oE "$2" || true; } | wc -l | tr -d ' '; }
count_fixed() { printf '%s' "$1" | { grep -oF "$2" || true; } | wc -l | tr -d ' '; }

# `export async function GET(` — trailing `(` disambiguates GET from GETFoo and
# keeps the regex portable (no \b, which BSD grep on macOS doesn't support).
HANDLER_RE='export[[:space:]]+(async[[:space:]]+)?function[[:space:]]+(GET|POST|PUT|PATCH|DELETE)[[:space:]]*\('

violations=0
fail_header() {
  if [ "$violations" -eq 0 ]; then
    echo ""
    echo "✗ A swept tenancy domain lost its runWithTenant wrap"
    echo "  (inert on master, but a wrapless handler fail-closes to zero rows —"
    echo "  or leaks — on the multi-tenant platform. docs/MULTI_TENANCY.md §13.)"
    echo ""
  fi
  violations=$((violations + 1))
}

# --- route dirs: runWithTenant( count >= HTTP handler count, per file ---
for dir in "${SWEPT_ROUTE_DIRS[@]}"; do
  abs="$REPO_ROOT/$dir"
  if [ ! -d "$abs" ]; then
    fail_header
    echo "  swept dir missing: $dir — a domain was moved/deleted without updating this gate"
    continue
  fi
  while IFS= read -r file; do
    rel="${file#"$REPO_ROOT"/}"
    src="$(executable_ts "$file")"
    handlers="$(count_re "$src" "$HANDLER_RE")"
    wraps="$(count_fixed "$src" "runWithTenant(")"
    if [ "$handlers" -gt 0 ] && [ "$wraps" -lt "$handlers" ]; then
      fail_header
      echo "  $rel — $handlers HTTP handler(s) but only $wraps runWithTenant( wrap(s)"
    fi
  done < <(find "$abs" -name "route.ts" -type f)
done

# --- module files: must contain a runWithTenant( call ---
for mod in "${SWEPT_MODULES[@]}"; do
  abs="$REPO_ROOT/$mod"
  if [ ! -f "$abs" ]; then
    fail_header
    echo "  swept module missing: $mod"
    continue
  fi
  src="$(executable_ts "$abs")"
  if [ "$(count_fixed "$src" "runWithTenant(")" -eq 0 ]; then
    fail_header
    echo "  $mod — no runWithTenant( call (executors must wrap in the tenant store)"
  fi
done

if [ "$violations" -gt 0 ]; then
  cat <<'EOF'

  Fix: wrap the handler body after the auth / role guards —

      import { runWithTenant } from "@/lib/tenant-context";
      const orgId = session.user.organizationId;   // capture BEFORE the closure
      return runWithTenant(orgId, async () => {
        // ... all db access for this request ...
      });

  Do NOT remove the domain from scripts/check-tenant-als.sh to pass CI — that
  is the exact regression this guards. docs/MULTI_TENANCY.md §13.

EOF
  exit 1
fi

echo "✓ Tenant ALS: all swept-domain handlers wrap in runWithTenant"
