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
#     `runWithTenant(` / `runWithTenantLane(` calls as it has exported HTTP handlers
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
  "src/app/api/events/[eventId]/speakers"  # Speaker sweep — the whole speakers/** route family (July 30, 2026)
  "src/app/api/events/[eventId]/certificates"  # Certificates sweep — the whole certificates/** route family (July 31, 2026)
  "src/app/api/events/[eventId]/session-proposals"        # Session Proposals sweep — proposals list/create + detail (Aug 3, 2026)
  "src/app/api/events/[eventId]/session-proposal-themes"  # Session Proposals sweep — theme CRUD (Aug 3, 2026)
  "src/app/api/events/[eventId]/rsvp-campaigns"           # RSVP sweep — campaigns + items + roster/add/delete/send (Aug 3, 2026; re-scoped to campaigns Aug 14, 2026)
  # Survey sweep (Domain #16, Aug 3, 2026) — the responses reporting pair
  # (list/aggregate + CSV export), RESOURCE-org wraps (buildEventAccessWhere
  # serves org-null SUPER_ADMIN). The sibling survey/share-link route touches
  # only unswept Event and is deliberately not swept; the public submit route
  # is already gated under the Reg-core SWEPT_ROUTE_FILES entry.
  "src/app/api/events/[eventId]/survey/responses"         # Survey sweep — reporting + export (Aug 3, 2026)
  # Reimbursement sweep (Domain #17, Aug 3, 2026) — the dashboard console
  # (list/add + detail/reopen/delete + doc stream + send) wraps in the
  # RESOURCE org (buildEventAccessWhere serves org-null SUPER_ADMIN); the 3
  # public token routes bootstrap the org from the un-swept Event by
  # host+slug (resolveReimbursementEventOrg — the RSVP pattern) then wrap.
  # src/lib/reimbursement/server.ts is a runs-inside-wraps lib (its loader
  # opens no runWithTenant of its own, by design — not listed).
  "src/app/api/events/[eventId]/reimbursements"           # Reimbursement sweep — console (Aug 3, 2026)
  "src/app/api/public/events/[slug]/reimbursement"        # Reimbursement sweep — public token routes (Aug 3, 2026)
  # Comms-log sweep (Domain #18, Aug 3, 2026) — the EmailLog read surface
  # (entity Email History list + stored-body fetch), SESSION-org wraps.
  "src/app/api/email-logs"                                # Comms-log sweep — EmailLog reads (Aug 3, 2026)
)
# Specific swept route files whose DIR can't be swept wholesale — e.g. a domain
# nested under src/app/api/events, where sweeping the dir would wrongly demand a
# wrap on every unrelated event route.
SWEPT_ROUTE_FILES=(
  # Group registration — born-compliant domain (Aug 6, 2026): the public
  # group-register POST wraps its post-event-resolution body in runWithTenant
  # (resource org). The service's tx uses tenantTransaction.
  "src/app/api/public/events/[slug]/group-register/route.ts"                  # RegistrationGroup (Aug 6, 2026)
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
  # (quote / documents-resend were gated by the Invoice sweep; the 7 REGISTRANT
  # self-service routes under /api/registrant/** are deliberately NOT swept —
  # cross-org by design, deferred to the Phase-1 identity decision.)
  # payments/route.ts added Jul 30 (review B-1): the Invoice wrap only covered
  # the INVOICE write, NOT the registration/payment writes — the handler was
  # never wrapped. Corrects the earlier wrong "payments gated by Invoice" note.
  "src/app/api/events/[eventId]/registrations/[registrationId]/payments/route.ts"      # Reg-core B-1 (July 30, 2026)
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
  # RELOCATED Aug 4, 2026 (per-tenant keys, item 7 phase 2): the whole
  # post-verification dispatch body — including every runWithTenant wrap —
  # was extracted VERBATIM to src/lib/stripe-webhook-handler.ts so the
  # legacy env route AND the per-org /api/webhooks/stripe/[orgId] route
  # share ONE implementation. The routes are now thin verify-and-delegate
  # shells with no db access of their own; the wraps are gated at the
  # handler module (SWEPT_MODULES below). Coverage moved, NOT removed.
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
  # Speaker sweep (July 30, 2026) — the CSV speaker importer (not under speakers/)
  # + the speaker-facing PUBLIC routes (org via publicEventWhere → event.organizationId).
  # (reviewers/route.ts got a narrow cross-domain speaker.update wrap but is NOT
  # gated here — it's an abstracts/reviewer route, gated when that domain is swept;
  # organization/users/[userId]'s speaker.updateMany is cross-org BY DESIGN — no wrap.)
  "src/app/api/events/[eventId]/import/speakers/route.ts"                              # Speaker (July 30, 2026)
  "src/app/api/public/events/[slug]/speaker-agreement/route.ts"                        # Speaker (July 30, 2026)
  "src/app/api/public/events/[slug]/presenter-agreement/route.ts"                      # Speaker (July 30, 2026)
  "src/app/api/public/events/[slug]/submitter/route.ts"                                # Speaker (July 30, 2026)
  "src/app/api/public/events/[slug]/abstract-start/route.ts"                           # Speaker (July 30, 2026)
  # Accommodation sweep (July 31, 2026) — the hotels/** + accommodations/** route
  # family, nested under events/[eventId] so listed by file (dir-sweep would wrongly
  # demand a wrap on every event route). accommodation-service.ts is NOT a module
  # entry — it opens no runWithTenant of its own (its callers wrap; it uses
  # tenantTransaction for the swept writes, reading orgId from the caller's store).
  "src/app/api/events/[eventId]/hotels/route.ts"                                       # Accommodation (July 31, 2026)
  "src/app/api/events/[eventId]/hotels/[hotelId]/route.ts"                             # Accommodation (July 31, 2026)
  "src/app/api/events/[eventId]/hotels/[hotelId]/rooms/route.ts"                       # Accommodation (July 31, 2026)
  "src/app/api/events/[eventId]/hotels/[hotelId]/rooms/[roomId]/route.ts"              # Accommodation (July 31, 2026)
  "src/app/api/events/[eventId]/accommodations/route.ts"                               # Accommodation (July 31, 2026)
  "src/app/api/events/[eventId]/accommodations/[accommodationId]/route.ts"             # Accommodation (July 31, 2026)
  # Abstract sweep (July 31, 2026) — Domain #11. The organizer routes wrap with
  # the session org (requireOrgId); the DUAL routes (abstracts list/create, detail,
  # submissions, my-profile, presenter-agreement) serve org-INDEPENDENT
  # reviewers/submitters and wrap with the RESOURCE org (event.organizationId,
  # loaded first). /api/my-reviews is DELIBERATELY NOT here — it is cross-org by
  # design (the Phase-1 identity edge, deferred). abstract-service.ts is NOT a
  # module entry (uses tenantTransaction, opens no runWithTenant of its own).
  "src/app/api/events/[eventId]/abstract-themes/route.ts"                              # Abstract (July 31, 2026)
  "src/app/api/events/[eventId]/abstract-themes/[themeId]/route.ts"                    # Abstract (July 31, 2026)
  "src/app/api/events/[eventId]/review-criteria/route.ts"                              # Abstract (July 31, 2026)
  "src/app/api/events/[eventId]/review-criteria/[criterionId]/route.ts"               # Abstract (July 31, 2026)
  "src/app/api/events/[eventId]/reviewers/route.ts"                                    # Abstract (July 31, 2026)
  "src/app/api/events/[eventId]/reviewers/[reviewerId]/route.ts"                       # Abstract (July 31, 2026)
  "src/app/api/events/[eventId]/reviewers/[reviewerId]/resend-invitation/route.ts"     # Abstract (July 31, 2026)
  "src/app/api/events/[eventId]/import/abstracts/route.ts"                             # Abstract (July 31, 2026)
  "src/app/api/events/[eventId]/abstracts/route.ts"                                    # Abstract — dual/resource-org (July 31, 2026)
  "src/app/api/events/[eventId]/abstracts/[abstractId]/route.ts"                       # Abstract — dual/resource-org (July 31, 2026)
  "src/app/api/events/[eventId]/abstracts/[abstractId]/submissions/route.ts"           # Abstract — dual/resource-org (July 31, 2026)
  "src/app/api/events/[eventId]/abstracts/[abstractId]/reviewers/route.ts"             # Abstract (July 31, 2026)
  "src/app/api/events/[eventId]/abstracts/[abstractId]/reviewers/[userId]/route.ts"    # Abstract (July 31, 2026)
  "src/app/api/events/[eventId]/abstracts/[abstractId]/presenter-agreement/email/route.ts" # Abstract — resource-org (July 31, 2026)
  "src/app/api/events/[eventId]/abstracts/my-profile/route.ts"                         # Abstract — resource-org (July 31, 2026)
  # Sessions/Tracks sweep (July 31, 2026) — Domain #12. RESOURCE-org routes
  # (buildEventAccessWhere / publicEventWhere → event.organizationId; they serve
  # org-null submitters on the agenda GET too). The zoom + other public session
  # routes (detail/presence/recording/stream-status/zoom-join, zoom/route,
  # zoom/panelists) are already in this list from the Webinar sweep — their
  # existing wraps now also scope EventSession.
  "src/app/api/events/[eventId]/sessions/route.ts"                                     # Sessions (July 31, 2026)
  "src/app/api/events/[eventId]/sessions/[sessionId]/route.ts"                         # Sessions (July 31, 2026)
  "src/app/api/events/[eventId]/tracks/route.ts"                                       # Sessions (July 31, 2026)
  "src/app/api/events/[eventId]/tracks/[trackId]/route.ts"                             # Sessions (July 31, 2026)
  "src/app/api/events/[eventId]/import/sessions/route.ts"                              # Sessions (July 31, 2026)
  "src/app/api/public/events/[slug]/sessions/[sessionId]/lobby-status/route.ts"        # Sessions — public resource-org (July 31, 2026)
  # Session Proposals sweep (Aug 3, 2026): submitter-context reads Speaker (swept
  # #9) + counts of Abstract (#11) + SessionProposal (#14) — a pre-existing
  # unwrapped reader this sweep closed.
  "src/app/api/events/[eventId]/submitter-context/route.ts"                            # Session Proposals — resource-org (Aug 3, 2026)
  # Dinner RSVP sweep (Aug 3, 2026): the public token route resolves org from the
  # Event by host+slug (publicEventWhere) FIRST, then reads the swept RsvpInvite
  # by its globally-unique token inside runWithTenant — RLS would otherwise
  # fail-close the token lookup to null.
  "src/app/api/public/events/[slug]/rsvp/[token]/route.ts"                             # RSVP — public resource-org (Aug 3, 2026)
  # Comms-log sweep (Domain #18, Aug 3, 2026) — the ScheduledEmail enqueue +
  # management routes (SESSION org via requireOrgId) + the event Email
  # Activity rollup. src/lib/email-log.ts self-wraps at the logEmail choke
  # point (listed in SWEPT_MODULES); webinar-email-sequence.ts is a
  # runs-inside-wraps lib (its callers — the sequence route, the provisioner,
  # the public register route — all wrap; not listed).
  "src/app/api/events/[eventId]/emails/bulk/route.ts"                                  # Comms-log (Aug 3, 2026)
  "src/app/api/events/[eventId]/emails/schedule/route.ts"                              # Comms-log (Aug 3, 2026)
  "src/app/api/events/[eventId]/emails/schedule/[id]/route.ts"                         # Comms-log (Aug 3, 2026)
  "src/app/api/events/[eventId]/emails/schedule/[id]/retry/route.ts"                   # Comms-log (Aug 3, 2026)
  "src/app/api/events/[eventId]/email-activity/route.ts"                               # Comms-log (Aug 3, 2026)
  "src/app/api/activity/route.ts"                                                      # AuditLog sweep (Aug 3, 2026)
  "src/app/api/events/[eventId]/activity/route.ts"                                     # AuditLog sweep (Aug 3, 2026)
  "src/app/api/events/[eventId]/analytics/route.ts"                                    # AuditLog sweep (Aug 3, 2026)
  # HelpChatQuery (Aug 4, 2026): the capture writer. Its sibling
  # queries/route.ts reader is DELIBERATELY unlisted — operator-global,
  # privileged-lane (owner decision; see prisma/rls/helpchatquery.sql).
  "src/app/api/help-chat/route.ts"                                                     # HelpChatQuery sweep (Aug 4, 2026)
)
SWEPT_MODULES=(
  # Analytics (Aug 20, 2026). The INGEST ROUTE is deliberately NOT listed: it
  # does not wrap, it enqueues into an in-memory buffer and returns. The tenant
  # lane is entered by the store when the buffer flushes, which is the only
  # place a row is written, and it groups by organisation first because one
  # container's buffer can hold hits for several tenants.
  "src/analytics/store/prisma-store.ts"   # buffered analytics writer (Aug 20, 2026)
  "src/analytics/store/event-traffic.ts"  # dashboard traffic read (Aug 20, 2026)
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
  # NOTE: src/lib/certificates/auto-issue.ts (first gated here July 29) is
  # listed ONCE, under the Certificates block below (review L4 dedupe).
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
  # Speaker sweep (July 30, 2026) — the speaker MCP executors.
  "src/lib/agent/tools/speakers.ts"         # speaker agent / MCP executors (July 30, 2026)
  # Accommodation sweep (July 31, 2026) — the accommodation MCP executors.
  "src/lib/agent/tools/accommodations.ts"   # accommodation agent / MCP executors (July 31, 2026)
  # Abstract sweep (July 31, 2026) — the abstract/reviewer/criteria MCP executors.
  "src/lib/agent/tools/abstracts.ts"        # abstract agent / MCP executors (July 31, 2026)
  # Sessions/Tracks sweep (July 31, 2026) — the session + track/event MCP executors.
  "src/lib/agent/tools/sessions.ts"         # session agent / MCP executors (July 31, 2026)
  "src/lib/agent/tools/events.ts"           # events/tracks agent / MCP executors (July 31, 2026)
  # Certificates sweep (July 31, 2026; review round Aug 3, 2026) — the
  # cert-template MCP executors + the THREE cert workers whose OWN wrap is
  # load-bearing: issue-worker.tickAllRuns wraps each run in
  # runWithTenant(run.organizationId); auto-issue wraps per-registration (+ the
  # per-event template load, review M2); survey-thankyou-sweep wraps per-row in
  # the event org (review H1). deliver/bundle/bulk-issue/cert-context/eligibility
  # run INSIDE those wraps (no own runWithTenant, by design — not listed;
  # bulk-issue's bulk-send caller is wrapped at scheduled-emails-worker + the
  # MCP communications executor, review H2).
  "src/lib/agent/tools/certificates.ts"     # certificate agent / MCP executors (July 31, 2026)
  "src/lib/certificates/issue-worker.ts"    # cert worker — per-run runWithTenant wrap (July 31, 2026)
  "src/lib/certificates/auto-issue.ts"      # cert survey-gated sweep — per-reg runWithTenant wrap (July 31, 2026)
  "src/lib/certificates/survey-thankyou-sweep.ts" # thank-you sweep — per-row wrap (review H1, Aug 3, 2026)
  # Bulk-email execution contexts (Certificates-sweep review H2, Aug 3, 2026) —
  # executeBulkEmail reads swept Registration/Speaker/Abstract + (certificate
  # sends) CertificateTemplate/IssuedCertificate/serial counter via
  # executeCertificateBulkSend; the wrap lives at its two callers. The two
  # enqueue routes' precheck wraps (emails/bulk + emails/schedule) are NARROW
  # cross-domain wraps (Invoice-C2b pattern) — gated when ScheduledEmail sweeps.
  "src/lib/scheduled-emails-worker.ts"      # bulk-email worker — whole processRow on the row org (Domain #18, Aug 3, 2026)
  # The shared Stripe webhook dispatcher (item 7 phase 2, Aug 4 2026): the
  # Reg-core sweep's webhook wraps live HERE now — the dispatch body (with
  # every runWithTenant) was extracted verbatim from
  # src/app/api/webhooks/stripe/route.ts, which both webhook routes (legacy
  # env + per-org [orgId]) now delegate to as thin verify-only shells.
  "src/lib/stripe-webhook-handler.ts"       # Stripe webhook money blocks — event/payment-resolved org wraps (Reg-core, relocated Aug 4, 2026)
  "src/lib/agent/tools/communications.ts"   # MCP send_bulk_email + list/cancel_scheduled_email — ctx-org wraps (Aug 3, 2026)
  # Comms-log sweep (Domain #18): logEmail is the ONE EmailLog writer — it
  # resolves the org (explicit context, else 1-hop from the tagged event) and
  # self-wraps the insert, so every sender rides the right lane by construction;
  # NULL-org auth emails insert bare (asymmetric WITH CHECK). The org-blind
  # email-log-prune worker + the SUPER_ADMIN ops reads in infra/aws-ops.ts are
  # the documented worker/ops preconditions, not module entries.
  "src/lib/email-log.ts"                    # EmailLog choke-point writer — self-wrap on resolved org (Aug 3, 2026)
  # MCP-resource-handlers follow-on (July 31, 2026) — register-mcp-tools.ts has
  # inline server.tool / server.resource handlers that read swept tables directly
  # (NOT via the wrapped tools/*.ts executors): list_contacts (Contact),
  # event-registrations-summary (Registration), event-speakers (Speaker),
  # event-abstracts-summary (Abstract/AbstractTheme) — all now wrap in
  # runWithTenant(organizationId). Tripwire: ≥1 wrap must remain. NOTE the
  # event-agenda resource reads EventSession (not yet swept) unwrapped — the
  # Sessions-domain sweep must wrap it then.
  "src/lib/agent/register-mcp-tools.ts"     # MCP resource/tool handlers (July 31, 2026)
  "src/lib/agent/tools/rsvp.ts"             # rsvp agent / MCP executor (Aug 3, 2026; renamed Aug 14, 2026)
)

# ---------------------------------------------------------------------------
# PRIVILEGED-LANE ALLOWLIST (multi-tenancy item 5, Aug 11 2026)
# ---------------------------------------------------------------------------
# `dbOperator` (src/lib/db.ts) connects as the table-OWNER database role, which
# is exempt from every RLS policy. It is the deliberate cross-tenant lane for
# the worker's candidate scans and the operator-global readers.
#
# The whole reason it is a separate export rather than a flag on `db` is so
# that privileged access is a GREPPABLE IMPORT this gate can pin. Only the
# files below may import it; anything else fails CI.
#
# ADDING A FILE HERE IS A SECURITY DECISION, not a build fix. Before you add
# one, check the alternative: nearly every "I need cross-tenant data" case is
# really "I need to run inside the RIGHT tenant's lane", which is
# `runWithTenant`, not this. Genuine members of this list are surfaces that are
# cross-tenant BY DESIGN and would see zero rows from any single lane.
#
# Every entry below is a WORKER CANDIDATE SCAN and nothing more. In each case
# the scan finds rows across tenants, reads the org OFF the row, and then does
# the actual work inside `runWithTenant(thatOrg, …)` on the normal client. The
# jobs are not privileged; two statements inside them are.
#
# The one exception is email-log-prune, which is privileged end to end: it
# reaps by row AGE across every tenant plus the NULL-org pool, and that pool
# has no owning org to borrow a lane from.
#
# NOT here, deliberately: system-log-prune, log-archive, oauth-cleanup and
# login-event-prune. They scan SystemLog / McpOAuth* / LoginEvent, none of
# which carry an RLS policy today, so they need no exemption. When LoginEvent
# is swept, its prune job joins this list.
OPERATOR_LANE_ALLOWLIST=(
  "src/lib/email-log-prune-worker.ts"        # privileged end to end (null-org pool's only reaper)
  "src/lib/scheduled-emails-worker.ts"       # due-row scan + stuck sweep
  "src/lib/invoice-reconciliation-worker.ts" # PAID-without-invoice candidate sweep
  "src/lib/webinar-recordings-worker.ts"     # ZoomMeeting candidate scan
  "src/lib/webinar-attendance-worker.ts"     # ZoomMeeting candidate scan
  "src/lib/certificates/auto-issue.ts"       # survey-completed candidate sweep
  "src/lib/certificates/issue-worker.ts"     # active-run scan + stall reclamation
  "src/crm/reminders-worker.ts"              # due-task scan
  "src/crm/inbound-email-worker.ts"          # reply-token → thread resolve (the tenant is the ANSWER)
  # Added Aug 11, 2026 after review. Both were MISSED in the first pass because
  # the surface list was built job by job, and both are SIBLING modules inside
  # a job whose main module was found. Enumerate transitively from
  # worker/jobs/*.ts, not by job name.
  "src/lib/certificates/survey-thankyou-sweep.ts"  # dedup + candidate scans, which must share one lane
  "src/lib/refund-reconciliation.ts"               # stale-refund sweep (money: an empty lane reads as "nothing stuck")
  # Operator read surfaces. Both pair the lane with an RBAC wall: the queries
  # route calls denyNonOperator(); aws-ops is scope-aware and only takes the
  # privileged path for the platform view, so its caller decides the audience.
  "src/app/api/help-chat/queries/route.ts"   # operator-global captured Q&A
  "src/lib/infra/aws-ops.ts"                 # platform-scope business counters
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
# Both lane entry points count as a wrap. `runWithTenantLane` (item 5) is
# `runWithTenant` plus a warn line when the caller has no org, so a handler
# using it is just as wrapped. Matched as a regex, not a fixed string,
# because `runWithTenantLane(` does NOT contain the substring `runWithTenant(`.
WRAP_RE='runWithTenant(Lane)?\('
HANDLER_RE='export[[:space:]]+(async[[:space:]]+)?function[[:space:]]+(GET|POST|PUT|PATCH|DELETE)[[:space:]]*\('

# READ-PLACEMENT check (added after 3 sweeps shipped with a swept read placed
# BEFORE the handler's runWithTenant — inert on master, fail-closes on the
# platform; the ≥-count check above can't see placement). Matches a Prisma op on
# a SWEPT model — `<db|tx>.<model>.<method>` — precisely (the trailing method
# name means a plain property chain like `payment.registration.event` never
# matches). GROW SWEPT_MODELS as domains are swept; un-swept models (Event, User,
# session) are the ONLY reads allowed before the wrap (org resolution).
SWEPT_MODELS='registration|attendee|payment|refundAttempt|registrationSerialCounter|ticketType|pricingTier|promoCode|promoCodeRedemption|promoCodeTicketType|contact|invoice|billingAccount|mediaFile|speaker|speakerDocument|zoomMeeting|zoomAttendance|webinarPresence|webinarPoll|webinarPollResponse|webinarQuestion|crmContact|crmCompany|crmDeal|crmDealContact|crmDealProduct|crmDealDocument|crmEmailThread|crmEmailMessage|crmPipelineStage|crmProduct|crmTask|crmNote|crmActivity|crmNotification|crmEmailTemplate|crmQuoteCounter|crmEmailSendClaim|crmDealType|hotel|roomType|accommodation|abstract|abstractTheme|reviewCriterion|abstractReviewer|abstractReviewSubmission|track|eventSession|sessionTopic|sessionSpeaker|topicSpeaker|certificateTemplate|issuedCertificate|certificateIssueRun|certificateIssueRunItem|certificateSerialCounter|sessionProposal|sessionProposalTheme|rsvpCampaign|rsvpItem|rsvpInvite|rsvpResponse|surveyResponse|speakerReimbursement|speakerReimbursementDocument|emailLog|scheduledEmail|auditLog|helpChatQuery'
# `[.]` (literal-dot char class, no backslash) sidesteps awk -v escape handling.
SWEPT_OP_RE="[.]($SWEPT_MODELS)[.](findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|findMany|create|createMany|update|updateMany|delete|deleteMany|upsert|count|aggregate|groupBy)"

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
  wraps="$(count_re "$src" "$WRAP_RE")"
  if [ "$handlers" -gt 0 ] && [ "$wraps" -lt "$handlers" ]; then
    fail_header
    echo "  $rel — $handlers HTTP handler(s) but only $wraps runWithTenant( wrap(s)"
  fi
}

# READ-PLACEMENT invariant: within each HTTP handler, no swept-model Prisma op
# may appear BEFORE that handler's first runWithTenant( — else the read/write
# fail-closes on the platform (the class that shipped in Ticketing/Speaker/
# Reg-core until reviewed). Per-handler, first-op-vs-first-wrap (the realistic
# regression — an existence read then a lower wrap — is always caught; an
# intra-handler later unwrapped read after an earlier wrap is a documented
# precondition, e.g. the Stripe webhook charge.refunded branch).
check_read_placement() {
  local file="$1" rel out
  rel="${file#"$REPO_ROOT"/}"
  if out="$(awk -v RE="$SWEPT_OP_RE" -v FN="$rel" '
    function endh(){ if (inh && rl>0 && (wl==0 || rl<wl)) { printf "  %s:%d — swept-model DB op before runWithTenant: %s\n", FN, rl, rt; found=1 } }
    { line=$0; sub(/\/\/.*$/,"",line) }
    line ~ /export[ \t]+(async[ \t]+)?function[ \t]+(GET|POST|PUT|PATCH|DELETE)[ \t]*\(/ { endh(); inh=1; wl=0; rl=0; rt="" }
    inh && wl==0 && line ~ /runWithTenant(Lane)?\(/ { wl=NR }
    inh && rl==0 && line ~ RE { rl=NR; rt=line; sub(/^[ \t]+/,"",rt); sub(/[ \t]+$/,"",rt) }
    END { endh(); exit (found?1:0) }
  ' "$file")"; then
    : # clean
  else
    fail_header
    printf '%s\n' "$out"
    echo "    → open runWithTenant BEFORE the swept read (org comes from the un-swept Event/session, not the swept row)."
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
    check_read_placement "$file"
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
  check_read_placement "$abs"
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
  if [ "$(count_re "$src" "$WRAP_RE")" -eq 0 ]; then
    fail_header
    echo "  $mod — no runWithTenant( call (executors must wrap in the tenant store)"
  fi
done

# ---------------------------------------------------------------------------
# Privileged-lane check: only allowlisted files may import dbOperator.
# ---------------------------------------------------------------------------
operator_violations=0
# `--include` keeps this to source; the definition site and its own tests are
# excluded by name below rather than by pattern, so a test file that starts
# using the lane for real still has to be considered.
while IFS= read -r file; do
  rel="${file#"$REPO_ROOT"/}"
  # The definition itself, and the tests that exist to pin its behaviour.
  case "$rel" in
    src/lib/db.ts|__tests__/*) continue ;;
  esac
  # Comment-stripped, so a file that merely NAMES the lane in a docblock (the
  # guard module documents it at length) isn't treated as importing it.
  if [ "$(count_fixed "$(executable_ts "$file")" "dbOperator")" -eq 0 ]; then
    continue
  fi
  allowed=0
  for entry in ${OPERATOR_LANE_ALLOWLIST+"${OPERATOR_LANE_ALLOWLIST[@]}"}; do
    if [ "$rel" = "$entry" ]; then allowed=1; break; fi
  done
  if [ "$allowed" -eq 0 ]; then
    if [ "$operator_violations" -eq 0 ]; then
      echo ""
      echo "✗ A file imports the privileged maintenance lane (dbOperator) without being allowlisted"
      echo "  dbOperator connects as the table-owner role and bypasses EVERY RLS policy."
      echo "  (docs/PLATFORM_DECISIONS.md §5)"
      echo ""
    fi
    operator_violations=$((operator_violations + 1))
    echo "  $rel: imports dbOperator but is not in OPERATOR_LANE_ALLOWLIST"
  fi
done < <(grep -rl --include='*.ts' --include='*.tsx' -F 'dbOperator' \
           "$REPO_ROOT/src" "$REPO_ROOT/worker" "$REPO_ROOT/scripts" "$REPO_ROOT/__tests__" 2>/dev/null || true)

if [ "$operator_violations" -gt 0 ]; then
  cat <<'EOF'

  Ask first: does this surface need CROSS-TENANT data, or does it need to run
  inside the RIGHT tenant's lane? The second is far more common, and the answer
  there is runWithTenant(orgId, …), not this client.

  If it genuinely is cross-tenant by design (a worker candidate scan, an
  operator-global reader), add the file to OPERATOR_LANE_ALLOWLIST in this
  script AND pair it with denyNonOperator() if it is an HTTP route. The DB lane
  and the RBAC check are two independent walls; neither substitutes for the
  other.

EOF
  exit 1
fi

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
echo "✓ Privileged lane: dbOperator imported only by allowlisted files"
