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
  "src/app/api/contacts"          # Contacts pilot (July 23, 2026)
  "src/app/api/billing-accounts"  # BillingAccount sweep (July 24, 2026)
  "src/app/api/invoices"          # Invoice sweep — org-wide hub + export (July 27, 2026)
  "src/app/api/media"             # MediaFile route wiring — org-level list/upload/delete (July 27, 2026)
  "src/app/api/crm"               # CRM full-domain sweep — all 42 CRM routes (July 29, 2026)
)
# Specific swept route files whose DIR can't be swept wholesale — e.g. a domain
# nested under src/app/api/events, where sweeping the dir would wrongly demand a
# wrap on every unrelated event route.
SWEPT_ROUTE_FILES=(
  "src/app/api/events/[eventId]/billing-accounts/route.ts"                    # BillingAccount (July 24, 2026)
  "src/app/api/events/[eventId]/billing-accounts/[billingAccountId]/route.ts" # BillingAccount (July 24, 2026)
  # Invoice sweep — the event-nested invoice/quote STAFF surface (July 27, 2026).
  # NOT the 3 REGISTRANT invoice/quote routes (cross-org, organizationId=null —
  # deferred to the Phase-1 identity decision), and NOT the C2b cross-domain
  # writers (webhook / reconciliation / payments / resend / public-document /
  # payment-service) whose narrow invoice wraps live in non-invoice-domain
  # handlers — those get gated when their home domain is swept.
  "src/app/api/events/[eventId]/invoices/route.ts"                                # Invoice (July 27, 2026)
  "src/app/api/events/[eventId]/invoices/[invoiceId]/route.ts"                    # Invoice (July 27, 2026)
  "src/app/api/events/[eventId]/invoices/[invoiceId]/pdf/route.ts"                # Invoice (July 27, 2026)
  "src/app/api/events/[eventId]/invoices/[invoiceId]/send/route.ts"              # Invoice (July 27, 2026)
  "src/app/api/events/[eventId]/invoices/export/route.ts"                         # Invoice (July 27, 2026)
  "src/app/api/events/[eventId]/registrations/[registrationId]/quote/route.ts"   # Invoice — staff quote (July 27, 2026)
  # MediaFile route wiring — the event-nested media surface (July 27, 2026).
  "src/app/api/events/[eventId]/media/route.ts"                                   # MediaFile (July 27, 2026)
  "src/app/api/events/[eventId]/media/[mediaId]/route.ts"                         # MediaFile (July 27, 2026)
  # Webinar/Zoom sweep (July 28, 2026) — the 12 event-nested staff route files.
  # (webinar/panelists/route.ts also exports the non-HTTP resolveAnchorZoomMeeting
  # helper — HANDLER_RE only counts GET/POST/… so it doesn't inflate the demand.)
  "src/app/api/events/[eventId]/webinar/route.ts"                                 # Webinar (July 28, 2026)
  "src/app/api/events/[eventId]/webinar/attendance/route.ts"                      # Webinar (July 28, 2026)
  "src/app/api/events/[eventId]/webinar/engagement/route.ts"                      # Webinar (July 28, 2026)
  "src/app/api/events/[eventId]/webinar/presence/route.ts"                        # Webinar (July 28, 2026)
  "src/app/api/events/[eventId]/webinar/recording/fetch/route.ts"                 # Webinar (July 28, 2026)
  "src/app/api/events/[eventId]/webinar/room/route.ts"                            # Webinar (July 28, 2026)
  "src/app/api/events/[eventId]/webinar/panelists/route.ts"                       # Webinar (July 28, 2026)
  "src/app/api/events/[eventId]/webinar/panelists/[panelistId]/resend/route.ts"   # Webinar (July 28, 2026)
  "src/app/api/events/[eventId]/webinar/panelists/sync-speakers/route.ts"         # Webinar (July 28, 2026)
  "src/app/api/events/[eventId]/webinar/sequence/route.ts"                        # Webinar (July 28, 2026)
  "src/app/api/events/[eventId]/sessions/[sessionId]/zoom/route.ts"               # Webinar (July 28, 2026)
  "src/app/api/events/[eventId]/sessions/[sessionId]/zoom/panelists/route.ts"     # Webinar (July 28, 2026)
  # Webinar sweep — the PUBLIC session routes (org resolved via publicEventWhere,
  # wrap lands after the event null-check with event.organizationId). zoom-join/
  # recording/detail read ZoomMeeting via nested selects that would fail-closed
  # under platform RLS without a tenant store.
  "src/app/api/public/events/[slug]/sessions/[sessionId]/presence/route.ts"       # Webinar (July 28, 2026)
  "src/app/api/public/events/[slug]/sessions/[sessionId]/stream-status/route.ts"  # Webinar (July 28, 2026)
  "src/app/api/public/events/[slug]/sessions/[sessionId]/zoom-join/route.ts"      # Webinar (July 28, 2026)
  "src/app/api/public/events/[slug]/sessions/[sessionId]/recording/route.ts"      # Webinar (July 28, 2026)
  "src/app/api/public/events/[slug]/sessions/[sessionId]/detail/route.ts"         # Webinar (July 28, 2026)
  # Registration-core sweep (July 29, 2026) — staff registration + import routes.
  # (payments / quote / documents-resend were gated by the Invoice sweep; the
  # 7 REGISTRANT self-service routes under /api/registrant/** are deliberately
  # NOT swept — cross-org by design, deferred to the Phase-1 identity decision.)
  "src/app/api/events/[eventId]/registrations/route.ts"                                # Reg-core (July 29, 2026)
  "src/app/api/events/[eventId]/registrations/badges/route.ts"                         # Reg-core (July 29, 2026)
  "src/app/api/events/[eventId]/registrations/bulk-tags/route.ts"                      # Reg-core (July 29, 2026)
  "src/app/api/events/[eventId]/registrations/bulk-type/route.ts"                      # Reg-core (July 29, 2026)
  "src/app/api/events/[eventId]/registrations/import-contacts/route.ts"                # Reg-core (July 29, 2026)
  "src/app/api/events/[eventId]/registrations/[registrationId]/route.ts"               # Reg-core (July 29, 2026)
  "src/app/api/events/[eventId]/registrations/[registrationId]/activity/route.ts"      # Reg-core (July 29, 2026)
  "src/app/api/events/[eventId]/registrations/[registrationId]/barcode/route.ts"       # Reg-core (July 29, 2026)
  "src/app/api/events/[eventId]/registrations/[registrationId]/cancel/route.ts"        # Reg-core (July 29, 2026)
  "src/app/api/events/[eventId]/registrations/[registrationId]/check-in/route.ts"      # Reg-core (July 29, 2026)
  "src/app/api/events/[eventId]/registrations/[registrationId]/credit-notes/route.ts"  # Reg-core (July 29, 2026)
  "src/app/api/events/[eventId]/registrations/[registrationId]/email/route.ts"         # Reg-core (July 29, 2026)
  "src/app/api/events/[eventId]/registrations/[registrationId]/promo/route.ts"         # Reg-core (July 29, 2026)
  "src/app/api/events/[eventId]/registrations/[registrationId]/refund/route.ts"        # Reg-core (July 29, 2026)
  "src/app/api/events/[eventId]/import/registrations/route.ts"                          # Reg-core (July 29, 2026)
  "src/app/api/events/[eventId]/import/registrations/send-completion-emails/route.ts"   # Reg-core (July 29, 2026)
  "src/app/api/events/[eventId]/import/eventsair/route.ts"                              # Reg-core (July 29, 2026)
  "src/app/api/events/[eventId]/import/barcodes/route.ts"                               # Reg-core (July 29, 2026)
  # Registration-core sweep — the PUBLIC registration routes (org via
  # publicEventWhere / token; wrap after the event/row resolution).
  "src/app/api/public/events/[slug]/register/route.ts"                                 # Reg-core (July 29, 2026)
  "src/app/api/public/events/[slug]/checkout/route.ts"                                 # Reg-core (July 29, 2026)
  "src/app/api/public/events/[slug]/payment-status/[registrationId]/route.ts"          # Reg-core (July 29, 2026)
  "src/app/api/public/events/[slug]/check-email/route.ts"                              # Reg-core (July 29, 2026)
  "src/app/api/public/events/[slug]/complete-registration/route.ts"                    # Reg-core (July 29, 2026)
  "src/app/api/public/events/[slug]/validate-promo/route.ts"                           # Reg-core (July 29, 2026)
  "src/app/api/public/events/[slug]/registrations/[registrationId]/promo/route.ts"     # Reg-core (July 29, 2026)
  "src/app/api/public/events/[slug]/survey/route.ts"                                   # Reg-core (July 29, 2026)
  # Registration-core sweep — the Stripe webhook (unauthenticated-by-design;
  # org resolved per event object; wraps the money-transaction blocks).
  "src/app/api/webhooks/stripe/route.ts"                                               # Reg-core (July 29, 2026)
  # Ticketing follow-on sweep (July 30, 2026) — the management CRUD routes for
  # ticket types, pricing tiers, and promo codes. (The narrow cross-domain
  # ticketType-create wraps in events/route.ts + clone/route.ts live in
  # event-domain handlers and get gated when the Event domain is swept — same
  # policy as the Invoice C2b cross-domain wraps.)
  "src/app/api/events/[eventId]/tickets/route.ts"                                      # Ticketing (July 30, 2026)
  "src/app/api/events/[eventId]/tickets/[ticketId]/route.ts"                           # Ticketing (July 30, 2026)
  "src/app/api/events/[eventId]/tickets/[ticketId]/tiers/route.ts"                     # Ticketing (July 30, 2026)
  "src/app/api/events/[eventId]/tickets/[ticketId]/tiers/[tierId]/route.ts"            # Ticketing (July 30, 2026)
  "src/app/api/events/[eventId]/promo-codes/route.ts"                                  # Ticketing (July 30, 2026)
  "src/app/api/events/[eventId]/promo-codes/[promoCodeId]/route.ts"                    # Ticketing (July 30, 2026)
)
SWEPT_MODULES=(
  "src/lib/agent/tools/contacts.ts"   # contact agent / MCP executors
  "src/lib/agent/tools/invoices.ts"   # invoice agent / MCP executors (July 27, 2026)
  "src/lib/agent/tools/webinar.ts"    # webinar agent / MCP executors (July 28, 2026)
  # Webinar per-row sync fns + provisioner — org read off the row, remainder
  # wrapped (the module-level ≥1 check pins each file's wrap).
  "src/lib/webinar-attendance.ts"       # Webinar (July 28, 2026)
  "src/lib/webinar-engagement.ts"       # Webinar (July 28, 2026)
  "src/lib/webinar-recording-sync.ts"   # Webinar (July 28, 2026)
  "src/lib/webinar-provisioner.ts"      # Webinar (July 28, 2026)
  # Registration-core sweep (July 29, 2026) — MCP executors + per-row workers.
  "src/lib/agent/tools/registrations.ts"   # registration agent / MCP executors (July 29, 2026)
  "src/lib/certificates/auto-issue.ts"     # per-row cert auto-issue worker (July 29, 2026)
  "src/lib/refund-reconciliation.ts"       # per-row refund sweep worker (July 29, 2026)
  "src/lib/checkout-session-cleanup.ts"    # per-row checkout-session cleanup (July 29, 2026)
  # CRM full-domain sweep (July 29, 2026) — MCP executors + the 2 CRM workers.
  # The workers run OUTSIDE the CI gate's cron path; the module-level ≥1 check
  # pins each file's per-row runWithTenant wrap.
  "src/crm/agent-tools.ts"                  # CRM MCP executors (safeTool choke point) (July 29, 2026)
  "src/crm/reminders-worker.ts"             # per-row task-reminder worker (July 29, 2026)
  "src/crm/inbound-email-worker.ts"         # per-row inbound-email worker (July 29, 2026)
  # Ticketing follow-on sweep (July 30, 2026) — the promo-code MCP executors.
  # (create_ticket_type lives in the already-swept agent/tools/registrations.ts.)
  "src/lib/agent/tools/promo-codes.ts"      # promo-code agent / MCP executors (July 30, 2026)
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

# Per-file invariant: a route.ts must carry at least as many runWithTenant(
# calls as it has exported HTTP handlers.
check_one_route_file() {
  local file="$1" rel src handlers wraps
  rel="${file#"$REPO_ROOT"/}"
  src="$(executable_ts "$file")"
  handlers="$(count_re "$src" "$HANDLER_RE")"
  wraps="$(count_fixed "$src" "runWithTenant(")"
  if [ "$handlers" -gt 0 ] && [ "$wraps" -lt "$handlers" ]; then
    fail_header
    echo "  $rel — $handlers HTTP handler(s) but only $wraps runWithTenant( wrap(s)"
  fi
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
    check_one_route_file "$file"
  done < <(find "$abs" -name "route.ts" -type f)
done

# --- explicit swept route files (their dir can't be swept wholesale) ---
for file in "${SWEPT_ROUTE_FILES[@]}"; do
  abs="$REPO_ROOT/$file"
  if [ ! -f "$abs" ]; then
    fail_header
    echo "  swept route file missing: $file"
    continue
  fi
  check_one_route_file "$abs"
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
