#!/usr/bin/env bash
# Measurable RLS rollout inventory. This is deliberately read-only: it reports
# remaining transaction work and validates the human-owned domain checklist.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
CHECKLIST="docs/RLS_MIGRATION_STATUS.md"

if [[ ! -f "$CHECKLIST" ]]; then
  echo "✗ Missing $CHECKLIST"
  exit 1
fi

plain_transactions=$(rg -l --glob '*.{ts,tsx}' 'db\.\$transaction\(' src worker | wc -l | tr -d ' ')
tenant_transactions=$(rg -l --glob '*.{ts,tsx}' 'tenantTransaction\(' src worker | wc -l | tr -d ' ')
tenant_wrappers=$(rg -l --glob '*.{ts,tsx}' 'runWithTenant\(' src worker | wc -l | tr -d ' ')
pending_domains=$(rg -c '^\| .* \| PENDING \|' "$CHECKLIST" | awk '{ total += $NF } END { print total + 0 }')

echo "RLS migration status"
echo "  files using db.\$transaction: $plain_transactions"
echo "  files using tenantTransaction: $tenant_transactions"
echo "  files using runWithTenant: $tenant_wrappers"
echo "  checklist domains pending: $pending_domains"

if [[ "${1:-}" == "--require-ready" ]]; then
  if ((pending_domains > 0 || plain_transactions > 0)); then
    echo "✗ RLS rollout is not ready: migrate all scoped transaction paths and mark every domain COMPLETE."
    exit 1
  fi
  echo "✓ RLS rollout readiness criterion met"
fi
