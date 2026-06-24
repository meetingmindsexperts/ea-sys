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
| **HIGH** | **Build the Docker image in CI → push to ECR → box pulls** (incident action item #2) | **The actual fix for the OOM class.** Today the build runs TWICE — once in CI (`npx next build`, verification, discarded) and again on the prod box (`docker compose build` in `scripts/deploy.sh`), and the on-box build is what froze the host. Move it: CI does `docker build` → push to a private **ECR** repo (`ap-south-1`); `deploy.sh` replaces `docker compose build` with `aws ecr get-login-password \| docker login` + `docker compose pull`; the blue-green swap is unchanged. Migrations run from the pulled image (`docker run <image> npx prisma migrate deploy`) instead of the on-box `--target builder` image. **Net: the box never runs a memory-heavy build again** — `docker pull` is near-zero CPU/RAM, so no build (EventsAir or anything else) can ever OOM the host. **Code I own:** workflow + `docker-compose.prod.yml` (`build:`→`image:`) + `deploy.sh` + migration step. **AWS (hand commands to operator):** create ECR repo; add ECR-read to the box's instance role; GitHub OIDC role for CI push (no stored keys). Cost: ECR storage ~pennies/month. Rollback becomes "pull a previous tag" (no rebuild). |
| MEDIUM | **`mem_limit` on the prod containers** (incident action item #5) | Hard-bound each container's memory in `docker-compose.prod.yml` so one container/build can't consume all host RAM. Belt-and-braces alongside the CI fix. |
| LOW | **Memory + disk metrics → CloudWatch + alarm** (action item #3) | The CloudWatch agent ships *logs* only; default EC2 metrics don't include memory. Add the mem/disk metrics + an alarm on `mem_available < 500 MB` so pressure pages *before* a freeze. |
| LOW | **External uptime check on `/api/health`** (action item #4) | Route 53 health check or UptimeRobot — catches a frozen-but-"running" box (EC2 status checks don't). |
| — | **Instance sizing — NOT recommended as the fix** | Bumping t3.large (8 GB) → t3.xlarge (16 GB) would give the build headroom, but it's **~+$60/mo (≈2×) of always-on RAM for a few seconds of transient build need**, and it doesn't fix the root cause (building on the prod host) — a future heavier build could still approach the higher ceiling. With swap already added (freeze → slow-down) and the CI/ECR fix above (box never builds), upsizing is unnecessary. Revisit only if the *runtime* footprint (not the build) genuinely outgrows 8 GB. |

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
| **Admin mode-change qrCode minting** | ⚠ The one real correctness gap. Switching an existing registration **virtual→in-person** (via the detail sheet / PUT) leaves `qrCode` null, so they can't be badged or checked in. v1.1: mint a qrCode lazily on the transition (and the reverse — in-person→virtual — keeps the qrCode for audit but suppresses badge/check-in). |
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
| **`LivePlayer` `onStreamStatusChange` ref (LOW)** | The init effect depends on the inline `onStreamStatusChange` prop; harmless on the public page (passed `undefined`), but a future caller passing a non-memoized handler would re-create the 10s poll interval. Wrap/ref it. |
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
| MEDIUM | **`handleNudgeY` re-allocates closure ~30×/sec while holding ArrowDown** | `src/components/certificates/certificate-canvas-editor.tsx` (~355-377) — `useCallback` deps include `textBoxes`. Each nudge mutates it → new closure → new keyDown handler → … On templates with many text boxes on a slow box, measurable allocation churn. Trigger: noticeable input lag during fast-positioning. Fix: read `textBoxes` from a ref inside `handleNudgeY` (already exists for `lastNudgeAtRef`). ~5 LOC. |
| MEDIUM | **`loadPdfBytes` + `escapeHtml` duplicated across worker + route** | `src/lib/certificates/issue-worker.ts` (57-64, 769-781) vs `src/app/api/events/.../resend/route.ts` (similar helpers). Comment in resend route flags it as intentional v1 debt to avoid touching the worker mid-feature. Trigger: next sweep of cert-email code OR any divergence (e.g., new XSS pattern added to one but not the other). Fix: extract `src/lib/certificates/cert-email-helpers.ts`, import from both. |
| MEDIUM | **EmailLogCard "Cert" pill baseline misaligned vs subject text** | `src/components/communications/email-log-card.tsx` (~82, 89-94) — parent is `items-baseline`, pill is `inline-flex items-center`. Pill renders slightly above the subject's typographic baseline on Chrome/Firefox/Safari. Cosmetic only. Fix: `align-self-center` on the pill OR `items-center` on the parent flex. 1 LOC. |
| MEDIUM | **Defensive `recipientEmail` chain doesn't `?.` through Attendee** | `src/app/api/events/.../resend/route.ts` (~251) — `reg?.attendee.email ?? null`. `attendee` is a required FK so won't trigger today, but optional-include semantics in Prisma can return null in edge cases. Trigger: 500 error on resend with stack pointing here. Fix: `reg?.attendee?.email ?? null`. 1 LOC. |
| MEDIUM | **Base64 PDF allocation 2× memory per resend** | resend route + worker — `Buffer.from(arr).toString("base64")` expands ~1.33× in memory. Fine at current 30/hr/user rate; spikes under sustained concurrent resend pressure on small EC2. Trigger: heap growth visible in CloudWatch. Fix: stream SES `RawMessage` attachment (SES v3 SDK supports it). |
| LOW | **Dev-only sentinel renders to prod** | `IssuedCertificatesCard` shows an amber "pass registrationId OR speakerId" panel when both are absent. Comment says "dev-only" but it ships to prod. Trigger: visible. Fix: gate on `process.env.NODE_ENV === "development"` or return null in prod. |
| LOW | **`recipientLabel` template parity** | Registration variant doesn't include `title` even when present (`${firstName} ${lastName} <${email}>`); speaker variant does (`[title, firstName, lastName].filter(Boolean).join(" ")`). Cosmetic in the resend confirm dialog. |
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
