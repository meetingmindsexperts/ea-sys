# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Changed — Services refactor, Phase 2c (April 23)

Fourth service extracted: `src/services/registration-service.ts` with
`createRegistration()`. Both REST admin POST `/api/events/[eventId]/registrations`
and MCP `create_registration` now delegate. Previously deferred into
Phase 3; moved forward because Phase 0's in-place MCP patches already
aligned the two callers, making this extraction a low-risk
consolidation rather than a new alignment.

Scope
  - Single-create only.
  - OUT of scope for this pass (tackle later): `/api/public/events/[slug]/register`
    (Stripe checkout session + REGISTRANT account creation + orphan
    attendee reuse + invoice auto-creation — different concerns);
    `MCP create_registrations_bulk` (per-row error capture loop).

Centralizes:
  - 9 domain error codes in a finite TypeScript union (EVENT_NOT_FOUND,
    TICKET_TYPE_NOT_FOUND, SALES_NOT_STARTED, SALES_ENDED, SOLD_OUT,
    PRICING_TIER_NOT_FOUND, ALREADY_REGISTERED, INVALID_PAYMENT_STATUS,
    UNKNOWN). REST caller's `HTTP_STATUS_FOR_REGISTRATION_ERROR` map
    is compile-time exhaustive via `Record<CreateRegistrationErrorCode, number>`.
  - Atomic tx: duplicate check (excluding CANCELLED) → attendee create →
    `soldCount` `updateMany` with `{ lt: quantity }` guard → registration
    create with qrCode + serialId.
  - `RegistrationServiceSentinel` class for discriminating ALREADY_REGISTERED
    and SOLD_OUT domain rollbacks from infrastructure failures.
  - Empty-string → null normalization on all optional attendee fields —
    last line of defense against direct-to-service callers storing `""`
    in Contact records or tripping the Prisma title enum.
  - `paymentStatus` defaulting: UNASSIGNED for paid tickets, COMPLIMENTARY
    for free or no-ticket. Stripe-driven states rejected upstream.
  - All side effects awaited-or-fire-and-forget in a fixed order: syncToContact
    (awaited) → refreshEventStats → auditLog (with source=rest|mcp|api,
    requestIp attached only on REST) → notifyEventAdmins (with source-aware
    message) → sendRegistrationConfirmation gated on paid+outstanding. This
    is the Phase 0 drift gate now structurally guaranteed so MCP-created
    paid registrations cannot silently skip the confirmation email again.

Caller reductions
  - REST POST: ~290 → ~45 lines
  - MCP create_registration executor: ~265 → ~85 lines (including
    MCP-specific input coercion and response reshape that stay at the
    tool boundary)

Parity notes (verified by independent review agent — 45/45 checks)
  - REST 201 response body unchanged; same include tree.
  - REST HTTP status codes per error unchanged.
  - REST error message for ALREADY_REGISTERED shifts from "Attendee
    already registered for this event" to "A registration for <email>
    already exists for this event". Dashboard uses the error string for
    toast display only; no exact-match checks observed.
  - MCP response shape fully preserved ({ success, attendee: {slim},
    registration: {slim} }) via explicit reshape in the tool wrapper.
  - MCP auto-pivot hint on ALREADY_REGISTERED preserved
    (existingRegistrationId + suggestion to use update_registration).
  - MCP TICKET_TYPE_NOT_FOUND hint preserved ("Use list_ticket_types to
    get valid IDs").
  - Audit log payload now writes the slim MCP-style summary
    `{ source, ticketTypeId, paymentStatus, status, ip? }` — aligns with
    Phase 1/2a/2b convention.
  - Duplicate check moved INSIDE the transaction (was pre-tx on MCP
    pre-migration). Structurally safer against race-condition holes.

Phase 0 parity test update
  - `__tests__/lib/agent-mcp-parity.test.ts`: tx proxy gains
    `registration.findFirst` to mirror the new in-tx duplicate check.
    `registration.create` mock fixture now returns the full
    `{ attendee, ticketType }` relations the service includes. Both
    changes faithfully mirror the new execution path.

Test coverage
  - 34 new unit tests in `__tests__/services/registration-service.test.ts`
    covering all 9 error codes, SOLD_OUT race, email normalization on
    both dup-check + create paths, paymentStatus defaults, requiresApproval
    override, confirmation email gating (5 cases), audit source variants
    for rest vs mcp, actor-name message variants, side-effect isolation.

Verification
  - `npx tsc --noEmit`           clean
  - `npm run lint`               clean
  - `npm test`                   1000/1000 (was 963; +34 service tests)
  - Independent review-agent     SAFE TO PROCEED (45/45)
  - e2e (manual-registration)    pre-existing login regression, verified
                                 identical on HEAD~ — NOT caused by
                                 Phase 2c; filed separately

### Fixed — Invoice auto-generation + UI label (April 22)

Root cause of a production bug where registrants clicked "View Invoice"
and downloaded a file named `quote.json`, and where the Stripe payment
webhook only surfaced Stripe's own receipt email (not ours with the
receipt PDF attached):

- `createReceipt` / `createInvoice` / `createCreditNote` used to throw
  `"Event code is required for receipt generation"` whenever
  `event.code` was null. The Stripe webhook's fire-and-forget IIFE
  swallowed the throw into `/logs`, so no Invoice/Receipt row was
  ever written, `sendInvoiceEmail()` never ran, and the registrant
  never received the attached-PDF email. The dashboard "Invoice"
  button then fell through to the `/quote` endpoint, which itself
  sometimes served a JSON error that the `<a download>` saved as
  `quote.json`.
- New `resolveEventCode(event, ctx)` helper in `src/lib/invoice-service.ts`
  prefers the admin-set `event.code`; falls back to the **shared**
  `deriveEventCode()` in `src/lib/utils.ts` — the same deterministic
  helper that already auto-populates `event.code` on new event creation
  via `POST /api/events` and MCP `create_event`. Legacy events created
  before that logic now get the same derivation.
- Fire-and-forget backfill writes the derived code to `event.code` on
  first use (`updateMany where code IS NULL`) so subsequent invoices
  for the same event read the stable prefix. Idempotent under webhook
  retries (deterministic input → deterministic code).
- The three creator functions no longer throw on missing `event.code`;
  they run the full flow with the derived code and log a warn so the
  drift still surfaces to ops.
- UI fix: `src/components/invoices/invoice-download-buttons.tsx` —
  when no Invoice or Receipt row exists, the fallback button is now
  labeled **"Download Quote"** (with a FileText icon) instead of the
  misleading "Invoice" label. Registrants always see an honest label
  for the document they're actually getting.

Knock-on benefit: every PDF generator (quote + invoice + receipt +
credit note) shares the `drawInfoBoxes` helper in
`src/lib/pdf/document-layout.ts`, so the right-side box widening from
the previous commit automatically applies to all four document types
— not just the quote.

### Fixed — Confirmation number terminology (April 22)

Registrants were seeing two different values both labeled "Confirmation
Number" at different points in the flow: a short serial (e.g. `002`)
on the registration-confirmation email and a long internal cuid
(e.g. `cmo9uoaji0021r301k3iis6fz`) on the payment-confirmation email.
Same label, wildly different values, no way for the user to tell which
was their "real" reference.

Now:

- "Confirmation #" / "Confirmation Number" → **"Registration #"** across
  all three registrant-facing emails (registration-confirmation,
  payment-confirmation, refund-confirmation).
- The padded serial (`002`) is threaded into every email — same value
  on every touchpoint so the user sees one stable identifier from
  first email through payment through refund.
- Payment-confirmation email gains a new distinct **"Payment Reference"**
  row carrying the Stripe payment intent id (`pi_3...`). That's the
  transaction-level identifier needed for reconciliation, now clearly
  separate from the registration number.
- Stripe webhook (`src/app/api/webhooks/stripe/route.ts`) threads
  `serialId` + `paymentIntentId` into `sendPaymentConfirmationEmail`.
- Refund route (`src/app/api/events/[eventId]/registrations/[registrationId]/refund/route.ts`)
  threads `serialId` through too so refund emails stay consistent.

### Fixed — Quote PDF right-side box cramped (April 22)

Reported via screenshot: the right-side meta box on the Quote PDF
(Date / Quote Reference / Billing Email / Billing Phone) was too
narrow — a standard 30-char billing email like
`vivek@meetingmindsdubai.com` wrapped across two lines and collided
with the phone row below.

Rebalanced `drawInfoBoxes` in `src/lib/pdf/document-layout.ts`:
- Right box 38% → 48% of page width (left 62% → 52%).
- Internal split: label column 45% → 38%; value column 50% → 60% of
  the right box. Value column gains ~45% more horizontal room.
- `lineBreak: false` on the value column so pathological inputs clip
  rather than overlap the row below.

Applies to all four PDF types (Quote, Invoice, Receipt, Credit Note)
because they share the same layout helpers.

### Changed — Services refactor, Phase 2b (April 22)

Third service extracted: `src/services/speaker-service.ts` with
`createSpeaker()`. Both REST `POST /api/events/[eventId]/speakers`
and MCP `create_speaker` now delegate. Phase 0 already patched the
MCP drift in-place (audit log, admin notification, full syncToContact
payload); Phase 2b consolidates the two callers onto one function so
they can't drift again.

- Scope: single-create only. Bulk paths (`MCP create_speakers_bulk`,
  `/api/events/[id]/speakers/import-registrations`) use different
  mechanics (`createMany` with `skipDuplicates`, per-row error-capture
  loops) and aren't a fit for a shared single-create service.
- REST POST reduced from ~154 → ~56 lines. MCP executor from ~178 →
  ~78 lines.
- Service normalizes empty-string optional fields (title, bio,
  organization, jobTitle, phone, website, photo, city, country,
  specialty, registrationType) to null as a last line of defense for
  future direct-to-service callers.
- 18 unit tests covering all 3 error codes (EVENT_NOT_FOUND,
  SPEAKER_ALREADY_EXISTS, UNKNOWN), P2002 race path, email
  trim+lowercase normalization, source-tagged audit, admin-message
  variants, side-effect isolation, audit/notify non-blocking, and
  empty-string normalization.

### Changed — Services refactor, Phase 2a (April 22)

Second service extracted: `src/services/abstract-service.ts` with
`changeAbstractStatus()`. Scope is status transitions (UNDER_REVIEW /
ACCEPTED / REJECTED / REVISION_REQUESTED / WITHDRAWN). Field updates
on an abstract stay in the REST PUT handler — they aren't called
from MCP, have no drift risk.

- Centralizes: `requiredReviewCount` gate on ACCEPTED/REJECTED (with
  `forceStatus` admin override, logged as `source: "chair-override"`);
  WITHDRAWN terminal-state guard (intentional tightening of the REST
  path — previously only MCP enforced this); DB update with
  `reviewedAt` bookkeeping on review statuses; fire-and-forget audit
  log; `refreshEventStats`; `notifyAbstractStatusChange` awaited with
  isolated try/catch so a failing email never masks a successful DB
  update (callers see `notificationStatus: "sent" | "failed" |
  "skipped"`).
- Reuses the existing `abstract-review.ts` + `abstract-notifications.ts`
  helpers; doesn't duplicate aggregate computation.
- 24 unit tests covering all 5 error codes, WITHDRAWN idempotent no-op,
  `forceStatus=true` bypass + `source: "chair-override"`, UNDER_REVIEW
  /REVISION_REQUESTED not gated on reviewer count, no-op
  ACCEPTED→ACCEPTED skips notification, notification failure isolation.

### Changed — Services refactor, Phase 1 (April 22)

First service extracted into the new `src/services/` layer. Conventions
locked in that every subsequent service will follow:
- Errors-as-values result type: `{ ok: true, <domain-key>, ... } | { ok: false, code, message, meta? }`
- Already-typed inputs (`Date`, not `string`) — callers parse at their boundary
- Caller identity via `source: "rest" | "mcp" | "api"`, written into `AuditLog.changes.source`
- Service owns the transaction + every side effect; callers only handle auth, Zod, rate limits, HTTP/MCP response shaping

- `createAccommodation` extracted to `src/services/accommodation-service.ts`
  (170 lines of pure domain logic). REST `POST /api/events/[eventId]/accommodations`
  and MCP `create_accommodation` both migrated to call the service.
  Atomic overbooking guard (`updateMany` with `bookedRooms` predicate
  inside `$transaction`) previously duplicated across the two callers
  is now centralized.
- Route handler for accommodation POST reduced from ~210 to ~70 lines.
  MCP tool executor reduced from ~153 to ~80 lines.
- 20 new unit tests covering all 11 domain error codes (MISSING_ASSIGNEE,
  INVALID_DATES, EVENT_NOT_FOUND, REGISTRATION_NOT_FOUND,
  SPEAKER_NOT_FOUND, REGISTRATION_HAS_ACCOMMODATION,
  SPEAKER_HAS_ACCOMMODATION, ROOM_NOT_FOUND,
  GUEST_COUNT_EXCEEDS_CAPACITY, NO_ROOMS_AVAILABLE, UNKNOWN) plus
  audit-log source tagging and non-blocking audit failure.
- `src/services/README.md` documents the convention in full for future
  service extractions.

Non-regression notes (verified by independent review agent):
- REST response shape identical (same `include` tree).
- MCP response shape identical (same slim select + `nights`, same
  auto-pivot hint on `*_HAS_ACCOMMODATION` errors).
- Removed a redundant pre-tx `bookedRooms >= totalRooms` check on the
  REST path — the in-tx re-check is strictly safer (no stale-read race
  window between a pre-check and the actual write).
- `AuditLog.changes` for accommodation creates is now the slim MCP-style
  summary (`{ source, registrationId, speakerId, roomTypeId, nights, ip? }`)
  instead of the full accommodation JSON. The entity is still retrievable
  via `entityId`; this aligns both callers on one shape.

### Fixed — MCP parity with REST admin-create (Phase 0)

An audit of MCP write tools against their REST counterparts surfaced
silent drift where MCP skipped side effects REST fires. Highest-impact
bug: paying registrants created via MCP never received the confirmation
email + quote PDF because the single-create executor didn't call
`sendRegistrationConfirmation`. Phase 0 fixes the confirmed drift
directly in the MCP tools so bug fixes don't wait on the full services
refactor.

#### `create_registration` (MCP)
- Fires `sendRegistrationConfirmation()` (with quote PDF attached) when
  the ticket is paid AND payment is outstanding (`paymentStatus` in
  `UNASSIGNED`, `UNPAID`, `PENDING`). Matches the REST admin-create and
  public-register paths.
- Defaults `paymentStatus` to `UNASSIGNED` for paid tickets,
  `COMPLIMENTARY` for free — matches REST; was falling through to the
  raw Prisma default (`UNPAID`) before.
- Now accepts admin-settable `paymentStatus` input, validated against
  the manual subset (`UNASSIGNED` / `UNPAID` / `PAID` / `COMPLIMENTARY`).
  Stripe-driven states (`PENDING` / `REFUNDED` / `FAILED`) rejected with
  an explanatory error — those are webhook-owned.
- Atomic `soldCount` increment with sold-out guard inside the
  transaction (`updateMany` with `soldCount: { lt: quantity }` predicate).
  Prevents overbooking under concurrent admin + public registrations.
- Generates and persists `qrCode` via `generateBarcode()`. The check-in
  scanner searches by `qrCode` + `barcode`, so MCP-created registrations
  were invisible to it before.
- Calls `syncToContact()` (awaited, full payload), writes `AuditLog`
  entry with `changes.source: "mcp"`, fires `notifyEventAdmins()`,
  refreshes denormalized event stats.
- Enforces the `salesStart`/`salesEnd` window and respects
  `ticketType.requiresApproval` (forces `status: "PENDING"`) — REST
  parity.
- Duplicate-registration check now excludes `CANCELLED` (so a cancelled
  registration no longer blocks re-registration), matching REST.
- Tool input schema gains optional `phone`, `city`, `country`, and
  `paymentStatus` — backward compatible (existing required fields
  unchanged).

#### `create_registrations_bulk` (MCP)
- Atomic `soldCount` increment per row (was silently skipping
  increments, drifting the counter).
- Generates `qrCode` per row.
- Batched admin notification (one per bulk call, not per-row) to avoid
  swamping the admins' inbox on a 100-row import.

#### `create_speaker` (MCP)
- Calls `syncToContact()` with the full payload (title, organization,
  jobTitle, phone, photo, city, country, bio, specialty,
  registrationType) — was previously omitted entirely.
- Writes `AuditLog` entry with `changes.source: "mcp"`.
- Fires `notifyEventAdmins()`.
- Tool input schema gains optional `phone`, `city`, `country`, `photo`,
  `registrationType` — backward compatible.

#### `create_speakers_bulk` (MCP)
- Batched admin notification (one per bulk call, not per-row).

### Added
- `src/services/README.md` — documents the services-layer conventions.
- `__tests__/services/accommodation-service.test.ts` — 20 tests.
- `__tests__/lib/agent-mcp-parity.test.ts` — 18 parity tests covering
  the Phase 0 MCP fixes (email gate, paymentStatus defaults,
  requiresApproval, soldCount tx guard, qrCode, syncToContact, audit,
  notifyEventAdmins, sales-window validation, duplicate-check
  CANCELLED exclusion, full create_speaker sync payload).
- `docs/SYSTEM_DESIGN.html` — new "Route Handlers & Services" section
  under Architecture (local-only, gitignored).

### Chore
- Synced `package-lock.json` to 0.3.4 (drifted from `package.json`
  across prior Wave 1 version bumps; CI's package-lock sync check
  was failing on main).

---

## [2026-04-21] - Payment status UNASSIGNED, email history, admin-create quote email

A multi-day round bundled together: new `UNASSIGNED` PaymentStatus for
admin-created registrations, per-person email history surfacing every
transactional send, consolidation of PaymentStatus/RegistrationStatus
dropdowns onto the Prisma enum, and auto-send of the confirmation +
quote PDF when an admin manually adds a registration that still owes
money. Plus a round of logging hardening so no send happens silently.

### Added

- **`PaymentStatus.UNASSIGNED` enum value** for registrations admins
  create manually where payment is intentionally pending. Migration
  `20260421000000_add_unassigned_payment_status` adds the value; a
  follow-up corrective migration `20260421120000_reapply_unassigned_and_email_log`
  re-applies it idempotently (`ADD VALUE IF NOT EXISTS`) because the
  first migration reported "No pending migrations to apply" on prod
  while the enum hadn't actually gained the new value.
- **Payment Status dropdown on the Add Registration dialog and full-page
  `/events/[eventId]/registrations/new`.** Admin-settable subset:
  `UNASSIGNED` / `UNPAID` / `PAID` / `COMPLIMENTARY`. Stripe-owned states
  (`PENDING` / `REFUNDED` / `FAILED`) are deliberately excluded — the
  webhook owns those transitions. New-page form puts the dropdown next
  to the Registration Type in a 2-column grid. Default: `UNASSIGNED`
  for paid tickets, `COMPLIMENTARY` for free.
- **Inline click-to-sort on the events list.** The Event and Date column
  headers in `event-list-client.tsx` are now clickable links that cycle
  `name ↕ startDate ↕ createdAt` with asc/desc toggles reflected in
  `?sort=&order=` query params. Replaced the earlier above-grid
  dropdown. Zod-validated parser at `src/lib/event-sort.ts`.
- **Preflight "already registered" check on signup Step 1.** New
  `POST /api/public/events/[slug]/check-email` (20/hr/IP) returns a
  non-enumerable `{ exists, reason }` payload. The "Continue" button on
  `/e/[slug]/register/[category]` Step 1 and `/e/[slug]/abstract/register`
  Step 1 runs the probe after client-side validation passes and blocks
  the step advance with an inline "Already registered — Sign in instead"
  banner. Server-side duplicate check at the final POST stays in place
  as the race-safety net.
- **Per-person email history.** New `EmailLog` Prisma model (`id`,
  `organizationId`, `eventId`, `entityType`, `entityId`, `to`, `cc`,
  `bcc`, `subject`, `templateSlug`, `provider`, `providerMessageId`,
  `status`, `errorMessage`, `triggeredByUserId`, `createdAt` — with
  indexes on `[entityType, entityId]`, `organizationId`, `eventId`,
  `to`, `createdAt`). Wrapper around `sendEmail()` writes one row per
  send with status `SENT` / `FAILED`; read via
  `GET /api/email-logs?entityType=&entityId=`. An **Email History card**
  renders at the bottom of the registration detail sheet, speaker
  detail sheet, and contact detail sheet, showing sent time (relative) +
  subject + status badge + provider message id. Migration
  `20260421000100_add_email_log` (re-applied idempotently by the
  corrective migration alongside UNASSIGNED).
- **E2E spec `e2e/manual-registration.spec.ts`.** Admin logs in, visits
  `/events/[id]/registrations/new`, picks the Standard ticket, asserts
  the Payment Status dropdown defaults to "Unassigned", fills minimal
  attendee fields, submits, verifies the `UNASSIGNED` badge appears on
  the list row. Also updates `public-registration.spec.ts` +
  `abstract-submitter.spec.ts` for the renamed `TitleSelect` labels
  (`Dr` → `Dr.` etc.) — those specs were failing on main before this.

### Changed

- **PaymentStatus + RegistrationStatus dropdowns now enum-driven.** New
  `src/app/(dashboard)/events/[eventId]/registrations/registration-enums.ts`
  module is the single source of truth — imports the Prisma-generated
  enum (compile-time static, zero runtime cost, no DB) and exports
  exhaustive `Record<PaymentStatus, string>` label + colour maps (TS
  fails the build if a future enum value is added without a label/colour),
  plus `DISPLAY_ORDER` arrays guarded by a module-init `assertCovers()`
  runtime check. The detail-sheet edit dropdowns, list filter,
  Add Registration dialog, and full-page create form all map over the
  enum instead of hardcoding `<SelectItem>` lists. `types.ts` now
  re-exports the colour maps from this module; `Registration.status` /
  `paymentStatus` typed as the Prisma enum (were `string`).
- **Confirmation + quote PDF now auto-sent on admin registration
  create** ([src/app/api/events/[eventId]/registrations/route.ts](src/app/api/events/[eventId]/registrations/route.ts))
  when `paymentStatus ∈ {UNASSIGNED, UNPAID, PENDING}` AND
  `ticketPrice > 0`. Reuses the existing `sendRegistrationConfirmation()`
  helper (it already attaches the quote PDF when `price > 0 &&
  organizationName`) — the admin POST just never called it. Skipped for
  `PAID` / `COMPLIMENTARY` (admin settled) and for Stripe-driven
  `REFUNDED` / `FAILED` (admin can re-send manually from the detail
  sheet). The event `select` was widened to carry the organization
  company block + tax/bank fields the PDF renderer needs.
- **PaymentStatus + RegistrationStatus Zod schemas switched to
  `z.nativeEnum`** across the PATCH route
  ([src/app/api/events/[eventId]/registrations/[registrationId]/route.ts](src/app/api/events/[eventId]/registrations/[registrationId]/route.ts))
  and three MCP tool registrations in
  [src/lib/agent/register-mcp-tools.ts](src/lib/agent/register-mcp-tools.ts).
  Before: hardcoded `z.enum([...])` lists that were missing `UNASSIGNED`
  after the enum rollout, silently rejecting detail-sheet saves and
  MCP write attempts. Now drift-proof.
- **Email send is never silent.** Every remaining `sendEmail()` call
  site now passes `logContext` so each send produces an `EmailLog` row
  linked to the relevant speaker / registration / user (visible on
  their detail-sheet Email History card): abstract submission
  confirmation → `SPEAKER`; submitter signup welcome → `SPEAKER` (with
  post-txn id lookup); password reset → `USER`; org user invitation →
  `USER`; reviewer invitation → `USER`; webinar panelist invite →
  `SPEAKER` if matched, `OTHER` otherwise; MCP agent bulk email →
  per-recipient `SPEAKER` / `REGISTRATION`. `sendEmail()` itself now
  emits `apiLogger.warn("sendEmail called without logContext")` if a
  future caller forgets — the warning surfaces in stdout, `logs/app.log`,
  and `docker logs`, catching drift before it hits production.
- **Four silent `.catch(() => {})` swallows hardened** — push.ts stale
  device-token delete + three `notifyEventAdmins` fire-and-forget
  paths (submitter signup, public register, accept-invitation) now
  log via `apiLogger.warn` so failures aren't invisible.

### Fixed

- **Prod enum was out of sync after deploy.** The initial
  `20260421000000_add_unassigned_payment_status` + `20260421000100_add_email_log`
  migrations were recorded in `_prisma_migrations` as applied but their
  SQL hadn't actually run on the prod Postgres. Added a corrective
  migration `20260421120000_reapply_unassigned_and_email_log` that
  idempotently re-applies both using `ALTER TYPE ... ADD VALUE IF NOT
  EXISTS`, `CREATE TABLE IF NOT EXISTS`, and `DO $$ ... $$` guards around
  FK constraints (Postgres has no `ADD CONSTRAINT IF NOT EXISTS`).
- **E2E suite green again.** `public-registration.spec.ts` and
  `abstract-submitter.spec.ts` had been failing on main after the
  TitleSelect renamed its labels from `Dr` to `Dr.`; updated both specs
  for the new labels. Full 7-spec suite now green in under 20s.

### Tech debt paid

- **Node runtime pin.** Added `engines: { node: "22.x", npm: "10.x" }`
  to `package.json`, `engine-strict=true` to `.npmrc`, and regenerated
  the lockfile under the matching runtime. CI had been silently failing
  on `npm ci` lockfile drift because contributors were on different
  Node versions. Subsequent `chore(runtime): upgrade to Node 24 / npm 11`
  moved the floor forward cleanly once pinned.

---

## [2026-04-14] - Abstracts flow audit + fixes

End-to-end audit of the abstracts feature surfaced four issues — one
regression from the prior public-registration task, one genuine IDOR, one
missing notification path in the AI agent, and an HTML escaping gap in
review emails. All four landed in this change. No schema migration.

### Fixed

- **Regression: `/e/[slug]/submitAbstract` form failed server validation.**
  The prior public-registration task tightened the submitter server schema
  (title/role/organization/jobTitle/phone/city/country/specialty required)
  but only updated the canonical `/e/[slug]/abstract/register` form. A
  second public form at [src/app/e/[slug]/submitAbstract/page.tsx](src/app/e/[slug]/submitAbstract/page.tsx) —
  reachable from external bookmarks and old emails — kept its permissive
  schema and broke every submission with 400 "Invalid input". Brought it
  to parity: added `TitleSelect`/`RoleSelect`/`customSpecialty`, flipped
  org/jobTitle/phone/city/country from `.optional()` to `.min(1, ...)`,
  added the same `customSpecialty`-required-when-"Others" `.refine()`,
  updated `STEP_FIELDS.details` so "Continue" validates the full detail
  set, added asterisks to all newly-required labels, and rewired the POST
  payload to send the new fields explicitly.

- **IDOR on `GET /api/events/[eventId]/abstracts/[abstractId]`.** The
  handler validated event access via `buildEventAccessWhere()` but did
  **not** check that the abstract's speaker belonged to the current
  SUBMITTER. A submitter with a speaker record in an event could fetch
  any abstract ID in that event — including `reviewNotes`, `reviewScore`,
  `criteriaScores`, and other speakers' identities. The PUT handler
  correctly had the ownership check at
  [abstractId/route.ts:146-149](src/app/api/events/[eventId]/abstracts/[abstractId]/route.ts#L146-L149);
  GET now mirrors it at
  [abstractId/route.ts:82-87](src/app/api/events/[eventId]/abstracts/[abstractId]/route.ts#L82-L87)
  and returns 404 (not 403) to avoid existence leak.

- **AI agent `update_abstract_status` tool skipped the speaker
  notification + audit log.** When an organizer used the agent
  ("accept all abstracts from track X") instead of the dashboard UI,
  the speaker was never told their abstract had been accepted/rejected
  and no audit row was written. The dashboard PUT route and the agent
  tool were two entry points doing different things. Extracted the
  notification side effects into a shared helper
  [src/lib/abstract-notifications.ts](src/lib/abstract-notifications.ts)
  called from both places — dashboard and agent now produce identical
  speaker emails + admin notifications. Agent tool also now writes an
  audit log row with `changes.source: "agent"` so admin actions made via
  the agent show up in the audit trail.

- **`reviewNotes` HTML interpolation in speaker emails was unescaped.**
  A reviewer submitting
  `<a href="https://evil.example/phish">Click here</a>` as their notes
  got their HTML delivered verbatim. Real risk was phishing-via-injected-
  link rather than script execution (email clients sanitize `<script>`).
  Fixed inside the new notification helper via a local `escapeHtml()`
  that replaces `& < > " '` before interpolation. One fix covers both
  dashboard and agent code paths.

### Changed

- `PUT /api/events/[eventId]/abstracts/[abstractId]` now delegates the
  post-update email/notification block to
  `notifyAbstractStatusChange()`. Behavior unchanged for callers; the
  ~45-line inline block is now a single call. Imports in
  [abstractId/route.ts](src/app/api/events/[eventId]/abstracts/[abstractId]/route.ts)
  were pruned (`sendEmail`, `getEventTemplate`, `getDefaultTemplate`,
  `renderAndWrap`, `getAbstractStatusInfo`, `brandingFrom`,
  `notifyEventAdmins`) — all now live behind the helper.

- `src/lib/agent/event-tools.ts` `updateAbstractStatus` tool now fetches
  `speaker.email`/`firstName`/`lastName` + `event.name`/`slug` in the
  pre-check query so it can pass them to the helper. Audit log write was
  added.

### Not changed (deferred / out of scope)

- **`GET /api/events/[eventId]/abstracts` list has no pagination cap** —
  admin-only endpoint; the AI agent's `list_abstracts` already caps at
  200 but the dashboard-facing API route doesn't. Documented in the plan
  file for future work.
- **Zod error details returned in 400 responses** — pre-existing
  project-wide convention; the dashboard form uses `details` to highlight
  invalid fields.
- **Non-blocking email sends that `.catch` → `apiLogger.error`** —
  pre-existing pattern project-wide; not specific to abstracts.
- **Concurrent-edit race on `reviewedAt`** — vanishingly unlikely in a
  single-reviewer-per-abstract workflow.

### Verified not a problem

- POST /abstracts correctly calls `denyReviewer()` at
  [abstracts/route.ts:107-109](src/app/api/events/[eventId]/abstracts/route.ts#L107-L109)
- CSV import status validation correctly uppercases before the set check
  at [import/abstracts/route.ts:132-133](src/app/api/events/[eventId]/import/abstracts/route.ts#L132-L133)
- DELETE handler correctly enforces SUPER_ADMIN at
  [abstractId/route.ts:334-339](src/app/api/events/[eventId]/abstracts/[abstractId]/route.ts#L334-L339)

---

## [2026-04-14] - Public Registration Required Fields

Tightened client + server validation on all three public registration entry
points so attendees, abstract submitters, and CSV-imported registrants must
provide their full contact details. Admin dashboard, CSV import, and registrant
self-service forms are intentionally **not** affected — they use separate Zod
schemas and keep their existing permissive rules.

### Changed

**Newly-required fields on public forms** (previously optional):
- `jobTitle` (Position)
- `organization` (Organization)
- `city` (City)
- `phone` (Mobile Number)

Fields already required (unchanged, listed for completeness): `title`,
`firstName`, `lastName`, `email`, `country`, `specialty`, `role`.

**Conditional validation** (new): `customSpecialty` is now required when
`specialty === "Others"` — enforced via `.refine()` on both client and
server schemas. Before, it was always optional and silently dropped.

### Files modified

**Main registration form** (`/e/[slug]/register/[category]`):
- `src/app/e/[slug]/register/[category]/page.tsx` — client Zod schema
  tightened; asterisks added to Position / Organization / Mobile Number /
  City / Others (specify) labels
- `src/app/api/public/events/[slug]/register/route.ts` — server Zod schema
  mirrored; `customSpecialty` refine added at the bottom of the object

**Abstract submitter form** (`/e/[slug]/abstract/register`):
- `src/app/e/[slug]/abstract/register/page.tsx` — client schema tightened;
  labels updated
- `src/app/api/public/events/[slug]/submitter/route.ts` — server schema
  tightened (was more permissive than the client — `title` and `role` were
  `.optional()` on the server even though the client required them; now
  strict on both sides). Fixed a pre-existing bug where `customSpecialty`
  was validated but never persisted to `Speaker` or synced to `Contact`.
  Dropped the now-redundant `...(data.organization && { organization: ... })`
  conditional spreads since these fields are now guaranteed non-empty

**Token-based completion form** (`/e/[slug]/complete-registration`):
- `src/app/e/[slug]/complete-registration/page.tsx` — schema tightened; also
  promoted `role` and `specialty` from read-only display to editable form
  fields (they were only shown as read-only when pre-filled from CSV,
  leaving no way for the registrant to supply them if the CSV didn't
  include them). Added `RoleSelect`, `SpecialtySelect`, and the conditional
  "Others (specify)" input. Removed the dead read-only block
- `src/app/api/public/events/[slug]/complete-registration/route.ts` —
  server schema tightened; `attendee.update` now writes `role`, `specialty`,
  `customSpecialty`; `syncToContact` receives all of them; confirmation
  email uses the newly-submitted values instead of stale `attendee.*`
  snapshots; `GET` response selects `customSpecialty` so the client can
  pre-fill it

### Not affected (intentional)

- `src/app/api/events/[eventId]/registrations/route.ts` — admin
  `createRegistrationSchema` still requires only `email` / `firstName` /
  `lastName`
- `src/lib/csv-parser.ts` + CSV import dialog — no changes; CSV import still
  accepts sparse rows
- `src/app/api/registrant/registrations/route.ts` — registrant self-edit
  still permissive

### Rationale

The exploration phase confirmed all three public forms use separate Zod
schemas from the admin/CSV/self-service paths, so tightening public
validation had zero blast radius on non-public flows. The user's intent:
collect full contact details up front from anyone registering themselves
via the public web forms, without making admin-side bulk operations
harder.

---

## [2026-04-13] - Webinar Events as First-Class (Phases 1–5)

Turns `eventType = 'WEBINAR'` from a cosmetic label into a differentiated
event mode. Creating a webinar now auto-provisions an anchor session + Zoom
webinar, wires up a 5-phase email sequence, polls Zoom for the cloud
recording, fetches the attendance report, and surfaces everything in a
dedicated Webinar Console. Three commits:
- `f3921d7` feat(webinar): first-class webinar events (phases 1–3)
- `8e212f7` feat(webinar): cloud recording retrieval (phase 4)
- `12497fa` feat(webinar): attendance tracking (phase 5)

### Added

**Phase 1 — Conditional UI** (no schema)
- `src/lib/webinar.ts` with `isWebinar()`, `webinarModuleFilter()`, `WEBINAR_HIDDEN_MODULES` constant
- Sidebar filters out Accommodation, Check-In, Promo Codes, Abstracts, Reviewers for WEBINAR events; surfaces a new "Webinar Console" link under Overview
- Settings page hides Abstract Themes + Review Criteria tabs for webinars
- Symmetric filter handles `webinarOnly` flag so non-webinar events also drop webinar-specific sidebar items

**Phase 2 — Auto-provisioning + Webinar Console** (no schema; `Event.settings.webinar` JSON)
- `src/lib/webinar-provisioner.ts` — idempotent `provisionWebinar(eventId, { actorUserId })`. Creates anchor `EventSession` (event.startDate → event.endDate, fall back to 60-min window), calls `createZoomWebinar()` if org has Zoom configured, persists `settings.webinar` JSON, logs `zoomDurationMs` + `durationMs` + typed `zoomStatus` (`created`/`already-attached`/`not-configured`/`failed`)
- `POST /api/events` fires provisioner fire-and-forget on `eventType === 'WEBINAR'`
- `GET /api/events/[eventId]/webinar` — returns webinar settings + anchor session + zoom meeting, parallelized
- `PUT /api/events/[eventId]/webinar` — update settings (denyReviewer, 20/hr rate limit)
- `POST /api/events/[eventId]/webinar` — manual re-run provisioner (denyReviewer, 10/hr rate limit)
- Webinar Console page at `/events/[eventId]/webinar` — status badge, anchor session card, Zoom join URL + passcode (copy buttons), Start-as-Host, Re-run provisioner, webinar-specific settings form (extracted to child component with lazy-init state to avoid setState-in-effect anti-pattern)
- `useWebinar`, `useUpdateWebinarSettings`, `useProvisionWebinar` hooks + `WebinarConsoleData` type

**Phase 3 — Email sequence** (no schema; uses existing `ScheduledEmail` model)
- 5 default templates in `src/lib/email.ts`: `webinar-confirmation`, `webinar-reminder-24h`, `webinar-reminder-1h`, `webinar-live-now`, `webinar-thank-you`. Variables: `{{joinUrl}}`, `{{passcode}}`, `{{webinarDate}}`, `{{webinarTime}}`, `{{recordingUrl}}` + conditional `{{passcodeBlock}}` / `{{recordingBlock}}` HTML fragments
- `BulkEmailType` union + Zod schema + `slugMap` extended with 5 new types. `executeBulkEmail` now loads anchor session + ZoomMeeting **once** (not per recipient) and enriches `vars` with webinar-specific fields when emailType starts with `webinar-`. Exports `WEBINAR_EMAIL_TYPES` + `isWebinarEmailType()`
- `executeBulkEmail` fix (silently improves every bulk-email type): event fetch now includes `emailFromAddress`, `emailFromName`, `emailHeaderImage`, `emailFooterHtml` so `brandingFrom()` resolves to the per-event sender instead of returning `undefined` and falling back to provider defaults (which was causing "Forbidden" errors when the provider's default sender wasn't authorized)
- `src/lib/webinar-email-sequence.ts`:
  - `enqueueWebinarSequenceForEvent(eventId, actorUserId?)` — creates 4 future rows (`reminder-24h`, `reminder-1h`, `live-now`, `thank-you`), drops phases already in the past, idempotent on existing webinar-* rows, resolves creator from event admins when `actorUserId` not provided
  - `sendWebinarConfirmationForRegistration({ eventId, registrationId, ... })` — immediate direct send (no cron latency)
  - `clearPendingWebinarSequence(eventId)` — deletes PENDING/FAILED/CANCELLED webinar rows so they can be re-enqueued
- Public register route branches on `event.eventType`: WEBINAR events get the new webinar-confirmation path, all others keep `sendRegistrationConfirmation` unchanged
- Provisioner auto-enqueues the sequence after Zoom webinar is created, and re-runs enqueue on the idempotency branch so "Re-run provisioner" refreshes cleared sequences
- `GET /api/events/[eventId]/webinar/sequence` — list rows with status/counts/errors
- `POST /api/events/[eventId]/webinar/sequence` — clear pending + re-enqueue (denyReviewer, 5/hr rate limit)
- Webinar Console gains `EmailSequenceCard` with per-phase status icons, scheduled/sent time, counts, failure errors, and Re-enqueue button
- `useWebinarSequence`, `useReenqueueWebinarSequence` hooks

**Phase 4 — Cloud recording retrieval** (schema: 6 new ZoomMeeting columns + `RecordingStatus` enum)
- `ZoomMeeting` gains `recordingUrl`, `recordingPassword`, `recordingDownloadUrl`, `recordingDuration`, `recordingFetchedAt`, `recordingStatus` + index
- `RecordingStatus` enum: `NOT_REQUESTED`, `PENDING`, `AVAILABLE`, `FAILED`, `EXPIRED`
- Migration `20260413000000_add_webinar_recording_fields` (idempotent `ADD COLUMN IF NOT EXISTS` + `DO $$ EXCEPTION` enum)
- `src/lib/zoom/recordings.ts` — `getZoomRecordings()` calls `GET /meetings/{id}/recordings` (works for meetings and webinars — Zoom treats webinar ids as meetings for recording purposes), returns `null` on 404, throws on other errors. `pickBestRecordingFile()` prefers speaker-view MP4 → any MP4 → any completed file with `play_url`
- `src/lib/webinar-recording-sync.ts` — `syncRecordingForZoomMeeting(zoomMeetingDbId)`. Idempotent state machine:
  - `AVAILABLE` → short-circuit
  - `FAILED`/`EXPIRED` → short-circuit (caller must reset to retry)
  - no endTime / <10 min since end → pending, skip
  - \>7 days since end → flip to `EXPIRED`
  - Zoom 404 → NOT_REQUESTED → PENDING, retry next tick
  - Got file → persist URL/passcode/duration → AVAILABLE
  - All paths emit structured logs with `zoomMeetingDbId` + `durationMs`
- `POST /api/cron/webinar-recordings` — Bearer-auth, up to 10 candidates per tick ordered by `updatedAt` asc, serial loop with 500ms delay when batch >3, per-row try/catch so one bad row can't kill the tick. Suggested crontab:
  ```
  */5 * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" .../api/cron/webinar-recordings
  ```
- `POST /api/events/[eventId]/webinar/recording/fetch` — manual refetch (denyReviewer, 10/hr). Resets FAILED/EXPIRED → NOT_REQUESTED before calling the sync helper so admins can force a retry
- `/api/events/[eventId]/webinar` GET now includes recording fields in `zoomMeeting` select
- `/api/public/events/[slug]/sessions/[sessionId]/detail` returns `zoomMeeting.recordingUrl`/`recordingPassword`/`recordingStatus` + `event.eventType`
- Public session page: emerald "Watch Replay" card replaces Join CTA when session is past and recording is `AVAILABLE`. Amber "Recording processing" spinner when past + `PENDING`/`NOT_REQUESTED`. Join CTA hidden for past sessions (kills the dead-link problem)
- `bulk-email.ts` webinar enrichment now reads `recordingUrl` from ZoomMeeting instead of hardcoded empty. Thank-you email's `{{recordingBlock}}` renders "Watch Replay" button when `AVAILABLE`, "coming soon" fallback otherwise
- Webinar Console `RecordingCard` with 5 UI states (AVAILABLE/PENDING/FAILED/EXPIRED/NOT_REQUESTED), Refetch button gated on session-ended
- `useFetchWebinarRecording` hook

**Phase 5 — Attendance tracking** (schema: `ZoomMeeting.lastAttendanceSyncAt` + new `ZoomAttendance` model)
- `ZoomAttendance` model: `zoomMeetingId`, `eventId`, `sessionId`, `registrationId?`, `zoomParticipantId?`, `name`, `email?`, `joinTime`, `leaveTime?`, `durationSeconds`, `attentivenessScore?`. Unique key `(zoomMeetingId, zoomParticipantId, joinTime)` — a single attendee who leaves and rejoins shows up as multiple segments so rejoin history isn't lost
- Reverse relations on Event, EventSession, Registration
- Migration `20260413010000_add_zoom_attendance` (idempotent `CREATE TABLE IF NOT EXISTS` + `DO $$ EXCEPTION` for FKs)
- `src/lib/zoom/reports.ts` — `getZoomParticipants(orgId, zoomId, type)` walks `next_page_token` cursor with `page_size=300`, hard-stops at 100 pages (30k attendees), returns `null` on 404
- `src/lib/webinar-attendance.ts` — `syncWebinarAttendance(zoomMeetingDbId)`. Idempotent state machine:
  - no endTime / <30 min since end / >30 days since end → pending, skip
  - Zoom 404 → pending + info log
  - Zero participants → mark `lastAttendanceSyncAt`, return synced with zero counts
  - Got participants → build case-insensitive email→registrationId lookup, upsert each row, mark `lastAttendanceSyncAt`
- `attentivenessScore` parser handles `"85"`, `"85%"`, and `85`. Per-row upsert errors caught + counted as `skipped`, never abort the loop
- `POST /api/cron/webinar-attendance` — Bearer-auth, up to 10 candidates per tick. Candidate query re-syncs hourly **only within 24h of session end** (audit fix) so old webinars don't get polled forever. Serial loop with 500ms delay, per-row try/catch. Suggested crontab:
  ```
  */10 * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" .../api/cron/webinar-attendance
  ```
- `GET /api/events/[eventId]/webinar/attendance` — returns `{ kpis, rows }` or CSV via `?export=csv`. KPIs: registered count (CONFIRMED/CHECKED_IN), attended count (unique by email), attendance rate %, avg watch time, total watch seconds, **peak concurrent** (computed via sorted edge-event sweep — handles rejoin segments correctly), `lastSyncedAt`. Parallelized with `Promise.all`
- `POST /api/events/[eventId]/webinar/attendance` — manual re-sync (denyReviewer, 10/hr rate limit)
- CSV export uses RFC-4180 field escaping
- Webinar Console `AttendanceCard`: header with last-synced timestamp + Export CSV + Sync now (gated on session-ended + hasZoom). 4-tile KPI grid. Attendee table: Name / Email / Joined / Watched / Reg # (linked to registration when email matched)
- `useWebinarAttendance`, `useSyncWebinarAttendance` hooks + `WebinarAttendanceData` type

### Infrastructure / observability

- Every sync helper emits structured logs with `durationMs` + context on every return path. Grep `webinar-recording:` or `webinar-attendance:` in prod logs to trace any single row's full state history
- Two new cron routes require EC2 crontab entries (see Added sections above)
- All POST/PUT/DELETE routes use `denyReviewer` + `checkRateLimit` + Zod + `apiLogger.warn` on rate-limit rejection, per CLAUDE.md conventions
- Audit-round fixes: EXPIRED/marker updates wrapped in inner try/catch (can't crash cron ticks); silent state transitions now emit info/warn logs; cron per-row try/catch for defense-in-depth; 24h cap on attendance re-sync to avoid wasting Zoom API calls on old webinars (~97% reduction in post-48h traffic)

### Decouplability

All Phase 1–5 code lives under tightly-scoped namespaces (`src/lib/webinar*`, `src/app/api/events/[eventId]/webinar/*`, `src/app/(dashboard)/events/[eventId]/webinar/*`, `src/app/api/cron/webinar-*`, `src/lib/zoom/{recordings,reports}.ts`) with one-way imports from core. Extraction into a standalone microservice later would require: copying the namespaced files, replacing direct Prisma calls with HTTP calls to ea-sys, and swapping the in-process provisioner invocation for a queue publish. Estimate: 1–2 days of surgery since the boundaries are already drawn.

### Remaining (Phase 6)

Polls/Q&A reports from Zoom + panelist management UI (reuses existing panelists API). Planned to ship as a standalone commit.

---

## [2026-02-19] - Web Log Viewer, Registration Page Redesign, Docker Infrastructure Improvements

### Added
- **Web-based log viewer** at `/logs` (SUPER_ADMIN only):
  - Real-time Docker container logs with beautiful retro-futuristic terminal UI
  - Filter by log level (All, Errors, Warnings, Info)
  - Time range selector (Last 10 min, 1 hour, 6 hours, 24 hours, All)
  - Search/filter by text with real-time highlighting
  - Auto-refresh toggle for live log monitoring
  - Download logs as CSV functionality
  - Scroll to bottom button for new log entries
  - Accessible via Settings → System Logs (SUPER_ADMIN only)

### Changed
- **Registration creation UX** — Converted from modal dialog to dedicated full-page form at `/events/[eventId]/registrations/new`
  - Follows same pattern as speaker creation page
  - Provides more space for form fields and better mobile experience
  - Maintains all functionality: PersonFormFields, ticket type selection, notes

### Infrastructure
- **Docker deployment optimization**:
  - Moved Docker data root from 8GB root volume to 30GB `/mnt/data` volume
  - Installed docker-ce-cli in container for log access via mounted socket
  - Fixed disk space issues by cleaning up old containerd data
  - Added aggressive cleanup before builds in GitHub Actions workflow
  - Configured Docker socket permissions for container access
- **GitHub Actions improvements**:
  - Added `docker system prune -af --volumes` before builds to prevent disk space errors
  - Optimized cleanup process to preserve useful layers

### Fixed
- Docker build failures due to disk space constraints
- Containerd data consuming 4.1GB on root filesystem
- Docker socket permission issues for web log viewer
- Package conflicts during docker-ce-cli installation

---

## [2026-02-18] - Schema Cleanup, Contact Store, n8n API Key Support, EC2 Storage

### Added
- **Contact Store** — org-wide contact repository at `/contacts` with:
  - Paginated list (50/page) with server-side search (name / email / organization)
  - Tag filtering with colored tag pills
  - Add / edit contact (slide-out Sheet), delete
  - CSV bulk import (`POST /api/contacts/import`) with duplicate skipping and per-row error reporting
  - CSV export (`GET /api/contacts/export`) — downloads all org contacts
  - CSV template download button (client-side Blob, no API call) — shows all 8 columns with an example row
  - Contact detail page with full event history derived from Speaker and Registration records
  - "Import from Contacts" one-click flow on Speakers page and Registrations page
  - API routes: `GET/POST /api/contacts`, `GET/PUT/DELETE /api/contacts/[id]`, import, export
  - Reusable `ImportContactsDialog` + `ImportContactsButton` components
  - 7 new React Query hooks: `useContacts`, `useContact`, `useCreateContact`, `useUpdateContact`, `useDeleteContact`, `useImportContacts`, `useExportContacts`
- **API key authentication for `GET /api/events`** — external tools (n8n, Zapier, etc.) can now list all org events without a browser session:
  - Accepts `x-api-key` header or `Authorization: Bearer <key>`
  - Session callers (all roles, including REVIEWER/SUBMITTER) unchanged — `auth()` + `buildEventAccessWhere` role scoping
  - API key callers see all org events (org-level credential)
  - Optional `?slug=` query param on both paths — resolves a human-readable slug to an event ID
- **Photo field for Attendees / Registrations**: `Attendee.photo String?` added to schema; photo URL input in registration detail sheet (edit mode) and thumbnail in view mode
- **Docker data root moved to `/mnt/data`** — 30 GB attached EBS volume; keeps the 8.7 GB root volume free. Configured via `/etc/docker/daemon.json` `data-root`.

### Changed
- **`company` → `organization` renamed** across all three models (`Attendee`, `Speaker`, `Contact`), all API routes, all UI pages, CSV import/export headers, and labels — existing Prisma relation field `Contact.organization` (→ Organization) renamed to `Contact.org` to free the name
- **`Speaker.headshot` → `Speaker.photo`** renamed in schema, all speaker API routes, and speaker UI pages
- `GET /api/events` now falls back to API key validation when no session is present, enabling zero-manual-step n8n workflows

### Migration
- `prisma db push --accept-data-loss` applied for column renames (only test data in renamed columns)

---

## [2026-02-16] - Authenticated Abstract Submission (SUBMITTER Role)

### Added
- **SUBMITTER role** — org-independent restricted user, mirrors REVIEWER pattern (`organizationId: null`, abstracts-only access)
- **Submitter account registration** at `/e/[slug]/register` (public, no auth required)
- `POST /api/public/events/[slug]/submitter` — creates User (role=SUBMITTER) + find-or-creates Speaker record linked to the event
- Validates `event.settings.allowAbstractSubmissions` and `abstractDeadline` before accepting registration
- SUBMITTER-specific abstracts view: own abstracts only, submit dialog auto-selects speaker, edit button for DRAFT/SUBMITTED/REVISION_REQUESTED states
- Review feedback shown read-only to submitters; review actions hidden
- "Call for Abstracts" card on public event page (`/e/[slug]`) links to `/e/[slug]/register`
- Abstract status notification emails on status change (UNDER_REVIEW, ACCEPTED, REJECTED, REVISION_REQUESTED) with login link
- Email templates: `abstractSubmissionConfirmation`, `abstractStatusUpdate` (status-specific gradients)
- `managementToken` field on Abstract model
- Public event API (`GET /api/public/events/[slug]`) now returns tracks and abstract settings

### Changed
- `denyReviewer()` guard now blocks both REVIEWER and SUBMITTER on all non-abstract write endpoints
- Middleware redirects SUBMITTER from non-abstract routes to `/events/[eventId]/abstracts` (same as REVIEWER)
- `buildEventAccessWhere()` adds SUBMITTER branch — scoped by `speakers.some.userId`
- Sidebar shows only "Events" (global) and "Abstracts" (event context) for SUBMITTER
- Header shows "Submitter Portal" fallback; dashboard redirects SUBMITTER to `/events`

---

## [2026-02-11] - Org-Independent Reviewers

### Added
- **Reviewers module**: Per-event reviewer management page at `/events/[eventId]/reviewers`
- Dual add mode: pick from event speakers (links `Speaker.userId`) or invite directly by email (creates standalone REVIEWER account)
- Auto-creates REVIEWER User account with `organizationId: null` and sends invitation email
- API routes: `GET/POST /api/events/[eventId]/reviewers`, `DELETE /api/events/[eventId]/reviewers/[reviewerId]`
- React Query hooks: `useReviewers`, `useAddReviewer`, `useRemoveReviewer`
- "Reviewers" tab in sidebar navigation (hidden from reviewer/submitter roles)

### Changed
- `User.organizationId` made nullable — reviewers created with `organizationId: null`, one reviewer can review across multiple organizations
- `buildEventAccessWhere()` removes org filter for reviewers — scoped only by `event.settings.reviewerUserIds`
- Dashboard redirects reviewers to `/events`; header shows "Reviewer Portal" fallback
- `findOrCreateReviewerUser()` no longer enforces cross-org uniqueness — reviewers re-assignable to any org's events
- Reviewer sidebar shows only **Abstracts** in event context; middleware redirects reviewers from all other event routes
- "Create Event" button hidden for REVIEWER role; middleware redirects `/events/new` → `/events`
- Events list scoped via `buildEventAccessWhere` — reviewers see only assigned events

## [2026-02-10b] - Reviewer API Access Hardening

### Fixed
- **Critical security fix**: Reviewers could previously bypass UI restrictions and call API endpoints directly to create, update, or delete registrations, speakers, tickets, sessions, tracks, hotels, accommodations, and send bulk emails
- Added `denyReviewer()` guard to **29 POST/PUT/DELETE handlers** across **20 API route files** — reviewers now receive 403 Forbidden on all write operations except abstract reviews

### Added
- `src/lib/auth-guards.ts` — reusable `denyReviewer(session)` helper that returns 403 if user is REVIEWER role
- Registrations page refactored into 4 files: `page.tsx` (393 lines), `types.ts`, `add-registration-dialog.tsx`, `registration-detail-sheet.tsx`

### Protected Routes
- Registrations: POST, PUT, DELETE, check-in (POST/PUT), email (POST)
- Speakers: POST, PUT, DELETE, email (POST)
- Tickets: POST, PUT, DELETE
- Sessions: POST, PUT, DELETE
- Tracks: POST, PUT, DELETE
- Hotels: POST, PUT, DELETE + room types (POST, PUT, DELETE)
- Accommodations: POST, PUT, DELETE
- Bulk emails: POST

## [2026-02-10] - Server & Database Optimization

### Changed
- **Speakers page**: Parallelized `params`, `auth()`, event lookup, and speakers query using `Promise.all` — reduces ~3 serial DB roundtrips to 2 parallel batches
- **Event detail page**: Parallelized `params` + `auth()`; switched from `include` (all columns) to `select` (only 9 rendered fields) for smaller query payload
- **Prisma client caching**: Fixed inverted logic — `globalThis` caching now correctly applies only in development (prevents HMR connection leaks); production uses one instance per serverless function
- **Middleware matcher**: Narrowed from catch-all regex to only `/events/*`, `/dashboard/*`, `/settings/*` — public routes (`/e/*`), API routes, auth pages, and static assets no longer invoke middleware

### Added
- Composite database index `[eventId, status]` on Registration for faster status-filtered queries within an event
- Composite database index `[eventId, ticketTypeId]` on Registration for faster ticket-type-grouped queries

### Removed
- Redundant `@@index([slug])` on Organization model (already covered by `@unique` constraint)

## [2025-02-05] - React Query & Performance Improvements

### Added
- **React Query (TanStack Query)** for client-side data caching
  - Instant page navigation with cached data
  - Background data refresh with loading indicators
  - Centralized API hooks in `src/hooks/use-api.ts`
  - Query client configuration in `src/components/providers.tsx`
- React Query integration for dashboard pages:
  - Tickets page (`/events/[eventId]/tickets`)
  - Registrations page (`/events/[eventId]/registrations`)
  - Schedule page (`/events/[eventId]/schedule`)
  - Abstracts page (`/events/[eventId]/abstracts`)
- Loading spinner indicators for background data refresh on all cached pages
- Mutation hooks with automatic cache invalidation

### Changed
- Converted client-side pages from `useState`/`useEffect` to React Query hooks
- Improved perceived performance - subsequent page visits load instantly from cache
- Added loading states to form submit buttons during mutations

## [2025-02-04] - API Performance Optimizations

### Changed
- Optimized all event API routes with `Promise.all()` for parallel queries
- Added Prisma `select` statements to fetch only required fields
- Added cache headers (`stale-while-revalidate`) to API responses
- Made audit log writes non-blocking (fire-and-forget pattern)

### Optimized Routes
- `/api/events/[eventId]` - Event details
- `/api/events/[eventId]/tickets` - Ticket types
- `/api/events/[eventId]/registrations` - Registrations
- `/api/events/[eventId]/speakers` - Speakers
- `/api/events/[eventId]/sessions` - Sessions
- `/api/events/[eventId]/tracks` - Tracks
- `/api/events/[eventId]/abstracts` - Abstracts
- `/api/events/[eventId]/hotels` - Hotels
- `/api/events/[eventId]/accommodations` - Accommodations

## [2025-02-03] - Color Theme Update

### Changed
- Updated application color scheme to Cerulean Blue (#00aade)
- Moved collapse sidebar button to the bottom of the sidebar

## [2025-02-02] - Organization Header Fix

### Fixed
- Organization name now updates correctly in header after changing in settings

## [2025-02-01] - User Invitation System

### Added
- User invitation system with email tokens
- Admins can invite new users via Settings > Users
- Invitation emails sent via Brevo

### Changed
- Renamed application to "MMGroup EventsHub"
- Disabled public user registration (invite-only mode)

## [2025-01-30] - Public Event Pages

### Added
- Public event registration at `/e/[slug]` (no authentication required)
- Public API endpoints at `/api/public/events/[slug]`
- Event confirmation page after registration

## [2025-01-28] - Session Calendar View

### Added
- Calendar view for event sessions at `/events/[eventId]/schedule/calendar`
- Visual session timeline by day

## [2025-01-25] - Bulk Email Feature

### Added
- Bulk email sending to event registrants via Brevo
- Email templates for event communications

## [2025-01-20] - Logging System

### Added
- File-based logging with Pino
- Log files at `logs/app.log` and `logs/error.log`
- Configurable log levels via `LOG_LEVEL` environment variable
- 