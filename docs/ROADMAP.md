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

### Near-Term (Next 1–2 Months)

| Feature | Description |
|---|---|
| **Wave 4 Testing** | Repeat of waves 1–3 (Performance & Load + Security) covering everything shipped since wave 3. Scope: analytics endpoint + dashboard, on-demand barcode rendering (admin + registrant + inline-CID email), additionalEmail surface across attendee/speaker/MCP/registrant, DTCM toggle + bulk-import path, badge-print tracking + CSV exports, AuditLog composite index growth, MCP `get_event_analytics` + `additionalEmail`/`requiresDtcmBarcode`/speaker `bio`/`photo`/`country` additions, post-2026-05-18 remediation items still on the backlog. Scheduled separately from monthly stability passes — runs as a standalone wave. |
| **External REST API (Phase 3 of services refactor)** | Public-facing API for 3rd-party integrators. Each endpoint is a thin wrapper over a service. **Drives the `registration-service.ts` extraction** (Phase 2c was deferred for exactly this — the API spec is the forcing function that shapes the service). |
| **Abstract → Session Linking (UI)** | Link accepted abstracts to sessions directly from the abstract detail view |
| **Room Type Edit/Delete UI** | Complete the accommodation UI (API already exists) |
| **Accommodation Booking UI** | Full booking creation and management interface |
| **Registration Delete Button (UI)** | Surface the existing delete API in the admin panel |
| **Analytics Dashboard** | Registration trends, revenue summary, check-in rate, abstract acceptance rate by event |
| **Waitlist Management** | Automatic waitlist promotion when registrations are cancelled |
| **Resilience helper (`src/lib/resilience.ts`)** | Shared `withTimeout` / `withRetry` (jittered backoff) / `CircuitBreaker`. Closes the audited gap: Stripe/Zoom/Anthropic SDK calls lean on default timeouts, no bounded-retry, no breaker (repeated failures each pay full timeout). **Decided design:** retry opt-in never default; only reads + idempotent writes; baked-in retryable classifier (5xx/429/network/timeout, never 4xx) with override; in-memory breaker state (same trade-off as `checkRateLimit`, pluggable interface for future Redis); centralized timeout table. **Phasing:** P1 ship helper + tests, no call-site changes; P2 wrap Zoom client / safe-fetch / email send; Stripe idempotency-key retry is a separate, riskier PR — NOT in scope. Full design discussion in session 2026-05-18. |

### Audit Hardening Backlog (deferred from the May 18, 2026 multi-agent review)

The May 18 review (supervisor + React/Prisma/backend/architecture agents)
fixed the 6 source-verified BLOCKER/HIGH findings in commit `ff3b7e0`
(see CLAUDE.md "Recent Features"). The items below were **corroborated by
the reviewers but consciously deferred** out of that batch. Ordered by
severity; each is independently shippable. None is a product feature —
this is correctness / security / silent-failure debt.

| Severity | Item | Risk & recommended direction |
|---|---|---|
| HIGH | **Accommodation overbooking TOCTOU** | `accommodation-service.ts` (~210-255) and `accommodations/[accommodationId]/route.ts` (~188-222) read `roomType.findUnique`, check `bookedRooms >= totalRooms` in JS, then unconditionally `increment` — no row lock, two concurrent bookings on the last room both pass. The "can't double-book by construction" comment is false. Fix: `$executeRaw` conditional `UPDATE … SET bookedRooms = bookedRooms + 1 WHERE id = ? AND bookedRooms < totalRooms` and check affected rows (Prisma can't express a column-to-column `updateMany` predicate). |
| HIGH | **Registration DELETE destroys a shared Attendee** | `registrations/[registrationId]/route.ts` (~601) unconditionally `attendee.delete`s after `registration.delete`; Attendee can be shared across registrations (orphan-reuse + email-change clone). No `onDelete` on the FK → P2003 fails the whole delete, or orphans a still-referenced person. Fix: only delete the Attendee when `registration.count({ attendeeId, id: { not } }) === 0`, inside the same tx. |
| HIGH | **`PricingTier.soldCount` one-way leak** | Public register atomically increments tier soldCount; DELETE + bulk-type-change never decrement it (distinct from the documented-intentional manual-add divergence). Tiers phantom-sell-out. Fix: decrement tier soldCount symmetrically on cancel/delete/type-change where the public path increments. |
| HIGH | **Stripe post-payment side-effects are fire-and-forget, handler returns 200** | `webhooks/stripe/route.ts` (~122-203): invoice + confirmation email run in a detached IIFE after the tx; failure = customer is PAID but never gets invoice/confirmation, permanently, Stripe won't retry, no reconciler. Fix: persist an outbox/intent row in the same tx that flips PAID; drain via an idempotent reconciliation cron (`createPaidInvoice` already promotes-in-place). |
| ~~HIGH~~ | ~~**Registrant invoice/quote routes missing `denyFinance`**~~ | ~~`registrant/registrations/[id]/quote`, `…/invoices`, `…/invoices/[invoiceId]/pdf` — the non-registrant branch scopes by org only; a MEMBER has an org so passes. Add `denyFinance(session)` on the non-registrant branch (registrant-owned access stays exempt).~~ **CLOSED — Core Stability Pass #1, June 1, 2026.** Three routes gated on the non-registrant branch with `denyFinance` + `apiLogger.warn`; REGISTRANT owner path stays exempt. Regression net: 7 tests in `__tests__/api/registrant-finance-routes.test.ts` pin MEMBER → 403 FINANCE_FORBIDDEN before any DB read. |
| MEDIUM | **`refreshEventStats` lost-update** | Fire-and-forget full recompute with no concurrency control; under a burst the last racing `upsert` wins and may have read a pre-burst snapshot → dashboard counts lag with no self-heal. Fix: serialize per-event (in-proc mutex/debounce) and/or a periodic reconcile; `await` where correctness matters. |
| MEDIUM | **~8 silent `safeParse`→400 (claim "0 remain" is false)** | `abstract-themes` POST/PUT, `review-criteria` POST/PUT, `promo-codes` POST/PUT, `notifications/read` POST, `email-logs` GET, `registrations/[id]/email` PATCH (Zod branch). Add `apiLogger.warn` via the existing `zodErrorResponse()` helper. Violates the owner's #1 rule. |
| MEDIUM | **Money rounding/discount divergence** | Stripe `payment-confirmation` email recomputes `basePrice*taxRate` ignoring `discountAmount` and skips `round2` — disagrees with the invoice PDF and `computeRegistrationFinancials` by cents for promo+tax registrants. Fix: build the email totals from `computeRegistrationFinancials`. |
| MEDIUM | **Frontend silent failures** | Bulk-tag failure shows no toast (`bulk-tag-dialog.tsx` + registrations/speakers callers); registrant portal renders "no registrations" on a failed fetch (`e/[slug]/my-registration/page.tsx` — paying customer, worst UX); MEMBER sees write buttons that 403 (registrations list + abstracts) — add a shared `canWrite(role)` gate. Several GET-load handlers swallow `!res.ok`. |
| MEDIUM | **Add-Registration dialog vs full-page drift** | The quick-add dialog never sends `pricingTierId`/`sponsorId`, silently producing tier-less registrations that break "Registrations by Tier" + finance reporting. Port the picker or extract a shared form component. |
| MEDIUM | **MCP finance boundary / OAuth role snapshot** | Finance/MEMBER redaction is enforced only in the in-app agent route; the MCP HTTP path has none, and OAuth access tokens snapshot role at consent and never re-check (a demoted ADMIN keeps a finance-exposing token up to 90 days). Bounded today (MEMBER can't mint keys; consent UI RBAC) but fragile. Fix: move the finance/read-only decision into `runTool` keyed off live role from `token.userId`; revoke tokens on role change. |
| MEDIUM | **Blue-green has no expand/contract guardrail** | `scripts/deploy.sh` runs `prisma migrate deploy` while the old container still serves traffic; safe only because every migration has been additive by convention. The reviewer migration proves destructive ones get written. Add a CI check rejecting `DROP`/`RENAME`/`SET NOT NULL`/enum-value-removal in migration SQL unless an explicit `EXPAND_CONTRACT_OK` marker is present; document the two-phase requirement. |
| LOW | **MCP CORS** | `mcp-cors.ts` reflects any `*.anthropic.com`/`*.claude.ai` origin with `Allow-Credentials: true`. MCP is token-auth (no cookies) so impact is bounded — drop `Allow-Credentials` for the MCP transport or use an exact-origin allowlist. |
| LOW | **Doc drift** | CLAUDE.md references `src/middleware.ts` (now `src/proxy.ts`, Next 16.1 rename), claims "0 silent Invalid-input paths remain" (false — see above), and says stdio MCP "drifts behind HTTP" (stale — both now share `registerAllMcpTools()`). Correct the doc so future audits aren't misled. |

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
| [PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md) | Production environment audit and configuration |
| [SECURITY_AUDIT_FIXES.md](SECURITY_AUDIT_FIXES.md) | Security improvements and fixes applied |
| [agents.md](agents.md) | AI agent tool documentation |
| [PM2_DEPLOYMENT_GUIDE.md](PM2_DEPLOYMENT_GUIDE.md) | PM2 deployment guide |
| [DOCKER_LOGGING_GUIDE.md](DOCKER_LOGGING_GUIDE.md) | Docker logging setup |
| [VERCEL_COMPATIBILITY.md](VERCEL_COMPATIBILITY.md) | Vercel deployment notes and limitations |

---

*This document is intended for executive review. For technical implementation details, refer to DEVELOPMENT_STATUS.md and ARCHITECTURE.md.*
