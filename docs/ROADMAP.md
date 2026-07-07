# EA-SYS — Product Roadmap & Project Status

**Project:** EA-SYS (Event Administration System)
**Owner:** MeetingMinds Group
**Last Updated:** June 1, 2026
**Platform URL:** events.meetingmindsgroup.com

---

## Executive Summary

EA-SYS is a purpose-built, full-stack event management platform developed in-house for MeetingMinds Group. It replaces fragmented third-party tools (EventsAir, spreadsheets, manual email workflows) with a single, integrated system that the organization fully owns and controls.

The platform handles the entire event lifecycle — from public registration and payment collection through speaker management, abstract peer review, accommodation booking, on-site check-in, and post-event communications — all under one roof with a consistent, branded experience.

**Built with:** Next.js 16, TypeScript, PostgreSQL, Prisma ORM, Stripe, Claude AI (Anthropic)
**Deployed on:** AWS EC2 (t3.large) via Docker with zero-downtime blue-green deployments

---

## Platform Highlights

| Capability | Description |
|---|---|
| **Self-Service Registration** | Attendees register, pay, and manage their own details online — no manual data entry for staff |
| **Stripe Payment Processing** | Secure online payments with tax calculation, PDF invoices, and refund management |
| **Abstract Submission & Peer Review** | Full academic paper submission workflow with weighted scoring, reviewer portal, and automated notifications |
| **AI Event Assistant** | Natural language commands ("add Dr. Smith as a speaker for the morning session") handled automatically by Claude AI |
| **On-Site Operations** | Mobile QR/barcode check-in scanner, badge PDF printing, real-time attendance tracking |
| **Organization CRM** | 100,000-contact store with event history, CSV import/export, and one-click import into events |

---

## Completed Features by Phase

### Phase 1 — Foundation
*Delivered: January 2026*

- PostgreSQL database with Prisma ORM
- Secure JWT-based authentication (NextAuth.js)
- Role-based access control (7 roles: Super Admin, Admin, Organizer, Member, Reviewer, Submitter, Registrant)
- Multi-tenant organization support
- Collapsible dashboard sidebar with persistent state
- Structured logging system (Pino) with log viewer at `/logs`
- Audit logging for all admin actions

---

### Phase 2 — Event Core
*Delivered: January–February 2026*

**Event Management**
- Create, edit, publish, and manage events (Conference / Webinar / Hybrid)
- Event status lifecycle: Draft → Published → Live → Completed → Cancelled
- Per-event settings: branding, email sender, tax rates, badge layout

**Ticketing**
- Multiple registration types per event (e.g. Early Bird, Standard, Presenter, Student)
- Pricing tiers with date-based activation (Early Bird cutoffs)
- Sold count tracking and capacity limits

**Registrations**
- Admin-side registration management with search, filter, and CSV export
- Bulk registration type changes
- Registration detail slide-out with full edit capability
- Delete registration with attendee cleanup

**Check-In & Badges**
- Mobile QR code scanner (camera-based, web app — no app install required)
- Hardware barcode scanner support (auto-focused input)
- DTCM barcode import via CSV
- Badge PDF generation (server-side, Code128 barcodes, per-event vertical offset)
- Real-time attendance counter and recent scan log

---

### Phase 3 — Speaker & Program Management
*Delivered: February 2026*

**Speakers**
- Speaker profiles with photo, bio, social links, specialty, and status tracking
- Import speakers from event registrations or organization contact store
- Speaker status workflow: Invited → Confirmed → Declined → Cancelled
- Full speaker detail page with sessions and abstracts list

**Schedule**
- Color-coded track management
- Session scheduling with date validation against event dates
- Session roles: Speaker, Moderator, Chairperson, Panelist
- Per-topic speaker assignment within sessions
- Calendar view and date-grouped schedule view

**Abstract Submission & Review**
- Public submitter registration with event-scoped account creation
- Full-page abstract submission form (title, content, theme, presentation type, specialty)
- Presentation types: Oral, Poster, Video, Workshop
- Abstract status workflow: Draft → Submitted → Under Review → Accepted / Rejected / Revision Requested / Withdrawn
- Event-specific abstract themes (organizer-configured)
- Weighted review criteria per event (weights must sum to 100%)
- Reviewer portal: score, comment, recommend format, accept/reject
- Automated email notifications on status change and reviewer feedback
- Bulk email to abstract submitters (accepted, rejected, revision, reminder, custom)

---

### Phase 4 — Accommodation Management
*Delivered: February 2026*

- Hotel management with star rating and contact details
- Room type configuration with pricing and amenities
- Accommodation bookings linked to registrations
- Booking status: Pending → Confirmed → Checked In → Checked Out → Cancelled

---

### Phase 5 — Payments
*Delivered: March 2026*

- Stripe Checkout integration for paid ticket types
- Per-event tax rate and label configuration (e.g. "VAT 5%")
- Base price + tax as separate Stripe line items
- PDF invoice / proforma quote attached to confirmation email and downloadable from registrant portal
- Payment webhook handling: `checkout.session.completed`, `checkout.session.expired`, `charge.refunded`, `payment_intent.payment_failed`
- Full refund processing (admin-initiated via Stripe API; refund confirmation email)
- Complimentary registration status (admin-set; bypasses payment gate at check-in)
- Zero-decimal currency support (JPY, KRW, etc.)
- Payment status: Unpaid, Pending, Paid, Complimentary, Refunded, Failed

---

### Phase 6 — Email & Communications
*Delivered: February–March 2026*

- Dual email provider support: Brevo and SendGrid (switch via environment variable, no code change)
- Per-event sender email address and display name
- WYSIWYG email template editor (Tiptap v2) with toolbar, layout blocks (2-col, 3-col, CTA, divider), and HTML source toggle
- Email branding: per-event header image and footer HTML
- CSS inlining for email client compatibility
- Desktop/mobile preview for all templates
- Centralized Communications page consolidating all event email types in one place
- Bulk email to selected or all registrations / abstract submitters
- Automated emails: registration confirmation, payment confirmation, refund confirmation, abstract status changes, reviewer invitations, team member invitations

---

### Phase 7 — Public-Facing Pages
*Delivered: February–March 2026*

- **Public registration form** at `/e/[slug]` — smart redirect to first active pricing tier
- 2-step registration flow: account creation (email + password) → personal details + T&C
- Customizable welcome HTML and terms & conditions per event (WYSIWYG)
- Terms accepted timestamp recorded on submission
- Conditional fields: member ID required for member ticket types, student ID + expiry for student types
- **Registrant self-service portal** at `/my-registration` — view registrations, edit personal details, pay online, download invoice
- **Event-scoped login** at `/e/[slug]/login` with event branding
- **Abstract submitter registration** at `/e/[slug]/abstract/register` (separate from attendee registration)
- **Registration completion form** at `/e/[slug]/complete-registration` — token-gated form for CSV-imported registrants
- **Confirmation page** with payment status polling and Pay Now button

---

### Phase 8 — Contact Store (Organization CRM)
*Delivered: February 2026*

- Organization-wide contact database supporting up to 100,000 contacts
- Searchable by name, email, and organization
- Tag-based filtering with colored tag pills
- CSV bulk import (RFC 4180 compliant, skip duplicates, up to 5,000 rows per file)
- CSV export for all organization contacts
- Contact detail page with full event history (appearances as speaker or attendee)
- One-click import of contacts into event registrations or speakers
- Auto-sync: attendee and speaker data automatically synced back to the contact store after registration and speaker import
- Contact fields: title, photo, organization, job title, phone, city, state, zip, country, specialty, registration type, member ID, student ID, notes, tags

---

### Phase 9 — Media & Content
*Delivered: March–April 2026*

- **Organization media library** — upload JPEG/PNG/WebP images (2MB limit, magic-byte validated) for use in email templates
- **Event-scoped media library** — per-event image management with drag-and-drop upload and URL copy
- Local filesystem storage (default) with Supabase Storage as drop-in alternative
- Standalone content editor page for registration welcome HTML and abstract welcome HTML
- WYSIWYG editors throughout: email templates, event footers, registration terms, welcome messages

---

### Phase 10 — AI Event Assistant
*Delivered: April 2026*

- Natural language event management at `/events/[eventId]/agent`
- Powered by Anthropic Claude API with tool-use (agentic loop)
- Supported actions: list event info, manage tracks, manage speakers, view registrations, manage sessions, manage ticket types, send bulk email
- AI output rendered as formatted HTML with markdown support
- Streams progress to browser in real time via Server-Sent Events
- Rate limited: 20 requests/hour per user, 10 bulk emails/hour per event
- Access restricted to Admin and Organizer roles
- `paymentStatus` filter available: query "show me all paid registrations"

---

## Feature Timeline

| Month | Key Milestones |
|---|---|
| **January 2026** | Platform foundation, authentication, RBAC, dashboard UI, event management, ticket types |
| **February 2026** | Registration management, check-in scanner, badge printing, speaker management, schedule/calendar, abstract submission and review, accommodation management, contact store (CRM), photo uploads, country/city fields, reviewer portal, reviewer invitation system |
| **March 2026** | Stripe payments, tax configuration, PDF invoices, public registration (2-step), registrant self-service portal, event-scoped login, WYSIWYG email editor, email branding, centralized communications page, bulk email, SendGrid integration, session topics with per-topic speakers, session roles, org primary color theming, complimentary payment status, barcode system overhaul, badge type support, payment-gated check-in, signup notifications, state/zip fields, terms acceptance timestamp, CSV import → registration completion flow |
| **April 2026** | AI event assistant (Claude), event-scoped media library, Stripe refunds, abstract expansion (Video/Workshop types, Withdrawn status, recommended format), weighted review criteria, abstract themes, MEMBER role (read-only), sidebar reorganization, markdown rendering for AI output |

---

## Current Release — July 7, 2026

### Per-event ONSITE staff (shipped) — deferred review follow-ups

Per-event ONSITE registration-desk staff shipped (`893d3b3`) + the adversarial-
review BLOCKER fix (`93deed7`, cross-event isolation on the 5 desk routes). See
[docs/ONSITE_PER_EVENT_PLAN.md](ONSITE_PER_EVENT_PLAN.md). Deferred, non-blocking
review findings (BLOCKER already fixed; these are HIGH-cosmetic / MED / LOW):

- **H1 (cosmetic post-fix)** — the middleware confines ONSITE to
  `/registrations*`/`/check-in*` but not to *assigned* events. Now that the API
  404s an unassigned event (B1–B4 fix), navigating there loads an empty shell
  instead of redirecting. Fix: make the registrations page server component 404
  when `buildEventAccessWhere(user, eventId)` returns nothing, so the UI matches
  the API. **Not a security issue** — the API is the authoritative gate and it's
  closed.
- **M1** — deleting an ONSITE account via `DELETE /api/organization/users/[userId]`
  leaves stale ids in every event's `onsiteUserIds` (cosmetic; cuids aren't
  reused; the Settings-tab delete already strips-first, but a direct API call
  doesn't). Fix: on ONSITE account delete, sweep `onsiteUserIds` org-wide.
- **M2** — ORGANIZER (not just ADMIN) can assign existing ONSITE users to events
  (creating the account is ADMIN-only). Confirm intended. The create+assign UI
  flow (POST users → N× POST assign) has no partial-failure rollback — surfaces a
  warning toast but leaves an unassigned account on partial failure.
- **L1/L2** — `updateUserSchema` role enum omits ONSITE/MEMBER (can't PUT-change
  to ONSITE, only invite/promote); org onsite-staff GET over-fetches full
  `settings` JSON per event to read one array.

## Previous Release — June 30, 2026

### Scheduled email — "one-shot, late-inclusive" + fixed `recipientIds` overlook

- **Behavior:** a scheduled email now reliably reaches people who register *after* it is scheduled. Filter-based scheduled sends already re-resolved recipients at fire time; this makes that the explicit, recommended default and closes the gap where a row-selected schedule froze the audience.
- **Overlook fixed:** the schedule-create route (`POST /api/events/[eventId]/emails/schedule`) **parsed `recipientIds` but never persisted it** — only the immediate-send route did. So every scheduled send silently fell back to filter-based, and a "schedule to these N ticked rows" actually fanned out to **everyone matching the filters** at fire time (often *all* registrations when no filter bar was active) — an over-send risk on a live system. Now the route writes `recipientIds` (and exposes it on GET).
- **UX:** `src/components/bulk-email-dialog.tsx` — when scheduling from a row selection, an explicit choice (default **"Everyone matching the current filters at send time"** = late-inclusive, drops the ids; alt **"Only the N selected (fixed list)"**). "Email All" schedules show a "✓ includes new registrations" note. `scheduled-emails-list.tsx` labels each row **"matching at send time"** vs **"N fixed"**. "Send now" unchanged.
- **No schema/migration** (`ScheduledEmail.recipientIds` already existed). New test `__tests__/api/scheduled-email-create.test.ts`. Full design in [docs/SCHEDULED_EMAILS.md](SCHEDULED_EMAILS.md) §4; user guide `public/user-guide.html` §9.

---

## Previous Release — June 29, 2026

### Communications filters + Activity edit-history + public SEO + Add-form parity + faculty data fix

- **Bulk-email audience filters (registrations).** "Send Bulk Email" dialog (registrations-list "Email All" + Communications page) gained in-dialog **multi-select** filters in a collapsible "Filter recipients" section: Payment status + **Registration type** (`ticketTypeIds`, `in`) + **Badge type** (`badgeTypes`, `in`) + **Tags** (`tagsInclude`, `hasSome`). OR-within-field / AND-across; empty = no restriction. Wider 4xl dialog, 3-up layout, "or"-joined recap, footnotes. Fixed a real bug: the list's "Filter by tag" was never passed to Email All (silently ignored). Backend `src/lib/bulk-email.ts`; UI `src/components/bulk-email-dialog.tsx`. Count==send preserved. Adversarially reviewed (0 blocker/0 high).
- **"Exclude faculty / speakers" toggle + single filter surface.** One-click `excludeFaculty` checkbox (registrations `where` spreads `EXCLUDE_FACULTY_WHERE` = `NOT ticketType.isFaculty`) → email delegates only. The Communications page's duplicate single-select registration Advanced-filters block was **removed** — the dialog is now the single registration-filter surface (Speakers card keeps its own filters). Plus a cerulean color pass + an Email-Type trigger height fix (same-variant override of the base `data-[size=default]:h-9`).
- **Activity edit-history diffs.** Registration + speaker Activity timeline now renders field-level before→after diffs from `AuditLog.changes` (incl. nested attendee), finance-redacted for non-finance roles (`src/lib/activity-feed.ts`). **Dedup follow-on:** shared `ActivityItem`/`ActivityFieldDiff` types extracted to a client-safe `src/lib/activity-feed-types.ts` (was declared in both the lib + the card); and the two *global* audit feeds (`components/activity-feed.tsx` + `(dashboard)/activity/global-activity-feed.tsx`) now share `src/components/activity/audit-log-display.ts` (icon/colour maps + `describeAuditAction`/`auditActorLabel`) instead of byte-identical copies — the components stay separate (not merged).
- **Public SEO metadata.** Per-event OpenGraph/Twitter + per-section titles on `/e/[slug]/*` via server `layout.tsx` + `buildEventMetadata` (`src/lib/public-event-metadata.ts`). **Follow-up:** slug lookups are org-unscoped — add `organizationId` when multi-tenant lands (`docs/MULTI_TENANCY_IMPACT.md`).
- **Add Registration ↔ Add Speaker parity.** Both forms share one personal section via `PersonFormFields` (speaker form was dropping Phone). Frontend-only.
- **Faculty registration-type correction (prod backfill, audited).** 33 legacy companion attendees with `registrationType="Faculty"` → 3 restored to the speaker's profession, **30 defaulted to "Physician"**. Faculty designation (`badgeType` + `isFaculty` ticket type) untouched; live companion-creation path unchanged. Review the defaulted set via Badge=Faculty + Type=Physician.
- **Speaker phone/additionalEmail enrichment (prod backfill, audited, enrich-only).** Fills blanks from the counterpart registration's attendee; 1 row enriched.
- **scheduled-email 0-recipient → benign skip** (terminal SENT/0, info log; not a paging FAILED). Smaller: removed confirmation-page "Back to Event" button, deleted orphaned `docker/Dockerfile`, sidebar `w-64→w-56`.

**Deferred follow-ups:** tag-value-**exclude** (skip a specific tag) + attendance-mode bulk-email filters (the "exclude faculty/speakers" exclude is shipped); a "Faculty vs delegate" review tile; per-recipient deselect in the bulk dialog; SEO `noindex` on transactional public pages (login/confirmation) + editorial meta-title override.

## Current Release — April 22, 2026

### Services Refactor (Phases 0 + 1 + 2a + 2b shipped; 2c deferred into Phase 3)

Shared domain logic moved out of route handlers into a new `src/services/` layer so REST routes, MCP agent tools, and the upcoming external API can all share one implementation per domain. This eliminates silent side-effect drift between entry points — the class of bug that caused paid registrations created via the Claude agent to miss their confirmation emails before the fix.

- **Phase 0 — MCP parity fixes (shipped).** Confirmed drift patched directly in the MCP tools: paid `create_registration` now fires the confirmation email + quote PDF, defaults `paymentStatus` to `UNASSIGNED` (paid) / `COMPLIMENTARY` (free), atomically increments `soldCount`, generates `qrCode`, enforces sales-window + `requiresApproval`, syncs to Contact store, writes audit log, notifies admins. Same treatment for `create_speaker`. Bulk variants get atomic increments, `qrCode` generation, and a single batched admin notification per call.
- **Phase 1 — Foundation (shipped).** `accommodation-service.ts` centralizes the atomic overbooking guard previously duplicated across REST + MCP. Conventions locked in (errors-as-values, typed-Date inputs, caller-identity via `source`, service-owned side effects). `src/services/README.md` documents the full pattern for future extractions.
- **Phase 2a — Abstract (shipped).** `abstract-service.ts` centralizes the `requiredReviewCount` gate, WITHDRAWN terminal-state guard (REST tightening), and reviewer notification fan-out with isolated failure handling.
- **Phase 2b — Speaker (shipped).** `speaker-service.ts` centralizes single-create speaker logic. Empty-string field normalization as safety net for future direct-to-service callers.
- **Phase 2c — Registration (deferred into Phase 3).** Originally planned as the third Phase-2 extraction. Phase 0's in-place patches already eliminated the confirmed drift bugs, so the remaining value is future-facing. The extraction is better done alongside the external public REST API (Phase 3) so the service shape is informed by a real third caller.

### Invoice & PDF Polish (April 22)

Companion fixes discovered during paid-registration testing:

- **Receipt PDF attachment email now fires after payment.** `createReceipt` / `createInvoice` / `createCreditNote` used to throw on missing `event.code`, silently killing the Stripe webhook's fire-and-forget invoice creation. Now reuses the shared `deriveEventCode()` helper + fire-and-forget backfill, so legacy events without a code still get proper invoice numbering.
- **"Confirmation Number" terminology unified.** Three registrant-facing emails (registration / payment / refund) now all use "Registration #" with the same padded serial — no more two different values under the same label. Payment email adds a distinct "Payment Reference" row with the Stripe PaymentIntent id.
- **"View Invoice" button is honest.** When no Invoice row exists, button now says "Download Quote" (what you actually get) instead of "Invoice".
- **Quote PDF right-side box widened.** Billing email/phone no longer wrap + collide. Fix applies to all four PDF types (Quote, Invoice, Receipt, Credit Note) via the shared layout helpers.

---

## Previous Release — April 2, 2026

The following features shipped in the most recent release:

**Event-Scoped Media Library**
Organizers can upload and manage images per event, accessible from the event sidebar under Tools. Images can be inserted directly into email templates.

**Stripe Refund Processing**
Admins can issue full refunds from the registration detail panel. The system sends a refund confirmation email to the attendee, updates payment status automatically, and handles refunds initiated directly in the Stripe Dashboard via webhook.

**Abstract System Expansion**
- Added Video and Workshop as presentation types
- Submitters can now withdraw their abstracts
- Reviewers can recommend a format (Oral / Poster / Neither)
- Organizers can configure event-specific abstract themes
- Weighted review criteria with automatic score calculation

**MEMBER Role**
A new read-only role for stakeholders who need dashboard visibility without write access.

---

## Planned Future Features

The following items are candidates for the next development phases. Priorities can be adjusted based on business needs.

### Billing payers — inline-entry follow-ups (June 29, 2026)

Shipped: event-level **inline payer create** from the registration Charge-to picker (full-page Add Registration form) with org-level consolidation — `findOrCreateBillingAccount()` (exact-name reuse; near-duplicate → create + flag `needsReview`), event-scoped `POST /api/events/[eventId]/billing-accounts` (find-or-create + auto-attach junction), reusable `AddPayerDialog` + `useCreateAndAttachBillingAccount`. The reusable dialog makes these follow-ups cheap:

- **Inline create on the other two payer surfaces** *(S each)* — drop `AddPayerDialog` into (a) the registration **detail-sheet reassign** picker and (b) the **quick-add registration dialog** (which today has no payer picker at all — needs the picker first, like its pre-existing pricingTier/sponsor gap). Same component, same hook.
- **Admin merge UI for `needsReview` payers** *(M)* — Settings → Billing "possible duplicates → merge" flow: pick a survivor, **re-point** every `Registration.billingAccountId` + `EventBillingAccount` from the duplicate to it inside a `$transaction`, then delete the duplicate, clear `needsReview`. Today the flag is set but there's no merge action (admins can only soft-delete/edit). Needs careful re-pointing + an audit row.
- **Optional niceties** *(S)* — a "Payer" column + filter on the registrations list/CSV; surface `needsReview` count as a badge in Settings → Billing; public-registration "who pays" step (schema/route already carry the fields).

### Promo-on-existing-registration — deferred review findings (July 1, 2026)

Adversarial review of the "apply/remove a promo code against an existing registration" feature returned **fix-then-ship, 0 blockers**. HIGH #1 (the "Free registration" price-resolution bug — `originalPrice` stamping) and HIGH #2 (the per-email TOCTOU race — `SELECT … FOR UPDATE` row lock) were **fixed + shipped**. The rest were deferred by product decision, all independently shippable:

- **MEDIUM — 100%-off code strands the registrant's own Remove button.** In `/my-registration`, `isComplimentary = paymentStatus === "COMPLIMENTARY" || netPrice === 0`, and the promo apply/remove UI lives inside the `showPayment` block. A promo discounting to net 0 hides that block, but `paymentStatus` stays UNPAID → the registrant can't self-remove the code to correct a mistake (the organizer still can). Fix: render the Remove control whenever a promo is applied and the reg is outstanding, independent of `netPrice`.
- **MEDIUM — fragile `replaced` flag.** `promo-code-service.ts` derives `replaced` from the pre-apply `reg.promoCodeId` rather than each branch setting its own flag. Currently correct (only affects a toast/audit boolean); a future branch edit could silently desync it.
- **LOW — `discountValue` sign/cap not validated at apply.** A negative or >100% `discountValue` (bad admin/MCP data) yields a negative discount (surcharge) / a discount > base. FIXED_AMOUNT is `Math.min`-clamped but not floored at 0; PERCENTAGE isn't capped. Fix: `Math.max(0, …)` on the computed discount + cap PERCENTAGE at 100 at write time.
- **LOW — register-route promo ordering.** The public register route increments `usedCount` *before* the per-email check — safe only because it's inside the `$transaction` (a throw rolls it back). Reorder for clarity so a future non-transactional refactor can't leak `usedCount`.
- **Product call — MEMBER sees the applied promo *code*.** `promoCode`/`promoCodeId` aren't in `FINANCIAL_KEYS`, so the read-only MEMBER role sees the code + that a discount exists (the *amount* is redacted). Inconsistent with the sponsor/billing-account redaction posture. Decide whether to add them to `FINANCIAL_KEYS`.
- **Coverage — unstamped `originalPrice` create paths (2 remaining).** HIGH #1 stamps `Registration.originalPrice` at the public-register, registration-service, speaker-companion, and MCP-bulk create paths. **`import-contacts` now stamps it too** (July 2, `fa36ba7` — with the new pricing-tier prompt: tier price, else base price). Still unstamped: the **CSV import** and **EventsAir import** paths — new rows there get null `originalPrice` and rely on the read-fallback (correct for tier'd/flat rows; the one edge left is a *new* VIRTUAL reg created via CSV, which would fall back to the in-person price). No backfill was run (forward-looking fix), so pre-July-1 rows also rely on the fallback until re-created.

### Data-loss audit — residual follow-ups (June 29, 2026)

From the concurrency/data-loss sweep (most fixes shipped: contact-sync + EventsAir import enrich-only, MCP accommodation atomic re-book, bulk-type + import-contacts oversell guards, and the `updateEventSettings`/`updateOrganizationSettings` atomic settings helper). Two review-flagged residuals, both LOW/MED real-world risk (admin single-actor flows), left as tracked follow-ups so the settings-migration commit didn't balloon:

- **MED — cross-field atomicity in the split settings PUTs.** `event PUT`, `org PUT`, and the cert-settings routes (REST + MCP) now write the `settings` blob via the atomic helper and the **scalar columns** (name/dates/cmeHours/etc.) via a separate `db.*.update` — two sequential writes. A crash/error *between* them leaves a partial update (settings persisted, scalars not, or vice-versa); the original single-`update` was atomic across both. Fix: give the helper an optional `tx` param and wrap the scalar update + settings merge in one `$transaction` per caller (settings-merge first so the scalar update returns the merged row for the response). Low risk (admin single-actor; window is a crash between two awaits).
- **LOW — `settings.webinar` sub-key last-write-wins.** The webinar PUT / provisioner / MCP webinar tools read `settings.webinar`, spread a sub-patch, and write the whole `webinar` key via the object-form helper. Cross-*top-level*-key clobber is fixed, but two concurrent edits to *different sub-keys of `webinar`* (e.g. `lobbyMessage` vs `viewingMode`) still lose one. Fix: use the helper's function-form to read `cur.webinar` inside the lock and merge there. Pre-existing; concurrent webinar-settings edits are unlikely.

### Reviewer/submitter lifecycle audit — open findings (June 26, 2026)

A 3-agent end-to-end trace of the reviewer + submitter + crossover flows. **Two production-breaking HIGHs were fixed in-session** (commit pending): self-registered submitter-speakers now mint a companion registration (badge/check-in/survey/cert), and resubmit-after-revision now re-stamps `submittedAt` + emails the author + notifies organizers. The rest are tracked here:

| Finding | Sev | Effort | Notes |
|---|---|---|---|
| ~~**Pool reviewers never told there's work; per-abstract reviewers card omits pool members**~~ ✅ SHIPPED June 26 | HIGH | M | A pre-existing reviewer account added to the pool now gets a `reviewer-pool-invitation` email ("you're a reviewer for X", link to `/my-reviews`) via `notifyReviewerPoolAdded` (new accounts still get the account-setup invite). The "card omits pool members" half was a **FALSE POSITIVE** — `AbstractReviewersCard` already merges `useReviewers` (pool) + `useAbstractReviewers` (per-abstract) client-side (the audit agent only saw the GET route, which is one of two data sources the card combines). |
| **No reviewer reminder mechanism** ⭐ NEXT PICK | HIGH | M | Unlike payment/agreement chases, no way to nudge reviewers who haven't submitted. Can't drive a review round to completion in-product. **All prerequisites now shipped** (assignment + pool notifications + resend + a `reviewer-assignment`/`reviewer-pool-invitation` template pattern to reuse). **OPEN DECISION before building — where does the "chase pending reviewers" action live?** (a) a bulk **"Remind pending reviewers"** button on Settings → Reviewers (event-wide — emails every pool/assigned reviewer with an unsubmitted review), (b) a **per-abstract nudge** on the `AbstractReviewersCard` (remind only the reviewers assigned to *this* abstract who haven't submitted), or (c) both. Likely reuses a new `reviewer-reminder` email template + the `/my-reviews` link + a per-user/per-event rate limit. Resume here. |
| ~~**Per-abstract assignment sends no notification**~~ ✅ SHIPPED June 26 | HIGH | S | Both REST `POST .../reviewers` and MCP `assign_reviewer_to_abstract` now call `notifyReviewerAssigned` (shared helper, new `reviewer-assignment` email template) on a **new** assignment — emails the reviewer the abstract title + role + a link to `/my-reviews`. Failure-isolated; not re-sent on role/COI flips. +5 tests. |
| **Accepted-abstract → "you're presenting" handoff is 100% manual** | HIGH | L | ACCEPTED only flips status + emails a notice with no what/when/where; no link to a session. **Product call needed** — may be intentionally manual; at minimum the acceptance email could say "you'll be scheduled". |
| ~~**Saving a DRAFT abstract emails a "submission confirmation"**~~ ✅ SHIPPED June 26 | HIGH | S | `abstracts/route.ts` POST fired the confirmation email **and** the "New Abstract Submitted" admin notification for both SUBMITTED and DRAFT. Both now gated on `status === "SUBMITTED"` — a draft-save is silent (it isn't submitted + is invisible to reviewers). |
| ~~**COI `conflictFlag` is advisory only — not enforced**~~ ✅ SHIPPED June 26 | MED | S–M | A reviewer flagged conflicted on an abstract is now **blocked from submitting a review** (403 `CONFLICT_OF_INTEREST`) across all three paths: REST submissions POST, MCP `submit_abstract_review`, MCP `admin_submit_review_on_behalf` (checks the target reviewer's flag). +3 route tests. **Note:** they can still *read* the abstract (GET) — hard-gating read access is a possible follow-up; and a conflicted reviewer simply submits nothing, so the `requiredReviewCount` quorum is unaffected by their (now-blocked) review. |
| ~~**Reviewer-invite email failure is silent + no "resend invitation"**~~ ✅ SHIPPED June 26 | MED | S | New `POST .../reviewers/[reviewerId]/resend-invitation` + a "Resend" button on each pending reviewer row. Pending account → re-mints a fresh setup token + resends the setup invite; active account → resends the pool reminder. Unlike the silent add path, a send failure **surfaces** as a 502 (`EMAIL_SEND_FAILED`) so the organizer knows. 20/hr/user rate limit, audited. +4 route tests. |
| **`feedbackOnly` notification is dead code** | MED | S | A reviewer adding notes without a status change never notifies the author (the `feedbackOnly` branch in `notifyAbstractStatusChange` is never invoked). |
| **Mean review score (0–100) shown to submitters** | LOW | S | Product decision — many CFP systems hide raw scores and show only the decision + notes. |
| **Dead `eventSlug` in reviewer invite link; no "my submissions across events" home; coarse `NEEDS_UPDATE`; orphaned reviewer accounts accumulate** | LOW | — | Minor UX/cleanup items. |
| **Authors can't edit a REVISION_REQUESTED abstract** | LOW | XS | July 2: per organizer request, submitters can now edit/withdraw only while their abstract is **DRAFT** — once submitted it's locked and they contact the organizer ([abstracts/[abstractId]/route.ts](../src/app/api/events/%5BeventId%5D/abstracts/%5BabstractId%5D/route.ts) `SUBMITTED_LOCKED`; edit page `canEdit = isSubmitter ? DRAFT : editableStatuses`). **Consequence:** a `REVISION_REQUESTED` abstract is also locked to the author, so a reviewer asking for changes needs an organizer to reopen it (or the author emails the team). If authors should be able to self-edit when a revision is *explicitly requested*, it's a **one-line tweak** — allow `["DRAFT", "REVISION_REQUESTED"]` for submitters in both the edit page `canEdit` and the server submitter block. Left as a deliberate product call. |


### Backlog — prioritized pick list (June 24, 2026)

A single scannable view of what's workable, in priority order. Each item links to
its detailed entry in the sections further down. Effort: **S** ≈ <½ day, **M** ≈
½–2 days, **L** ≈ multi-day. Sev = correctness/security severity where it applies.

**✅ Closed this session (June 23–24, 2026) — do NOT re-pick** (detailed entries struck through below):
- Accommodation overbooking TOCTOU (HIGH) — atomic claim shipped.
- Registration DELETE destroys shared Attendee (HIGH) — sibling guard shipped.
- Stripe post-payment fire-and-forget (HIGH) — invoice-reconciliation worker shipped (the stronger in-tx "outbox" variant remains optional).
- ~8 silent `safeParse`→400 (MED) — June-23 sweep found 0 remaining (claim was stale).
- Webinar 404 alert noise (recording + attendance/engagement) — suppressed + give-up shipped.

**P1 — Correctness / security debt still open** (pick first; none is a feature):
1. ~~**`PricingTier.soldCount` double-leak** (HIGH)~~ ✅ **SHIPPED June 29, 2026.** The seat model ([registration-seat.ts](src/lib/registration-seat.ts)) is now tier-aware: `seatCounter(row)` routes a seat to the **tier** (`createdSource === PUBLIC_REGISTER && pricingTierId`) or the **ticket type**; `planSeatTransition` returns a `SeatCounter`. Guarded appliers ([registration-seat-db.ts](src/lib/registration-seat-db.ts)) `releaseSeat`/`releaseSeats` (never < 0) + `claimSeat` (atomic capacity guard) applied at all 5 decrement/transition sites (REST PUT cancel/reactivate/type-change, REST DELETE, bulk-type, MCP `update_registration` + `bulk_update_registration_status`); refund is a no-op. Type-change nulls the stale `pricingTierId` on both the transition and the persisted row. DELETE/bulk also picked up the latent virtual-reg counter bug. The seat model also excludes **speaker companions** (`createdSource === SPEAKER_COMPANION`) — faculty are uncapped + created with no soldCount increment, so they consume no counter (mirrors create; the prod dry-run caught the script otherwise inflating every event's Faculty counter). One-time **reconciliation script** [scripts/reconcile-soldcounts.ts](scripts/reconcile-soldcounts.ts) (reuses the same helpers — can't drift; dry-run default, `--write`, `--event`, `--exclude <ids>`). Adversarial review = SAFE TO SHIP, 0 new bugs. **DATA REPAIR DEFERRED:** `soldCount` is effectively **dormant today** — almost all events are unlimited-seat, so nothing enforces these counters yet; the leak's live impact is ~nil. The code fix is the future-proofing for **when capacity limits matter (multi-tenancy)**. The prod `--write` is therefore **held** — re-run the dry-run when capacity enforcement / multi-tenancy lands (data will have moved on) and decide the legacy-row policy then. **MED-1 (pre-existing):** legacy public+tier rows created before 2026-06-05 have `createdSource = NULL` → routed to the ticketType counter; a `--write` shifts their counts tier→ticketType (June-29 prod dry-run: ~7 such rows on OSH Monthly Meeting + 1st Heart Failure Forum). Use `--exclude` to skip events pending that A/B (keep-on-tier via a `createdSource` backfill) decision.
2. **`abstractTitle` not HTML-escaped in cert email** (MED, stored-XSS) — ~5 LOC + test. *(S)* → Certificates deferred findings
3. **`refreshEventStats` lost-update** (MED) — serialize per-event. *(M)* → Audit Hardening
4. **Money rounding divergence** (MED) — payment-confirmation email ignores discount/round2. *(S)* → Audit Hardening
5. **Frontend silent failures** (MED) — bulk-tag toast, registrant-portal fetch-error, MEMBER 403 buttons. *(M)* → Audit Hardening
6. **Add-Registration dialog vs full-page drift** (MED) — dialog drops pricingTier/sponsor. *(M)* → Audit Hardening
7. **MCP finance boundary / OAuth role snapshot** (MED). *(M)* → Audit Hardening
8. **Blue-green migration guardrail** (MED) — CI reject destructive SQL w/o EXPAND_CONTRACT_OK. *(S)* → Audit Hardening

**P2 — Quick wins (small, visible UI/feature gaps):**
9. **Abstract → Session linking (UI)** *(S)* · 10. **Room-Type Edit/Delete UI** *(S)* · 11. **Accommodation Booking UI** *(M)* · 12. **Registration Delete button (UI)** *(S)* · 13. **Survey-completed column + filter in the registrations list** *(S, detail-sheet display already shipped)* · 14. **Cert cosmetics cluster** (`handleNudgeY` ref, "Cert" pill baseline, dev-sentinel-in-prod, `?.` on resend) *(S each)* → Near-Term + Certificates deferred findings

**P3 — Larger features / follow-ups:**
15. **Sent-email content preview** ("see what was sent" — `bodyHtml` + View) *(M)* → Near-Term
16. **Hybrid attendance** — ✅ admin virtual↔in-person **qrCode minting + seat-accounting** SHIPPED June 26 (see Hybrid follow-ups below). Still open: check-in UI hide for virtual, dashboard in/virtual split, portal mode display, tier-windowed virtual pricing *(M)* → Hybrid follow-ups
17. **Charge-to-account v1.1** — public "who pays" step, payer column/CSV, quote-email-to-payer *(M)* → Charge-to-account follow-ups
18. **Webinar waiting-room follow-ups** — never-opened-room warning, save-time HLS validation, DRAFT-auto-open hint *(S–M)* → Webinar follow-ups
19. **Waitlist Management** *(M)* · 20. **Analytics Dashboard** *(M)* → Near-Term

**P4 — Refactor / cleanup / resilience (trigger-driven):**
21. **Resilience helper** (`withTimeout`/`withRetry`/`CircuitBreaker`) + cheap `?connect_timeout=15` precursor *(M)* → Near-Term
22. **Dead-code cleanup** — ~150 LOC commented email providers · half-extracted `AiProvider` · Vercel vestiges *(S–M)* → Abstraction cleanup
23. **registration-detail-sheet refactor** steps G→H (only when it passes ~3k lines) *(L)* → refactor remainder

**P5 — Infra hardening (deferred from INC-001):**
24. **CI → ECR build, box pulls** (HIGH — the OOM root-cause fix) *(M, + operator AWS steps)* · 25. container `mem_limit` *(S)* · 26. mem/disk CloudWatch alarm *(S)* · 27. external `/api/health` uptime check *(S)* → Deploy/Infra Hardening

**Sequenced big programs (locked order, runs around the above):** Core Stability passes → **Certificates** (multi-role + speaker-as-attendee + survey-auto-issue all SHIPPED June 25 — see below) → **Stripe live-mode** → **Multi-Tenancy / White-Label** (next major program).

**Speaker-as-attendee + multi-role certificates — SHIPPED June 25, 2026** (Phases 0–2; plan: [docs/SPEAKER_AS_ATTENDEE_PLAN.md](SPEAKER_AS_ATTENDEE_PLAN.md)). Speakers auto-get a comp "Faculty" companion registration (badge/barcode/DTCM/check-in/survey; excluded from delegate counts via `EXCLUDE_FACULTY_WHERE`); certs are now **per-template** so one person holds several role certs (Speaker + Moderator + Committee), each with its own role label + manual CME hours (`{{role}}`/`{{cmeHours}}`). **Phase 2 SHIPPED (survey-gated auto-issue, pkg 0.4.11):** completing the survey auto-issues flagged templates **fully automatically** (rendered + emailed, no operator click). Per-template `autoIssueOnSurvey` + `autoIssueTag` (REST + MCP + editor); cert-worker sweep off `Registration.surveyCompletedAt`/`certAutoIssueCheckedAt` (survey POST untouched); routing attendee-tags→ATTENDANCE→registration, speaker-tags→APPRECIATION→speaker; reuses `CertificateIssueRun` (new `autoIssue` flag, nullable issuer, skip AWAITING_REVIEW); idempotent (per-template uniqueness + guard); **retry/backoff** (1/5/15/60/180min, give up after 5) + **analytics** endpoint + card + a CME-accredited badge on the certs page. CME stays a derived event attribute (`Event.cmeHours`/accreditations) independent of cert issuance — non-CME events render blank CME tokens. Known limit: a reg is swept once (flag templates before surveys; else manual Issue). **Phase 3** = manual override (mostly exists — verify per-template-uniqueness compat).

**Phase 2 fast-follow — deferred review findings (June 25, 2026).** Adversarial + performance reviews ran pre-commit; **no blockers** (the "double-email" finding was a verified false positive — `CertificateIssueRunItem.issuedCertificateId @unique` makes the losing item fail-at-link, never email). Deferred, all independently shippable:
- **H2 (correctness) — ✅ SHIPPED June 26 (`reclaimStalledRuns` is now autoIssue-aware):** the cert worker's stall-reclaim bounced a stalled `SENDING` run → `AWAITING_REVIEW`, which a manual run resumes via the operator Send click — but an **auto run has no operator**, so a survey-gated run whose email phase stalled >10 min (SES outage / container restart mid-send) was stranded un-emailed (reg already terminally stamped → sweep won't re-enqueue → silent non-delivery). Now `reclaimStalledRuns` partitions the SENDING reclaim: manual (`autoIssue: false`) → `AWAITING_REVIEW` as before; auto (`autoIssue: true`) → stay `SENDING`, just refresh `lastTickAt` so the next tick re-drains the remaining `emailedAt`-null items (send phase is re-entrant). +2 unit tests.
- **Perf (sweep N+1):** `runAutoIssueSweep` does ~350 queries/tick at batch 50 (per-reg: up to 2 `speaker.findFirst` + per-target `issuedCertificate.findFirst` + `runItem.findFirst` inside the tx) → ~5 hr wall-clock to drain a 5000-all-survey backlog. It's **serial within one advisory lock** (1 connection at a time → not the concurrent contention that caused the P2024 incident), so it's a wall-clock not pool-exhaustion concern. Fix: batch the speaker lookup + the existence probes per tick (one `findMany` keyed by recipient IDs), and/or raise `SWEEP_BATCH_SIZE`.
- **M2 (perf, cheap):** the new partial index keys on `(eventId)` but the candidate query orders by `surveyCompletedAt` + gates on `certAutoIssueNextAttemptAt` — re-key to `surveyCompletedAt` (or `(certAutoIssueNextAttemptAt, surveyCompletedAt)`) under the same partial predicate so the ORDER BY is index-served during a large backlog drain.
- **M1 (perf, cheap) — ✅ poll half SHIPPED `2405a84` (June 26, 20s→60s + staleTime 30s); index half still deferred:** the `AutoIssueAnalyticsCard` polls 8 aggregates; some (`resolved`/`gaveUp` counts, `recentErrors`, the `certsAutoIssued` join) aren't served by the pending-only partial index → still TODO: add `(eventId, surveyCompletedAt)` (+ index `CertificateIssueRun.autoIssue`).
- **Minor/dormant:** legacy `/api/cron/certificate-issues` runs the sweep without the worker's advisory lock (dormant — crontab disabled, worker sole runner; idempotency net holds); tag matching is exact (no case/whitespace normalization — a `Speaker` vs `speaker` tag silently issues nothing); tagless-template terminal-stamp (documented known limit).

---

### Sequencing (locked June 1, 2026)

Two events have gone live (registration-only — Stripe is sandbox). Before
the next feature streams land, the **Core Stability Program**
([docs/CORE_STABILITY.md](CORE_STABILITY.md)) introduces a monthly checklist
+ kaizen burndown of the audit-hardening backlog. Order is firm:

1. **Core Stability Pass #1** — must close ≥ 1 HIGH, all gates green, no
   new HIGH severities.
2. **Certificates** — attendance / presenter / poster certificates with
   automated post-event email. Reuses the HTML→PDF renderer, bulk-email
   per-recipient attachment pipeline, and inline-CID email path.
   See [docs/CORE_STABILITY.md](CORE_STABILITY.md) §Sequencing decision.
3. **Core Stability Pass #2** — runs after certificates ships, before
   payment-live.
4. **Stripe live-mode activation** — payment verification + go-live
   switch. Sandbox keys → live keys; webhook secret rotation; reconciler
   cron for the documented HIGH backlog item ("Stripe post-payment
   side-effects are fire-and-forget"); first-paid-customer rehearsal.
5. **Core Stability Pass #3** — runs after payment-live, before any next
   feature stream.

> **Next major program after the Certificates module: Multi-Tenancy / White-Label
> SaaS** (decided June 24, 2026 — see the dedicated section below). It is the
> designated next feature stream once the certificate work lands; the interim
> stability/Stripe-live passes above still apply.

### Multi-Tenancy / White-Label SaaS (next major program — after Certificates)

*Added June 24, 2026. The next big effort after the Certificates module.* External
demand to white-label EA-SYS so other companies run their events under their own
domain + branding + integrations + money. **Two reference docs are already written
— read both before scoping:**
- **[docs/MULTI_TENANCY.md](MULTI_TENANCY.md)** — the *conceptual* reference: tenancy
  models (Pool/Bridge/Silo), RLS on Prisma+Supabase, Stripe Connect, per-tenant
  observability, ops, a real cost model, security, phased roadmap.
- **[docs/MULTI_TENANCY_IMPACT.md](MULTI_TENANCY_IMPACT.md)** — the *codebase-grounded*
  Impact & Blast-Radius assessment (from a 3-lens read-only audit): where single-org
  assumptions live + what breaks/leaks if done wrong, with a subsystem impact table,
  blast-radius ranking, and breaking-vs-additive migration sequencing.

**Verdict:** well-disciplined for single-org, but **far from safe tenant isolation
today — 0 RLS, isolation by-convention only.** This is **months of foundational
work, not a hardening pass.**

**Biggest blast-radius items (the work):**
1. **No RLS + 25 of 33 tenant tables have no `organizationId` column** (scoped only
   via `eventId`) — RLS needs join-policies or denormalization. The central project.
2. **Systemic public `where:{slug}` with no org filter** (~15 routes + lobby/stream
   micro-caches) — `Event.slug` is unique only *per-org*, so this is "correct by
   accident" and becomes a **cross-tenant public-page leak the instant a 2nd org
   exists.** The #1 latent bug.
3. **`User.email` global-unique** — the hardest identity call (recommend: shared
   `User` + a `Membership` join table, preserving the cross-org reviewer; full
   per-tenant user rows can't be migrated in one step on a live payments DB).
4. **193 `organizationId!` assertions + IDOR-by-convention** — durable fix = RLS + a
   CI lint (audits keep finding these).
5. **Stripe single-account → Connect**; plus per-tenant **email (no DKIM) / storage
   (not isolated) / logging (no tenant tag) / rate-limiting (in-memory)** gaps.

**Already per-tenant-ready (don't redo):** Zoom + EventsAir creds, branding,
company/invoice identity, the MCP/API-key surface, schema uniques on
`Event.slug`/`Contact`/`BillingAccount`/`AbstractTheme`.

**Decisions to make first (human call — before any build):** (1) identity model
(recommend shared User + Membership); (2) isolation model (recommend shared-DB +
RLS; flat-via-denormalized-`organizationId` vs join-policy RLS); (3) Stripe Connect
destination charges + application fee; (4) MM Group migrated **last** (it's live
prod with real money) or kept siloed.

**Do-now prep (safe before committing to the full build):** a **CI lint** for
`where:{id}`/`where:{slug}` without an org bind (stops IDOR recurrence); lock the
identity + isolation decisions; **incrementally denormalize `organizationId`** onto
the 25 event-scoped tables (additive + backfill — the prerequisite for flat RLS).

**Phasing** (maps to MULTI_TENANCY.md §13): Phase 1 = isolation foundation (host→tenant
routing + `TenantDomain`, pooler-safe `SET LOCAL` Prisma extension, RLS on every tenant
table, the slug-routing cut shipped *with* the resolver, a tenant-isolation test suite —
**the gate; nothing onboards to shared infra until proven**). Phase 2 = platform features
(Stripe Connect, per-tenant email sender-domain verification, custom-domain TLS, per-tenant
logging/quotas + Redis limiter, tenant lifecycle). Phase 3 = scale + consolidate (cost
attribution, worker fairness + the `DIRECT_URL` lock fix before a 2nd worker, per-tenant
secret keys/KMS, migrate MM Group in last).

### Speaker ↔ Registration identity unification — Person/Contact hub (future initiative, scoped June 24, 2026)

**Today (and intentionally, for now):** `Speaker` and `Registration`/`Attendee`
are **separate first-class records** with no FK between them — correlated only by
`email` (and a shared `User` when one exists). "Import registration → speaker"
**copies** the attendee's fields into a new Speaker row, so the two then drift.
This is *correct* for the common case the owner described: many speakers are
**independent** (sponsor- or society-suggested, manually added, may never
register), so a speaker **must** be able to exist with no registration.

**Shipped as the 80/20 (June 24, Option A):** a nullable `Speaker.sourceRegistrationId`
pointer (set on import; read-time email-match fallback for older/independent
speakers) + a unified **speaker Activity timeline** that surfaces the linked
registration's audit + email activity **pointed, not duplicated**. Person data is
still two rows, but the activity is linked.

**The future initiative (Option B — a real project, NOT a quick task):** make a
single **Person/Contact identity hub** that **both** `Speaker` and
`Attendee`/`Registration` *optionally* reference — so "speaker" and "registrant"
become **roles/functions on one person**, edit-once-updates-everywhere, activity
naturally shared. **Critical constraint:** it must be `Speaker → Person?`
(optional), **never** `Speaker → Attendee` (required) — that would break every
independent/manually-added speaker. The existing `Contact` store (org-level,
deduped by `(org, email)`, already synced from both speakers + registrants) is the
seed of this hub. Scope = schema + backfill + rewrite of speaker/attendee CRUD +
the import becomes "flag this person as also a speaker" instead of copying +
many read/write paths. High blast radius (identity is load-bearing) → own design
doc + phased rollout. Natural to fold into the **Multi-Tenancy** program above (a
tenant-scoped Person identity is needed there anyway). Effort: **L+**.

### Near-Term (Next 1–2 Months)

| Feature | Description |
|---|---|
| **Wave 4 Testing** | Repeat of waves 1–3 (Performance & Load + Security) covering everything shipped since wave 3. Scope: analytics endpoint + dashboard, on-demand barcode rendering (admin + registrant + inline-CID email), additionalEmail surface across attendee/speaker/MCP/registrant, DTCM toggle + bulk-import path, badge-print tracking + CSV exports, AuditLog composite index growth, MCP `get_event_analytics` + `additionalEmail`/`requiresDtcmBarcode`/speaker `bio`/`photo`/`country` additions, post-2026-05-18 remediation items still on the backlog. Scheduled separately from monthly stability passes — runs as a standalone wave. |
| **External REST API (Phase 3 of services refactor)** | Public-facing API for 3rd-party integrators. Each endpoint is a thin wrapper over a service. **Drives the `registration-service.ts` extraction** (Phase 2c was deferred for exactly this — the API spec is the forcing function that shapes the service). |
| **Abstract → Session Linking (UI)** | Link accepted abstracts to sessions directly from the abstract detail view |
| **Room Type Edit/Delete UI** | Complete the accommodation UI (API already exists) |
| **Accommodation Booking UI** | Full booking creation and management interface |
| **Registration Delete Button (UI)** | Surface the existing delete API in the admin panel |
| **Sent-email content preview ("see what was sent")** | The per-entity Email History card (registration/speaker/contact sheets) shows metadata only — `EmailLog` stores `to/cc/subject/template/status/timestamp` but **no body**. Add a `bodyHtml @db.Text` (nullable, additive) column populated by the `sendEmail` wrapper with the exact rendered HTML that went out (post-branding/CSS-inline/per-recipient tokens — the only accurate "what was sent"; re-rendering from the template would be wrong), plus a **"View"** action per history row → a preview dialog (reuse the desktop/mobile email-preview dialog). Pre-feature rows show "content not captured". **Decision needed:** store body for ALL sends (full auditability — recommended) vs scoped (transactional/cert/bulk only) and/or a retention sweep (bodies ~10–50 KB each; metadata kept regardless). Requested June 24, 2026. |
| **Analytics Dashboard** | Registration trends, revenue summary, check-in rate, abstract acceptance rate by event |
| **Waitlist Management** | Automatic waitlist promotion when registrations are cancelled |
| **Resilience helper (`src/lib/resilience.ts`)** | Shared `withTimeout` / `withRetry` (jittered backoff) / `CircuitBreaker`. Closes the audited gap: Stripe/Zoom/Anthropic SDK calls lean on default timeouts, no bounded-retry, no breaker (repeated failures each pay full timeout). **Decided design:** retry opt-in never default; only reads + idempotent writes; baked-in retryable classifier (5xx/429/network/timeout, never 4xx) with override; in-memory breaker state (same trade-off as `checkRateLimit`, pluggable interface for future Redis); centralized timeout table. **Phasing:** P1 ship helper + tests, no call-site changes; P2 wrap Zoom client / safe-fetch / email send / **Prisma client via `$extends` query middleware** (added 2026-06-01 — Sentry 111629996 ETIMEDOUT pattern is the canonical retryable DB case; the per-error classifier shipped in `67cc437` already exposes a `retryable` flag the wrapper would consume); Stripe idempotency-key retry is a separate, riskier PR — NOT in scope. **Cheap precursor mitigation (file-level, no helper needed):** add `?connect_timeout=15` to `DATABASE_URL` so a dead-pool-slot pickup fails in 15s instead of the 75s OS-kernel default — turns 75s user-perceived hangs into 15s recoveries while we wait on the helper. Full design discussion in session 2026-05-18. |

### Deploy / Infrastructure Hardening (deferred — added June 16, 2026)

Driven by **INC-001** (on-box `docker build` froze the swapless host; see
[docs/INCIDENTS.md](INCIDENTS.md)). Swap (4 GB) is already added as the cheap
insurance; these are the durable fixes, deferred for a future pass.

| Priority | Item | Detail |
|---|---|---|
| ✅ SHIPPED (2026-07-01) | **Build the Docker image in CI → push to ECR → box pulls** (incident action item #2) | **The actual fix for the OOM class + the ~8-min on-box build.** **AWS done:** ECR repo `803726282629.dkr.ecr.ap-south-1.amazonaws.com/ea-sys`, GitHub-OIDC push role `ea-sys-gha-ecr-push` (no stored keys), ECR-pull on the box instance role. **Step 1** (`a25cc35`): a `build-push` workflow job builds the **web** (`Dockerfile`) + **worker** (`Dockerfile.worker`) images on GitHub runners and pushes them to ECR (`:<sha>` + `:latest`, `worker-<sha>` + `:worker-latest`). **Step 2** (`e118830`): `docker-compose.prod.yml` (`image:` from `EA_SYS_WEB_IMAGE`/`EA_SYS_WORKER_IMAGE`, `build:` kept as fallback) + `deploy.sh` (ECR-login + `docker compose pull`, on-box-build fallback) + the deploy job now `needs: build-push` and passes `IMAGE_TAG=<sha>`; **migrations run from the pulled worker image** (`docker run --user root <worker-image> npx prisma migrate deploy` — it ships the Prisma CLI, so **DB creds stay in `.env`, never in GitHub**). **Net:** SSH deploy ~8 min → ~1–2 min; the box never runs a memory-heavy build; a pull failure falls back to on-box build; a migration failure aborts before the nginx swap (old slot keeps serving); rollback = `IMAGE_TAG=<old-sha> bash scripts/deploy.sh`. Source maps still upload from the CI `next build` step. **Image hygiene done same day (`7092f8a`):** `provenance: false` + `sbom: false` on both build steps (stops the ~4 untagged attestation manifests/deploy) + an **ECR lifecycle policy** (expire untagged after 1 day; keep the 10 most-recent tagged = ~5 deploys rollback) + `scripts/docker-prune.sh` now trims old pulled `:<sha>` images on the box (keep newest 3 web + 3 worker). Gotcha recorded in [AWS_OPERATIONS §5.x](AWS_OPERATIONS.md): you can't `batch-delete-image` an untagged **child of a manifest list** (`ImageReferencedByManifestList`) — the pre-`provenance:false` attestation children age out only when their parent `:<sha>` tag rotates past keep-10. **Remaining follow-up:** update the cold-standby runbooks (recovery becomes pull-not-build) + the LOW cross-region-replication item below. |
| LOW | **ECR cross-region replication → Singapore (DR)** | ECR lives in `ap-south-1` (Mumbai) — same region as the box + Supabase. A **box-only** loss is covered (replacement box pulls fast), but a **full Mumbai-region** loss also takes ECR down, so a Singapore recovery box couldn't pull. Enable ECR **registry replication** to `ap-southeast-1` (where the DR S3 bucket already is); every push then auto-copies images there. One-time registry setting + small storage cost. Pairs with the standby-box + Supabase-PITR DR plan. |
| MEDIUM | **`mem_limit` on the prod containers** (incident action item #5) | Hard-bound each container's memory in `docker-compose.prod.yml` so one container/build can't consume all host RAM. Belt-and-braces alongside the CI fix. |
| LOW | **Memory + disk metrics → CloudWatch + alarm** (action item #3) | The CloudWatch agent ships *logs* only; default EC2 metrics don't include memory. Add the mem/disk metrics + an alarm on `mem_available < 500 MB` so pressure pages *before* a freeze. |
| LOW | **External uptime check on `/api/health`** (action item #4) | Route 53 health check or UptimeRobot — catches a frozen-but-"running" box (EC2 status checks don't). |
| — | **Instance sizing — NOT recommended as the fix** | Bumping t3.large (8 GB) → t3.xlarge (16 GB) would give the build headroom, but it's **~+$60/mo (≈2×) of always-on RAM for a few seconds of transient build need**, and it doesn't fix the root cause (building on the prod host) — a future heavier build could still approach the higher ceiling. With swap already added (freeze → slow-down) and the CI/ECR fix above (box never builds), upsizing is unnecessary. Revisit only if the *runtime* footprint (not the build) genuinely outgrows 8 GB. |

### DR / backup + nginx hardening (added June 30, 2026)

Surfaced during the conference-readiness + backup review. None blocking; verified
context in [infra/dr/](../infra/dr/) and the DR memory.

| Priority | Item | Detail |
|---|---|---|
| MEDIUM | **nginx box ↔ repo reconciliation** | The live `/etc/nginx/sites-available/ea-sys` has diverged from `deploy/nginx.conf` — and the **box is the LEANER one** (Certbot-stripped). Exact live state captured in [`deploy/nginx.live-snapshot.conf`](../deploy/nginx.live-snapshot.conf) (2026-06-30). The box is MISSING vs the intended config: **HTTP/2** (`listen 443 ssl`, no `http2`) + **security headers** (`X-Frame-Options` / `X-Content-Type-Options: nosniff` / `Referrer-Policy`). Most other deltas (gzip, `/_next/static` caching, agent-SSE buffering) are already handled by Next.js itself, so low-impact. **Fix = targeted on-box edits** (add `http2 on;` + the `add_header` lines) — Certbot manages this file, so do NOT wholesale-replace it. Re-capture the snapshot after any change. |
| LOW | **nginx config → S3 DR backup cron** | The live nginx file is NOT in the scheduled S3 DR backup (only `db/` + `uploads/` + `env/` are). Add a daily `aws s3 cp /etc/nginx/sites-available/ea-sys s3://ea-sys-dr-singapore/nginx/$(date -u +%F).conf …` line mirroring the `.env` backup, so a box rebuild has the exact config. The repo snapshot is the interim backup. |
| ✅ DONE (2026-06-30) | **DB RPO tightening — 2h day / 4h night** | Applied: crontab now `0 2,4,6,8,10,12,14,16,18,22 * * *` UTC = ≤2h RPO Dubai 08:00–22:00, ≤4h overnight (10 dumps/day; script unchanged). Docs ([infra/dr](../infra/dr), AWS_OPERATIONS §2.4) + memory synced. |
| LOW | **Supabase PITR (true zero-RPO)** | Snapshot dumps still lose up to the window (2h/12h) of new rows on a Supabase-loss. PITR (~$25–50/mo) gives seconds-level recovery. Worth it for payment-critical events — though **Stripe is already the payment system-of-record** (the invoice-reconciliation worker recovers payments), so the real exposure is lost DB rows (registrations), not payments. |
| LOW | **DB pool burst headroom** | Verified `connection_limit=10&pool_timeout=15` on the box (fine for the authenticated-desk conference profile). For a heavy public registration-open burst, bump to 15–20 in the box `.env` + `scripts/deploy.sh` (env change needs a deploy, not a restart). Optional. |

### Audit Hardening Backlog (deferred from the May 18, 2026 multi-agent review)

The May 18 review (supervisor + React/Prisma/backend/architecture agents)
fixed the 6 source-verified BLOCKER/HIGH findings in commit `ff3b7e0`
(see CLAUDE.md "Recent Features"). The items below were **corroborated by
the reviewers but consciously deferred** out of that batch. Ordered by
severity; each is independently shippable. None is a product feature —
this is correctness / security / silent-failure debt.

| Severity | Item | Risk & recommended direction |
|---|---|---|
| ~~HIGH~~ ✅ | **Accommodation overbooking TOCTOU** — **CLOSED June 23, 2026** (audit Round 2 / DATA-2, commit `bfc7596`: atomic `updateMany` with `bookedRooms < totalRooms` predicate in the service + the PUT room-change/reinstate paths; test updated). Original detail kept for history: `accommodation-service.ts` (~210-255) and `accommodations/[accommodationId]/route.ts` (~188-222) read `roomType.findUnique`, check `bookedRooms >= totalRooms` in JS, then unconditionally `increment` — no row lock, two concurrent bookings on the last room both pass. The "can't double-book by construction" comment is false. Fix: `$executeRaw` conditional `UPDATE … SET bookedRooms = bookedRooms + 1 WHERE id = ? AND bookedRooms < totalRooms` and check affected rows (Prisma can't express a column-to-column `updateMany` predicate). |
| ~~HIGH~~ ✅ | **Registration DELETE destroys a shared Attendee** — **CLOSED June 23, 2026** (audit Round 2 / DATA-6, commit `bfc7596`: deletes the Attendee only when `registration.count({ attendeeId, id: { not } }) === 0`, inside the same tx). Original detail kept for history: `registrations/[registrationId]/route.ts` (~601) unconditionally `attendee.delete`s after `registration.delete`; Attendee can be shared across registrations (orphan-reuse + email-change clone). No `onDelete` on the FK → P2003 fails the whole delete, or orphans a still-referenced person. Fix: only delete the Attendee when `registration.count({ attendeeId, id: { not } }) === 0`, inside the same tx. |
| HIGH | **`PricingTier.soldCount` double-leak (NOT a one-line fix)** | Bigger than first written. Public register increments **either** the tier **or** the ticketType (tier path skips ticketType); admin/service add always increments the ticketType (never the tier — documented). But cancel/delete/type-change/bulk-type/MCP **unconditionally decrement the ticketType**. So a **public + tier** registration cancelled = the tier counter leaks up (never released → phantom sell-out) **and** the ticketType counter leaks down (decremented for something it never counted → can go negative → oversell). Fix is a **routing** change (release the counter that was actually incremented), not an added decrement, applied across ~5 sites. **Full analysis + worked example + fix plan in the subsection right below this table.** |
| ~~HIGH~~ ✅* | **Stripe post-payment side-effects are fire-and-forget, handler returns 200** — **ADDRESSED June 23, 2026** (audit Round 2 / DATA-5, commit `09dab42`: a new `invoice-reconciliation` worker job — every 10 min, advisory-lock 1006 — recovers PAID registrations with a PAID `Payment` but no `INVOICE`, re-running `createPaidInvoice`+`sendInvoiceEmail`; idempotent). *The stronger in-tx **outbox** variant below remains OPTIONAL if you want guaranteed-at-source delivery rather than a reconciler. Needs the worker container redeployed to run. Original detail kept for history: `webhooks/stripe/route.ts` (~122-203): invoice + confirmation email run in a detached IIFE after the tx; failure = customer is PAID but never gets invoice/confirmation, permanently, Stripe won't retry, no reconciler. Fix: persist an outbox/intent row in the same tx that flips PAID; drain via an idempotent reconciliation cron (`createPaidInvoice` already promotes-in-place). |
| ~~HIGH~~ | ~~**Registrant invoice/quote routes missing `denyFinance`**~~ | ~~`registrant/registrations/[id]/quote`, `…/invoices`, `…/invoices/[invoiceId]/pdf` — the non-registrant branch scopes by org only; a MEMBER has an org so passes. Add `denyFinance(session)` on the non-registrant branch (registrant-owned access stays exempt).~~ **CLOSED — Core Stability Pass #1, June 1, 2026.** Three routes gated on the non-registrant branch with `denyFinance` + `apiLogger.warn`; REGISTRANT owner path stays exempt. Regression net: 7 tests in `__tests__/api/registrant-finance-routes.test.ts` pin MEMBER → 403 FINANCE_FORBIDDEN before any DB read. |
| MEDIUM | **`refreshEventStats` lost-update** | Fire-and-forget full recompute with no concurrency control; under a burst the last racing `upsert` wins and may have read a pre-burst snapshot → dashboard counts lag with no self-heal. Fix: serialize per-event (in-proc mutex/debounce) and/or a periodic reconcile; `await` where correctness matters. |
| ~~MEDIUM~~ ✅ | **~8 silent `safeParse`→400** — **CLOSED / not reproducible** (audit Round 2, June 23 2026: a sweep of ~110 `safeParse` sites found **0** missing an `apiLogger.warn` — the earlier "~8 remain" claim was stale). Original list kept for history: `abstract-themes` POST/PUT, `review-criteria` POST/PUT, `promo-codes` POST/PUT, `notifications/read` POST, `email-logs` GET, `registrations/[id]/email` PATCH (Zod branch). Add `apiLogger.warn` via the existing `zodErrorResponse()` helper. Violates the owner's #1 rule. |
| MEDIUM | **Money rounding/discount divergence** | Stripe `payment-confirmation` email recomputes `basePrice*taxRate` ignoring `discountAmount` and skips `round2` — disagrees with the invoice PDF and `computeRegistrationFinancials` by cents for promo+tax registrants. Fix: build the email totals from `computeRegistrationFinancials`. |
| MEDIUM (mostly ✅) | **Frontend silent failures** | ✅ **DONE June 26:** (a) registrant portal no longer renders "not registered" on a failed fetch — `e/[slug]/my-registration/page.tsx` branches on `isError` (red "your registration is safe" card + Try-again `refetch`) + logs; (b) `bulk-tag-dialog.tsx` `handleSubmit` now catches a failed `onSubmit` → `toast.error` + console.error + keeps the dialog open (covers both registrations + speakers callers); (c) **MEMBER write-button 403s:** new client-safe `canWrite(role)` ([src/lib/can-write.ts](src/lib/can-write.ts), {SUPER_ADMIN,ADMIN,ORGANIZER}) now gates the abstracts page's CSV-import / Email-All / Add-Abstract buttons (were `!isSubmitter && !isReviewer`, so MEMBER saw them → 403). The **registrations** list + detail-sheet half was already resolved by the June ONSITE/desk-allow work — MEMBER is a legitimate registration-desk role there (`REGISTRATION_DESK_ALLOW = [ONSITE, MEMBER]`) and management actions are gated by `isDeskOperator` (which includes MEMBER); (d) **GET-load swallows surfaced:** a triage sweep across ~13 client data-loaders added an `else`/`catch` `console.error` to every GET data-LOAD fetch that ignored `!res.ok`, plus a `toast.error` on the PRIMARY-content loads (content editor, event + org settings, hotels/bookings, payment-status, my-registration — log-only on secondary loads like the users list / branding banner / agreement card). Action/mutation handlers untouched. **FINDING CLOSED.** |
| MEDIUM | **Add-Registration dialog vs full-page drift** | The quick-add dialog never sends `pricingTierId`/`sponsorId`, silently producing tier-less registrations that break "Registrations by Tier" + finance reporting. Port the picker or extract a shared form component. |
| MEDIUM | **MCP finance boundary / OAuth role snapshot** | Finance/MEMBER redaction is enforced only in the in-app agent route; the MCP HTTP path has none, and OAuth access tokens snapshot role at consent and never re-check (a demoted ADMIN keeps a finance-exposing token up to 90 days). Bounded today (MEMBER can't mint keys; consent UI RBAC) but fragile. Fix: move the finance/read-only decision into `runTool` keyed off live role from `token.userId`; revoke tokens on role change. |
| MEDIUM | **Blue-green has no expand/contract guardrail** | `scripts/deploy.sh` runs `prisma migrate deploy` while the old container still serves traffic; safe only because every migration has been additive by convention. The reviewer migration proves destructive ones get written. Add a CI check rejecting `DROP`/`RENAME`/`SET NOT NULL`/enum-value-removal in migration SQL unless an explicit `EXPAND_CONTRACT_OK` marker is present; document the two-phase requirement. |
| LOW | **MCP CORS** | `mcp-cors.ts` reflects any `*.anthropic.com`/`*.claude.ai` origin with `Allow-Credentials: true`. MCP is token-auth (no cookies) so impact is bounded — drop `Allow-Credentials` for the MCP transport or use an exact-origin allowlist. |
| ~~LOW~~ ✅ partial `d5ba791` | **Doc drift** — SHIPPED June 26: fixed the `src/middleware.ts`→`src/proxy.ts` (Next 16.1 rename) references on the 4 current-description lines + the stale stdio-MCP "drifts" note (both now share `registerAllMcpTools()`). **Still open:** the "0 silent Invalid-input paths remain" claim is false (a separate sweep — not addressed in this pass). |

#### P1.1 detail — `PricingTier.soldCount` double-leak (investigated June 24, 2026; deferred for a dedicated pass)

Investigating the "one-way leak" row above revealed it's a **two-direction** bug, and the
naive fix (just add a tier decrement) makes it **worse**. Captured here so the implementer
has the full picture before touching **live capacity counters**.

**Two counters.** Each `TicketType` has `soldCount`; if it uses pricing tiers, **each
`PricingTier` also has its own `soldCount`**. A registration increments exactly **one** of
them — *which* one depends on the create path:

| Create path | Has a tier? | Increments |
|---|---|---|
| Public register | yes | **`PricingTier.soldCount`** (ticketType untouched) |
| Public register | no | `TicketType.soldCount` |
| Admin / service add | yes | **`TicketType.soldCount`** (tier untouched — intentional, documented in `registration-service.ts`) |
| Admin / service add | no | `TicketType.soldCount` |

**The decrement side** — cancel, delete, type-change, bulk-type, and the MCP
`update_registration` / `bulk_update_registration_status` paths — **all unconditionally
decrement `TicketType.soldCount`** and never touch a tier counter.

**So the only broken case is a PUBLIC + TIER registration**, and it breaks both ways.
Worked example — Physician type (cap 100) with an Early Bird tier (cap 30):
1. 10 register publicly on Early Bird → `EarlyBird.soldCount = 10`, `Physician.soldCount = 0`.
2. 3 cancel → cancel decrements **Physician** ×3 → `Physician.soldCount = -3`; `EarlyBird.soldCount` stays 10.
- **Tier leaks up:** Early Bird reads 10/30 though only 7 are active → 3 phantom seats burned → tier sells out early.
- **Ticket type leaks down:** `Physician.soldCount = -3` → wrong dashboard counts **and** the `soldCount < quantity` guard now permits oversell.

**Discriminator** for "this reg incremented the tier (so release the tier, not the type)":
`createdSource === "PUBLIC_REGISTER"` **and** `pricingTierId != null` **and** in-person
(`attendanceMode !== "VIRTUAL"` — virtual skips all capacity).

**Fix plan (own pass, NOT a loop tick):**
1. Shared helpers `releaseSeat(tx, reg)` / `reclaimSeat(tx, reg)` that pick tier-vs-ticketType from `(createdSource, pricingTierId, attendanceMode)` and adjust that counter, **guarded `soldCount > 0`** (via `updateMany`) so it can never go negative.
2. Apply at all ~5 sites in place of today's unconditional ticketType decrement/increment: registration PUT (cancel **+** reactivate **+** type-change), DELETE, bulk-type, MCP `update_registration` + `bulk_update_registration_status`. Type-change = release-old + claim-new through the same helpers.
3. Tests: public-tier cancel releases the *tier*; admin-tier cancel releases the *ticketType*; non-tier cancel unchanged; reactivate re-claims the right counter; type-change moves correctly; never goes negative.
4. **Follow-up (separate):** this stops *new* drift only. Counters already drifted from past cancellations need a **one-time reconciliation script** — recompute each `TicketType.soldCount` / `PricingTier.soldCount` from the row-truth (count of non-cancelled registrations, routed by the same discriminator) and reset. Run once after the code fix deploys.

**Risk:** live production capacity counters — a wrong discriminator corrupts counts the other way (oversell / false sell-out). Hence careful + fully-tested, not rushed.

### Charge-to-another-account follow-ups (v1.1 — shipped v1 May 19, 2026)

v1 (reusable `BillingAccount`, 1-invoice-per-reg, optional PO ref,
per-reg guarantor) is live. Consciously deferred, each independently
shippable, none blocking v1:

| Item | Note |
|---|---|
| **Public "who pays" step** | Self-register lets the doctor say "my institution pays" → either pick an existing active payer **attached to this event** (via the EventBillingAccount junction, May 20 refactor) or create a `needsReview` row that auto-attaches to this event in the same tx so finance dedupes from Settings → Billing. Schema + routes ready; only the public form UI is missing. |
| **Quick-Add dialog picker** | The fast add-registration *dialog* still has no payer picker (consistent with its existing pricingTier/sponsor gap — the full-page form is the tier/payer surface). |
| **Standalone MCP `list/create_billing_account`** | Agent can already assign an existing payer via `create_registration`/`update_registration` `billingAccountId`; payer *creation* stays a Settings task. Add the two org-level tools if agent-driven payer creation is needed. |
| **Registrations-list "Payer" column + CSV** | Detail sheet shows the payer; list/export don't yet (mirror the pricingTier-column follow-up pattern). |
| **AR aging by payer** | Detail GET returns "registrations by payer"; full invoiced/paid/outstanding aging + a "send all to Pfizer" action is v2. |
| **VAT reverse-charge by payer** | v1 prints the payer `taxNumber` on the invoice but does NOT change the tax rate. Cross-border B2B reverse-charge / exemption needs explicit finance sign-off — finance-correctness landmine, do not auto-apply. |
| **Consolidated invoicing** | One invoice → many doctors → one payer. Breaks the 1:1 Invoice↔Registration model + `InvoiceCounter`; schema leaves room (group-by-payer is additive). |
| **Auto-revert on non-payment** | `attendeeIsGuarantor` stores intent; reverting an unpaid third-party reg to attendee-owed is a manual finance action in v1. A dunning/age-out cron is v2. |
| **Quote/confirmation email recipient** | v1 redirects the invoice/quote **PDF** bill-to to the payer, but the confirmation email is still addressed `to: <attendee>` (so the doctor gets a "please pay" quote). v1.1: when a payer is set, send the quote to the payer's billing email (and suppress the attendee "pay now" copy unless `attendeeIsGuarantor`). Flagged by the pre-commit review as a UX/flow nicety, not a correctness/security defect. |

### Hybrid attendance (in-person/virtual) follow-ups (v1.1 — shipped v1 June 12, 2026)

v1 is live: HYBRID events let registrants choose venue vs online; virtual gets
no barcode/badge, is uncapped (skips `soldCount`), is priced via the flat
`TicketType.virtualPrice`, and the confirmation email swaps the barcode for a
"joining instructions will be sent" message. Wired through the public form +
API, the service (admin REST + MCP), the admin full-page Add form, MCP
`create_registration`, and CSV import. Consciously deferred, each independently
shippable, none blocking v1:

| Item | Note |
|---|---|
| ~~**Admin mode-change qrCode minting**~~ ✅ SHIPPED June 26 | Switching a registration **virtual→in-person** left `qrCode` null (can't badge/check-in) **and** mis-handled `soldCount` (a virtual reg never consumed a seat, but cancel/reactivate/type-change still moved the counter). Fixed via a single seat-accounting model — [src/lib/registration-seat.ts](src/lib/registration-seat.ts) `holdsSeat`/`planSeatTransition`/`needsQrCode` (15 unit tests): a reg consumes a seat iff `status≠CANCELLED && IN_PERSON`. Both update paths (REST PUT + MCP `update_registration`) now route every `TicketType.soldCount` delta through it and lazily mint a barcode on virtual→in-person (in-person→virtual releases the seat, keeps the barcode for audit). Capacity-guarded (sold-out virtual→in-person hard-fails `CAPACITY_EXCEEDED`; reg stays virtual). New **Attendance** toggle on the registration detail sheet (HYBRID + non-reviewer). MCP `update_registration` gained `attendanceMode` (pkg 0.4.12). +3 integration tests. Adversarial review = no blockers; also closed a pre-existing REST IDOR (request `ticketTypeId` now event-scoped) + added `attendanceMode`/`qrCodeMinted` to the MCP audit. **Still deferred (review-flagged):** mode change does NOT recompute price/amount-owed (`virtualPrice` vs in-person — documented in the toggle + MCP description); the inline-Select TOCTOU (detail-sheet quick-actions don't send `expectedUpdatedAt`, so two concurrent seat-moving edits can double-release) is pre-existing + overlaps the P1.1 soldCount-reconciliation pass. |
| **Quick-Add dialog picker** | The fast add-registration *dialog* has no mode picker (consistent with its existing pricingTier/sponsor gap — the full-page form is the surface). |
| **Check-in UI for virtual** | Scanner already can't match a virtual reg (no qrCode), but the registrations-list "Check In" action should be hidden/disabled for virtual, and the check-in/attendance-rate KPIs should be computed over in-person only so on-site numbers aren't diluted. |
| **Dashboard in-person/virtual split** | Add an in-person vs virtual headcount tile (and "expected at venue" = in-person count). The `@@index([eventId, attendanceMode])` is already in place for the groupBy. |
| **Registrant self-service portal mode display** | `/my-registration` should show the attendee's mode (and any change is admin-only). |
| **Tier-windowed virtual pricing** | v1 virtual price is **flat** per ticket type (pricing tiers apply to in-person only). If virtual needs Early-Bird-style time-windowed pricing, that's a `PricingTier.virtualPrice` extension — scope separately. |
| **Virtual attendance certificates** | An *attendance* certificate for a virtual attendee should gate on **Zoom attendance** (the webinar attendance sync), not desk check-in — the cert eligibility assumption changes for virtual. |

### Webinar waiting room follow-ups (deferred from the June 23, 2026 code review)

The webinar **waiting room** shipped (June 23): producer-gated "Open the room"
admission, a branded lobby with a YouTube/Vimeo holding video + countdown,
per-event viewing mode (Zoom embed vs custom HLS stream), real-time presence
tracking (`WebinarPresence` + heartbeat + "Live now" console card + a "Joined"
registrations badge), and 5k-ready HLS-via-CDN wiring. A two-agent adversarial
review followed; the live/high findings were fixed in-band (commits `ebf766b`,
`9cdac92`, `517e1d4` — presence upsert race, LivePlayer auto-recovery, close/
re-open admit, hls-misconfig fallback, lobby-status micro-cache, MediaMTX probe
cache, admit signature re-mint, overrun cutoff). These remain deferred:

| Item | Note |
|---|---|
| **Never-opened-room warning (#6)** | DECISION: keep the producer-gated manual "Open the room" model (do NOT auto-open). Add a loud **"Room still closed — N attendees waiting"** alert on the Webinar Console once `now >= startTime`, and fix the lobby copy so the countdown doesn't imply imminence forever after T-0. |
| **Operator visibility (#10)** | Surface in the LobbyCard that **DRAFT events auto-open** the room (for testing) while **PUBLISHED requires the manual click** — so "it worked in my test" doesn't surprise an operator at go-live. |
| **Save-time hls/stream validation (#5 follow-up)** | The runtime fallback handles `viewingMode="hls"` with no `liveStreamEnabled`/`streamKey` (shows "getting the stream ready"). Better: validate at the webinar/room PUT that HLS mode requires the anchor session's live stream to be enabled, so it can't be misconfigured. |
| **`lobby-status` eventType short-circuit (LOW)** | The public lobby-status route serves any session in a valid event; add a cheap `eventType === "WEBINAR"` guard to keep the surface tight. |
| **Stale `session.status` badge (LOW, cosmetic)** | The public session page fetches `session.status` once at load; the Live/Ended badge can lag the producer's open/close until refresh. Admission itself is driven by the lobby poll, so this is display-only. |
| ~~**`LivePlayer` `onStreamStatusChange` ref (LOW)**~~ ✅ `d1999d9` | SHIPPED June 26 — the callback is read from a latest-value ref and dropped from the init-effect deps, so a non-memoized handler can no longer re-create the HLS player + 10s poll. |
| **Shared rate limiter (LOW, pre-existing)** | The in-memory `checkRateLimit` store resets on every blue-green deploy and is per-container — at 5k that briefly drops rate protection mid-deploy. Real fix is the long-deferred Redis-backed limiter; for now: don't deploy during a live 5k webinar. |

**Operational prerequisites (operator-run, not code):**
- **Phase 0 — Zoom embed Join:** flip the org's Zoom **Active SDK Mode dev → Production** and add `events.meetingmindsgroup.com` to the **prod** Meeting-SDK app's Marketplace **Embed allowlist** (the embed code/deps are verified sound; this is the one config gap behind the earlier Join error). Required only for the **Zoom-embed** viewing mode.
- **Verify the box's nginx `/stream/`** matches the now-committed `deploy/nginx.conf` block before any HLS-mode webinar (the live nginx is Certbot-managed and has diverged — the box is source of truth).
- **CloudFront + Singapore DR origin failover** before a real **5k streamed** event — exact steps in `docs/LIVE_STREAMING.md §13`. The app is CDN-ready (`HLS_CDN_BASE` unset = direct origin, fine for dev/small events).

### registration-detail-sheet.tsx — staged refactor remainder (trigger-driven, May 20, 2026)

Steps A–E of the staged refactor shipped (commits `8ad760b`, `25b3299`,
`9cdf002`, `5e3d486`, `64dc640`). The sheet went from 2,174 lines to
~2,063 (~−110 net), gained 22 new unit tests (`registration-edit-mapping`
+ `api-fetch`), and we squashed one latent prop-revert race + the React
19 setState-during-render warning along the way. Three remaining steps
were graded "quality investment, not bug fix" and are deferred until a
trigger fires:

| Step | What it does | Cost | Risk | Trigger that justifies doing it |
|---|---|---|---|---|
| **F — functional updates + `setField(name, value)` helper** | Replaces ~94 `setEditData({ ...editData, x: v })` spreads with `setField('x', v)` + a functional updater. Removes the theoretical stale-closure bug surface and saves one render per keystroke. | ~1 hr | ⚠️ medium — 94 mechanical changes, typo risk in the field-name string. | (a) profiling shows real input lag, or (b) you're about to start step H (RHF), in which case skip F entirely — RHF obsoletes it. |
| **G — split into sub-components** | Extract `<AttendeeInfoSection>`, `<BillingDetailsSection>`, `<ChargeToControl>`, `<SponsorPicker>`, `<PaymentSummaryCard>`, `<ActivityTab>`. Sheet collapses to ~500 lines + 5 children of 150–300 each. **Biggest maintainability win** of all remaining steps. | half a day | ⚠️ medium — many prop-drilling touch points; each child needs the right state + callbacks. | (a) the file passes ~3k lines, or (b) the next feature you add to this sheet would touch >2 sections and feels painful to navigate. |
| **H — react-hook-form + Zod migration** | The big one. Replaces the giant `editData` state + `onChange` spreads + `saveEdits` payload assembly with RHF. Per-field re-renders, dirty/error tracking free, validation hooks into the route's existing Zod schema. | 1 day | 🔴 highest — touches every input + the populate + the save path + the Cancel/dirty-state UI. | (a) a feature needs per-field control (autosave-on-blur, async field validation, optimistic updates), or (b) React/Next upgrade flags the form's controlled-input pattern as a build error. Do **after** G (the surface area shrinks; the migration becomes per-section instead of all-at-once). |

**Recommended sequence when a trigger fires**: G first (it's the prerequisite
for a clean H), then H if needed, then F is moot. Skipping straight to H
without G is possible but doubles the diff size of the single PR.

### Certificates — operator-feedback round, deferred review findings (June 3, 2026)

The June 3 operator-feedback round shipped 4 features (canvas undo,
Y-axis nudge, per-recipient resend, EmailLog "Cert" pill) across
commits `0c56c9a` (implementation) → `1e9801a` (24 unit + 8 e2e cases)
→ `58168b4` (4 HIGHs from the independent review pass: H1 atomic
cross-event binding, H2 path-traversal + SSRF allowlist with
per-rejection structured logs, H3 setState updater purity in undo/redo,
H4 toast wording fidelity). The items below are **MEDIUM/LOW findings
the review surfaced and we consciously deferred** — none blocks the
deploy, each is independently shippable, pick up first whenever an
operator hits a related issue.

| Severity | Item | Risk & recommended direction |
|---|---|---|
| MEDIUM | **`abstractTitle` token not HTML-escaped in cert delivery email body** | `src/lib/certificates/email-tokens-resolver.ts` (~131-154) — speaker-authored abstract titles interpolate raw into the HTML body for APPRECIATION certs. A speaker submitting `<script>alert(1)</script>` as their abstract title would inject that into the recipient's email. **Pre-existing**, NOT introduced by this round, but the resend route is now the second call site. Trigger to pick up: any organizer report of "weird symbols in cert email" OR proactive when next touching the resolver. Fix: add an `escaped` discriminator on `CoverEmailTokenContext` and route abstractTitle through `escapeHtml()` when the escaped variant is requested. ~5 LOC + a parity test. |
| MEDIUM | **Confirm dialog leaks state on mid-mutation Escape / click-outside** | `src/components/certificates/issued-certificates-card.tsx` (~151, 86-94) — operator clicks Resend, dialog opens, SES round-trip starts (~1-2s). Escape or click-outside in those 2s closes the dialog; opening a new resend dialog right after means the in-flight toast from #1 lands while dialog #2 is open. Trigger: operator complaint of "ghost toasts" or visible state inconsistency. Fix: `onInteractOutside` + `onEscapeKeyDown` no-op while `resendMutation.isPending`. ~3 LOC. |
| ~~MEDIUM~~ ✅ `94048f6` | **`handleNudgeY` re-allocates closure ~30×/sec while holding ArrowDown** (SHIPPED June 26 — read `textBoxes` from a latest-value ref in `handleNudgeY` + `pushUndoSnapshot`, dropped it from both deps) | `src/components/certificates/certificate-canvas-editor.tsx` (~355-377) — `useCallback` deps include `textBoxes`. Each nudge mutates it → new closure → new keyDown handler → … On templates with many text boxes on a slow box, measurable allocation churn. Trigger: noticeable input lag during fast-positioning. Fix: read `textBoxes` from a ref inside `handleNudgeY` (already exists for `lastNudgeAtRef`). ~5 LOC. |
| MEDIUM | **`loadPdfBytes` + `escapeHtml` duplicated across worker + route** | `src/lib/certificates/issue-worker.ts` (57-64, 769-781) vs `src/app/api/events/.../resend/route.ts` (similar helpers). Comment in resend route flags it as intentional v1 debt to avoid touching the worker mid-feature. Trigger: next sweep of cert-email code OR any divergence (e.g., new XSS pattern added to one but not the other). Fix: extract `src/lib/certificates/cert-email-helpers.ts`, import from both. |
| MEDIUM | **EmailLogCard "Cert" pill baseline misaligned vs subject text** | `src/components/communications/email-log-card.tsx` (~82, 89-94) — parent is `items-baseline`, pill is `inline-flex items-center`. Pill renders slightly above the subject's typographic baseline on Chrome/Firefox/Safari. Cosmetic only. Fix: `align-self-center` on the pill OR `items-center` on the parent flex. 1 LOC. |
| MEDIUM | **Defensive `recipientEmail` chain doesn't `?.` through Attendee** | `src/app/api/events/.../resend/route.ts` (~251) — `reg?.attendee.email ?? null`. `attendee` is a required FK so won't trigger today, but optional-include semantics in Prisma can return null in edge cases. Trigger: 500 error on resend with stack pointing here. Fix: `reg?.attendee?.email ?? null`. 1 LOC. |
| MEDIUM | **Base64 PDF allocation 2× memory per resend** | resend route + worker — `Buffer.from(arr).toString("base64")` expands ~1.33× in memory. Fine at current 30/hr/user rate; spikes under sustained concurrent resend pressure on small EC2. Trigger: heap growth visible in CloudWatch. Fix: stream SES `RawMessage` attachment (SES v3 SDK supports it). |
| ~~LOW~~ ✅ `47c7fea` | **Dev-only sentinel renders to prod** (SHIPPED June 26 — returns null outside development) | `IssuedCertificatesCard` shows an amber "pass registrationId OR speakerId" panel when both are absent. Comment says "dev-only" but it ships to prod. Trigger: visible. Fix: gate on `process.env.NODE_ENV === "development"` or return null in prod. |
| ~~LOW~~ ✅ `5f0c3f0` | **`recipientLabel` template parity** (SHIPPED June 26 — registration variant now includes title like the speaker variant) | Registration variant doesn't include `title` even when present (`${firstName} ${lastName} <${email}>`); speaker variant does (`[title, firstName, lastName].filter(Boolean).join(" ")`). Cosmetic in the resend confirm dialog. |
| LOW | **`pluralize` helper would dedupe 3 ternaries** | `${count} time${count === 1 ? "" : "s"}` repeated 3× in `issued-certificates-card.tsx`. Style. |
| LOW | **`pushUndoSnapshot` on color-picker focus is unreliable on Chrome** | Native `<input type="color">` doesn't always fire `onFocus` (OS-level picker). A color change may skip the undo step. Known-bad UX of native color inputs; consider Tiptap color or react-colorful if/when this matters. |
| LOW | **`RecipientSnapshot` type inlined rather than imported** | `src/app/api/events/.../resend/route.ts` (~229-234) declares the shape locally; worker has the same shape. Drift risk over time. |
| LOW | **Legacy cert with no `issueRunItem` shows only "Issued X ago"** | `IssuedCertificatesCard` row hides "· sent X ago" when the run item is null. Operator might misread as "never sent". Only affects pre-feature legacy certs (none in prod today). |
| LOW | **Comment phrasing on cross-machine pdfUrl error** | `src/app/api/events/.../resend/route.ts` (~273-275) describes the failure mode imprecisely. Tighten to reference the `STORAGE_PROVIDER=local` pattern explicitly so the next reader doesn't need archaeological context. |

**Review verdict at deploy time**: SAFE TO PROCEED. The independent review agent's full report is preserved in this round's git history (review summary at `58168b4`).

### Abstraction cleanup backlog (June 5, 2026)

Surfaced during a codebase audit triggered by the question "do we need
Snowflake? any abstractions we don't need?". Snowflake: zero
references, not needed. The three items below are real abstractions
that exist today but are either incomplete extractions or premature
optionality. None blocks anything; each is independently shippable
under the "delete dead code" banner.

| Severity | Item | Risk & recommended direction |
|---|---|---|
| MEDIUM | **Email provider switch carrying ~150 LOC of dead code** | [src/lib/email.ts](../src/lib/email.ts) declares an `EmailProvider` interface designed for hot-swapping providers. Today there's only one implementation (`sesProvider`); ~150 lines of fully commented-out Brevo + SendGrid + Postmark providers live in the file with the header comment "kept commented for one release cycle in case we need to revert". `getProvider()` is a one-branch switch returning `sesProvider`. **Trigger**: the cleanup is pure delete with zero behavior change — pick up whenever someone touches email code for any reason. Fix: drop the commented Brevo/SendGrid/Postmark blocks (lines ~114-260), inline `sesProvider` into `sendEmail` or drop the `EmailProvider` indirection (one impl no longer warrants it), delete `getProvider()` + `resolveProviderName()` if it only returns `"ses"`, and drop `@getbrevo/brevo` + `@sendgrid/mail` + `postmark` from `package.json` if still listed. ~150-200 LOC removed, safest cleanup on the list. |
| MEDIUM | **`src/lib/ai/` AiProvider abstraction — incomplete extraction** | [src/lib/ai/](../src/lib/ai/) (3 files, 270 LOC) defines an `AiProvider` interface for "future provider-swap" but the bigger AI consumer ([src/app/api/events/[eventId]/agent/execute/route.ts](../src/app/api/events/%5BeventId%5D/agent/execute/route.ts)) bypasses it and imports `Anthropic` directly. The retrofit was deferred in `docs/HELP_CHATBOT.md` v1.1 and hasn't happened. **Trigger**: next time multi-provider becomes a real requirement (e.g. Ollama fallback for the privacy case the help-chat plan named), commit to the retrofit. Otherwise pick up as cleanup: collapse `getDefaultAiProvider()` + the interface, have help-chat use Anthropic SDK directly like the agent does. Half-extracted abstractions are worse than no abstraction — pick one direction. |
| MEDIUM | **Vercel-deployment vestiges — premature optionality** | The "would I still pick Next.js" reflection flagged "skip Vercel optionality from day 1" as the #1 hindsight call. The Vercel-conditional surface is still in code: [src/lib/logger.ts:7](../src/lib/logger.ts#L7) picks log destination via `isVercel`, [src/app/api/logs/route.ts:12](../src/app/api/logs/route.ts#L12) defaults log source on Vercel, [src/lib/env.ts:62-73](../src/lib/env.ts#L62) issues Vercel-specific warnings, [vercel.json](../vercel.json) is the full Vercel config, [src/lib/storage.ts](../src/lib/storage.ts) `STORAGE_PROVIDER=supabase` branch exists for Vercel's read-only fs. Production deploys EC2 only; the conditionals always evaluate the same way. **Trigger**: paying down the cognitive cost of "should this work on Vercel too?" every time touching env, storage, or logging code. Fix: delete `vercel.json`, hardcode EC2 paths in logger + env (or drop the warnings entirely), keep `local` storage path + delete `uploadSupabase`/`deleteSupabase` and the `PROVIDER` switch. ~5-10 files touched, each diff small. Bigger sweep than the email cleanup but the optionality cost is real. |

**Confirmed-justified abstractions** worth NOT touching (surfaced in the same audit, listed so a future review doesn't re-flag them):
- `src/services/` (5 services × 2 callers each — REST + MCP — exact "two callers → extract" rule)
- `src/lib/agent/tools/` (14 domain files, 7574 LOC — single file would be unmaintainable)
- `src/lib/certificates/email-tokens.ts` vs `email-tokens-resolver.ts` (client-safe vs server-only split)
- `STORAGE_PROVIDER=local|supabase` switch (documented DR-gap closer in `docs/EC2_HARDENING.html`)
- Worker advisory locks + dual-write window (real distributed-systems concern: Singapore DR + Mumbai both up)
- `src/lib/api-errors.ts` `zodErrorResponse()` (~45 callers, removes silent-failure mode)
- `src/lib/api-fetch.ts` `ApiError` (only 1 consumer but `STALE_WRITE` 409 → refetch branching is real value; lift inline only if it stays at 1 consumer for 6 more months)

### Automated security-scanning regime (June 8, 2026)

Drafted in a Claude Code mobile-app planning session over the weekend
as commit `f555808` ("docs: add comprehensive security scanning
strategy"). The commit never pushed (mobile-app sandbox session
ended without `git push`), so the files don't exist in this repo.
The configuration content is preserved verbatim below so it can be
adopted whenever the trigger conditions fire — no need to reconstruct
from scratch.

**Decision: deferred — not overengineering the underlying need, but
the proposed solution is two sizes too big for solo-dev maturity.**
Reasoning captured in the trigger criteria below.

**What was drafted:**
1. `docs/SECURITY_SCANNING.md` (~837 lines, content lost when the
   mobile session ended without push)
2. `.zap/rules.tsv` (62 lines, OWASP ZAP rule severity assignments —
   IGNORE/WARN/FAIL) — preserved below
3. `.snyk` (43 lines, dependency-scan policy file with quarterly-
   review discipline + comment-block enforcing reason/expires/
   approver on every ignore) — preserved below
4. `.github/workflows/zap-scan.yml` (workflow targeting a
   non-existent `staging.meetingmindsgroup.com` after a
   non-existent "Deploy to Staging" workflow) — preserved below
5. `.github/workflows/snyk.yml` (dep-scan + Snyk Code SAST, daily
   schedule + push + PR triggers) — preserved below

**Why deferred:**
- EA-SYS is solo-dev with mid-maturity security posture already (5
  past audit cycles shipped: `b933fda`, `004510c`, `6aed51b`,
  `2cb7af7`, `ff3b7e0`; independent code-review-agent process for
  every non-trivial change; `denyReviewer` + `denyFinance` +
  `buildEventAccessWhere` centralized guards; Stripe webhook HMAC
  verification; Sentry + admin-alert pipelines; org-bound queries
  with cross-tenant IDOR audits already-completed; PDPL-aware data
  residency via Mumbai S3 + Singapore DR).
- ZAP workflow targets a staging environment that doesn't exist
  (per saved feedback `feedback_dev_local_storage_prod_only_uat.md`,
  explicit "prod-only UAT" decision). Building staging just to run
  ZAP is 3-5 days of infra work for a tool that mostly catches what
  React default-escape, Tiptap content-sanitization, and past audits
  already address.
- ZAP workflow's `fail_action: false` directly contradicts the
  `.zap/rules.tsv` FAIL section claim "must block deployment" — one
  or the other has to change before commit.
- ZAP workflow rules.tsv has an internal contradiction: rule 10020
  ignores "X-Frame-Options not set" because "CSP frame-ancestors is
  used instead", but rule 10038 warns "CSP Header Not Set" — those
  two can't both be true.
- Snyk workflow pins `snyk/actions/node@master` (supply-chain risk
  per OWASP CICD-SEC-8 — should pin to SHA or tagged release).
- Snyk workflow emits a JSON report (`--json-file-output`) but never
  uploads it as an artifact — file evaporates at job-end.
- Snyk workflow doesn't emit SARIF, so findings stay siloed in
  Snyk's web UI instead of appearing in the repo's Security tab,
  PR annotations, or alerts feed.
- Snyk Code (their SAST) duplicates ~70% of what the code-review-
  agent process already catches contextually.
- Scanner triage time ≈ feature-development time. Solo dev with a
  feature backlog the size of EA-SYS's = wrong trade-off until
  external pressure forces the shift.

**Trigger to pick up — pick when ANY of these fires:**
1. **Team size > 2** (manual audit doesn't scale; SAST + DAST
   become real value when no one human reviews everything)
2. **Customer asks for SOC 2 / ISO 27001 / HITRUST** (auditors
   want to see scanner reports + suppression policies + cadence
   documentation; ship the whole thing as proof of due diligence)
3. **Regulator inquiry about PDPL / GDPR posture** (same)
4. **Adding ANY new feature that takes user-supplied HTML or
   markdown beyond what Tiptap already covers** (Tiptap is
   sanitized; a new content path may not be — worth a targeted
   ZAP active scan against that endpoint specifically as a
   one-off, NOT a full scanning regime)
5. **Stripe webhook handler refactor or any change touching the
   payment flow that's NOT covered by the existing HMAC + Sentry
   pipeline** (payment flow changes have outsized blast radius;
   worth a one-off Burp/ZAP active scan against that endpoint
   specifically)
6. **The lighter-weight alternative below ever produces noise
   the team can't keep up with** (counterintuitive trigger: if
   `npm audit` + Dependabot + secret scanning ARE catching real
   things and you're triaging them weekly, you've graduated to
   needing the heavier-weight regime)

**The lighter-weight alternative — IF you want SOMETHING shipped
without committing to the full regime (45 min total):**
- Verify Dependabot security updates are enabled (probably already
  on by GitHub default — Settings → Code security)
- Enable GitHub secret scanning + push protection (free for private
  repos; would have caught the `AWS_ACCESS_KEY_ID` in `.env` from
  Friday's CloudWatch test)
- Add `npm audit --audit-level=high` as a one-line CI step in the
  existing `.github/workflows/deploy.yml` (catches the same CVEs
  Snyk's free tier catches)
- Document the existing security posture in
  `docs/SECURITY_POSTURE.md` (auditors/customers ask for this; you
  have a sellable narrative already — past audit cycles, centralized
  guards, signed webhooks, Sentry + admin-alert anomaly detection,
  data residency, ad-hoc code-review-agent process). The narrative
  IS the deliverable. Don't conflate "we don't run automated
  scanners" with "we don't have security" — they're not the same.

**Preserved configuration content (verbatim from the mobile session,
do not re-engineer from scratch when picking up):**

`.zap/rules.tsv`:
````
# OWASP ZAP Rule Configuration for EA-SYS
# Format: RuleID	Action	Description
# Actions: IGNORE (suppress), WARN (report but don't fail), FAIL (block deploy)

# IGNORE — False positives or not applicable to EA-SYS
10096	IGNORE	Timestamp Disclosure - Timestamps in responses are intentional
10027	IGNORE	Information Disclosure - Suspicious Comments
10015	IGNORE	Re-examine Cache-control Directives — RECONSIDER: MEMBER finance routes use Cache-Control: no-store deliberately
10049	IGNORE	Non-Storable Content
10050	IGNORE	Retrieved from Cache
10020	IGNORE	X-Frame-Options Header Not Set — RECONSIDER: contradicts 10038 below
10037	IGNORE	Server Leaks Information via X-Powered-By — RECONSIDER: should fix (next.config.ts poweredByHeader: false)
90033	IGNORE	Loosely Scoped Cookie

# WARN — Monitor but don't block deploys
10038	WARN	CSP Header Not Set — RECONSIDER: contradicts 10020 above
10098	WARN	Cross-Domain Misconfiguration — intentional for /api/mcp/*
40025	WARN	Proxy Disclosure
90022	WARN	Application Error Disclosure
10021	WARN	X-Content-Type-Options Header Missing
10036	WARN	Server Leaks Version Information
40026	WARN	HTTP Parameter Pollution
90034	WARN	Cookie Without SameSite Attribute

# FAIL — Critical issues that should block deployment
40012	FAIL	Cross Site Scripting (Reflected)
40014	FAIL	Cross Site Scripting (Persistent)
40018	FAIL	SQL Injection
40022	FAIL	SQL Injection - PostgreSQL
90019	FAIL	Server Side Include
90020	FAIL	Remote OS Command Injection
40009	FAIL	Server Side Request Forgery — VERIFY: comment claims "safe-fetch" but no such lib exists in EA-SYS
40016	FAIL	Directory Traversal
40017	FAIL	External Redirect
40034	FAIL	.env Information Leak
40040	FAIL	CORS Header — Wildcard origin with credentials
````

`.snyk`:
````yaml
# Snyk Policy File for EA-SYS
# Quarterly review cadence. Every ignore MUST have: reason, expires, approved_by.
version: v1.25.0

ignore: {}
patch: {}

language-settings:
  javascript:
    excludeDevDependencies: true
````

`.github/workflows/zap-scan.yml` (DO NOT commit as-is — has 3
critical issues flagged in the review):
````yaml
# Has critical issues: depends on non-existent "Deploy to Staging"
# workflow; targets non-existent staging.meetingmindsgroup.com;
# fail_action: false contradicts rules.tsv FAIL section.
# Fix architecture before adoption (Option A: scheduled scan against
# prod; Option B: local CI scan with npm run dev; both detailed in
# the review).
name: OWASP ZAP Security Scan
on:
  workflow_run:
    workflows: ["Deploy to Staging"]
    types: [completed]
jobs:
  zap-baseline:
    runs-on: ubuntu-latest
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    steps:
      - uses: actions/checkout@v4
      - uses: zaproxy/action-baseline@v0.12.0
        with:
          target: 'https://staging.meetingmindsgroup.com'
          rules_file_name: '.zap/rules.tsv'
          cmd_options: '-a -j -l WARN'
          fail_action: false
````

`.github/workflows/snyk.yml` (DO NOT commit as-is — pin `@master`
to SHA, add artifact upload, add SARIF):
````yaml
name: Snyk Security Scan
on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: '0 8 * * *'
jobs:
  snyk:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'npm'
      - run: npm ci
      - uses: snyk/actions/node@master   # FIX: pin to SHA
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
        with:
          args: >-
            --severity-threshold=high
            --fail-on=upgradable
            --json-file-output=snyk-report.json
      # MISSING: artifact upload of snyk-report.json
      # MISSING: SARIF emission + upload to GitHub Security tab
  snyk-code:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: snyk/actions/node@master   # FIX: pin to SHA + add setup-node
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
        with:
          command: code test
          args: --severity-threshold=high
````

**When picking up the full regime, address the review notes above
BEFORE first commit. Don't ship the configs with the contradictions
intact — that produces noise + erodes trust in the scanner output,
which is the failure mode that kills security regimes in solo-dev
shops.**

### Medium-Term (2–4 Months)

| Feature | Description |
|---|---|
| **Mobile App (PWA)** | Progressive Web App for on-site staff: check-in scanner, badge print, real-time stats — installable on iOS/Android without App Store |
| **Certificate Generation** | Automatic PDF attendance certificates with event branding, downloadable from the registrant portal |
| **Abstract Book / Programme PDF** | Auto-generated event programme PDF (sessions, speakers, abstracts) for download and print |
| **Multi-Event Dashboard** | Cross-event analytics and reporting for portfolio managers |
| **n8n / Zapier Integration** | Webhook triggers on registration, payment, and abstract events for no-code workflow automation |
| **Email Scheduling** | Schedule bulk emails for future send times (reminder emails, pre-event comms) |
| **Duplicate Detection** | Flag and merge duplicate contacts and registrations |

### Long-Term (4+ Months)

| Feature | Description |
|---|---|
| **Multi-Organization Support** | Support multiple independent organizations from a single deployment with isolated data |
| **Custom Registration Fields** | Organizers define custom questions per event (text, dropdown, checkbox) |
| **Networking / Matchmaking** | Attendee profile discovery and meeting scheduling between registered delegates |
| **Sponsor & Exhibition Management** | Manage sponsors, booth assignments, and exhibition floor plans |
| **Live Event Mode** | Real-time session management: live Q&A, polls, session switching, presenter timer |
| **API for Integrations** | Public REST API with API key auth for deep integration with EventsAir, association management systems, and third-party tools |
| **White-Label / Custom Domains** | Custom domain per event (register.myconference.com) with full branding control |

---

## Role & Access Summary

| Role | Access Level | Primary Use Case |
|---|---|---|
| **Super Admin** | Full platform access | Platform management, org setup |
| **Admin** | Full org access | Day-to-day event operations |
| **Organizer** | Assigned events only | Event coordinators and staff |
| **Member** | Read-only dashboard | Stakeholders needing visibility |
| **Reviewer** | Abstracts only | External academic reviewers (cross-org) |
| **Submitter** | Own abstracts only | Speakers submitting papers |
| **Registrant** | Own registration only | Attendees (self-service portal) |

---

## Technical Infrastructure

### Stack
- **Framework:** Next.js 16 (App Router, React 19, TypeScript)
- **Database:** PostgreSQL with Prisma ORM (20+ data models)
- **Authentication:** NextAuth.js v5 with JWT
- **Payments:** Stripe (Checkout, Webhooks, Refunds)
- **Email:** Brevo / SendGrid (switchable via environment variable)
- **AI:** Anthropic Claude API (claude-sonnet-4-6)
- **PDF:** pdfkit + bwip-js (server-side, no external service)
- **Storage:** Local filesystem (EC2) or Supabase Storage

### Infrastructure
- **Production:** AWS EC2 t3.large, Docker Compose
- **Deployment:** GitHub Actions CI/CD with zero-downtime blue-green deploys
- **Monitoring:** Sentry (client + server error tracking, session replay)
- **Logging:** Pino structured logging → `/logs` viewer (file, Docker, or database source)

### Security
- CSRF protection (Origin header validation on all mutations)
- XSS prevention (Zod input validation, content sanitization)
- Path traversal protection on file serving routes
- Role-based API guards on all 75+ endpoints
- bcrypt password hashing
- Rate limiting on public endpoints (registration, checkout, completion form)
- Audit logging for all admin actions
- API key authentication for external integrations

### Scale Benchmarks (Current)
- 75+ REST API endpoints
- 20+ Prisma data models
- 7 user roles with 3-layer enforcement (API, middleware, UI)
- Organization contact store tested to 100,000 contacts
- CSV import supports up to 5,000 rows per file
- Email templates support full WYSIWYG editing with inline CSS for all major email clients

---

## Documentation Index

| Document | Description |
|---|---|
| [DEVELOPMENT_STATUS.md](DEVELOPMENT_STATUS.md) | Detailed feature checklist with API endpoints and implementation notes |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System architecture, data flow, and design decisions |
| [HANDOVER.md](HANDOVER.md) | Full handover document for new developers |
| [SUPPORT_AND_MAINTENANCE.md](SUPPORT_AND_MAINTENANCE.md) | Leadership-oriented operational requirements: what's monitored, recurring tasks, vendor risks, decisions needed from management |
| [infra/cloudwatch/README.md](../infra/cloudwatch/README.md) | CloudWatch Logs runbook — agent setup, IAM policy, log groups + retention, optional alarm/SNS pipeline. Logs flowing live since June 8, 2026. |
| [PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md) | Production environment audit and configuration |
| [SECURITY_AUDIT_FIXES.md](SECURITY_AUDIT_FIXES.md) | Security improvements and fixes applied |
| [agents.md](agents.md) | AI agent tool documentation |
| [PM2_DEPLOYMENT_GUIDE.md](PM2_DEPLOYMENT_GUIDE.md) | PM2 deployment guide |
| [DOCKER_LOGGING_GUIDE.md](DOCKER_LOGGING_GUIDE.md) | Docker logging setup |
| [VERCEL_COMPATIBILITY.md](VERCEL_COMPATIBILITY.md) | Vercel deployment notes and limitations |

---

*This document is intended for executive review. For technical implementation details, refer to DEVELOPMENT_STATUS.md and ARCHITECTURE.md.*
