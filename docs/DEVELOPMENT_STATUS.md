# Event Management System - Development Status

**Last Updated:** June 23, 2026
**Project:** EA-SYS (Event Administration System)

---

## Executive Summary

This document tracks the development status of the Event Administration System. **The detailed phase history below (Phases 1–10, dated changelogs) is preserved as a historical record and reflects its own as-of dates — do not read individual phase "NOT STARTED / Pending" labels as current.** The "Current Status" block immediately below is the authoritative snapshot; for the live feature changelog, [CLAUDE.md → Recent Features](../CLAUDE.md) is the most current source.

### Current Status (June 29, 2026)

**EA-SYS is in live production** ([events.meetingmindsgroup.com](https://events.meetingmindsgroup.com)) running real Meeting Minds Group events — real registrants, payments, check-in. Accountability is high: additive/idempotent migrations only on the shared prod DB, full verification gate (tsc/lint/vitest/build) before every push, blue-green deploys.

**Everything in the "Remaining Phases" section below that predates 2026 is now SHIPPED** — most notably the entire Payment stack (Phase 5/7) which that section still calls "NOT STARTED." What's actually live:

- **Finance:** Stripe Checkout + webhook (signature-verified, idempotent) + refunds + manual/offline payment capture (cash/bank/card-onsite); quote PDF at registration → PAID invoice PDF after payment; tax/VAT; promo codes; pricing tiers; third-party payer (BillingAccount — addable **inline** from the registration form, consolidated org-wide by name); sponsor-paid INCLUSIVE; comp registrations; an **invoice-reconciliation worker** that recovers any invoice the webhook drops. Finance RBAC via `canViewFinance` (only SUPER_ADMIN/ADMIN/ORGANIZER + desk roles see money).
- **Abstracts & reviewers:** themes, weighted review criteria, per-event `requiredReviewCount` gate, per-abstract reviewer assignment (role + **enforced** COI — a conflicted reviewer is 403-blocked from submitting), assignment + pool-add **notification emails**, reviewer-invite resend (surfaces send failures), per-reviewer scoring, `/my-reviews` portal, score aggregation, status-change emails. Submitter-speakers get a companion "Faculty" registration; resubmit-after-revision re-notifies; a DRAFT save no longer emails "submitted".
- **Services layer:** 5 services shipped (`accommodation`, `abstract`, `speaker`, `registration`, `billing-account`) — shared by REST + MCP. The "extract services layer" tech-debt item is **done**.
- **Webinars:** first-class WEBINAR type — auto-provisioning, Zoom embed + custom HLS stream, recording/attendance/**engagement (polls + Q&A)** sync, producer-gated waiting room with real-time presence (June 23).
- **Speaker-as-attendee + multi-role certificates (June 25, 2026):** every speaker auto-gets a linked comp "Faculty" registration so they receive badge / barcode / DTCM / check-in / survey (excluded from delegate counts); certificates are now **per-template** (one person can hold several role-specific certs — Speaker + Moderator + Committee), each with its own role label + manually-entered CME hours (`{{role}}` / `{{cmeHours}}` tokens). Plan + status: [docs/SPEAKER_AS_ATTENDEE_PLAN.md](SPEAKER_AS_ATTENDEE_PLAN.md). (Survey-completion auto-issue = the planned Phase 2.)
- **Platform:** MCP server (70+ tools) + OAuth 2.1, AI agent, dedicated background-worker tier (6 jobs, advisory-lock singleton), certificates, surveys, CloudWatch/Sentry/DB logging, Singapore DR (S3 + pg_dump), multiple security audits (latest: June 23 multi-tenant readiness — see [docs/PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md) Round 2).

**Genuinely still open (all non-blocking nice-to-haves / tech debt):** ICS calendar export, session feedback/ratings, attendee directory, PWA, multi-language; a few small UI gaps for API-driven ops (Room-Type edit/delete dialog, abstract→session dashboard picker); email-preferences management; Redis-backed shared cache/rate-limiter; bundle trim + remove unused tRPC deps; staging environment. None block running a conference. See [docs/ROADMAP.md](ROADMAP.md) for the tracked backlog.

### In-flight / near-term

- **Multi-tenant / white-label SaaS** — design reference written ([docs/MULTI_TENANCY.md](MULTI_TENANCY.md)); not yet built. Tenancy model = shared-DB + Postgres RLS default, DB-per-tenant premium, Stripe Connect, custom-domain TLS. The June 23 audit was the pre-multi-tenant cross-tenant hardening pass.
- **External REST API** (Phase 3 of the services refactor) — public REST surface for integrators, backed by the existing services. Partially live (API-key auth on read endpoints + OpenAPI docs at `/api-docs`); broader write surface pending.

---

## Phase 1: Foundation (COMPLETED)

### Database Schema
- [x] PostgreSQL database with Prisma ORM
- [x] Multi-tenant organization support
- [x] User management with role-based access (SUPER_ADMIN, ADMIN, ORGANIZER, REVIEWER)
- [x] Complete event model with status tracking
- [x] Audit logging for all operations

### Authentication
- [x] NextAuth.js integration with JWT strategy
- [x] Credentials-based authentication
- [x] Session management with organization context
- [x] Protected API routes

### Core UI Framework
- [x] Next.js 16 App Router setup
- [x] TailwindCSS styling
- [x] Shadcn/ui component library
- [x] Dashboard layout with sidebar navigation
- [x] Responsive design
- [x] Collapsible sidebar with state persistence
- [x] Tooltip support for collapsed sidebar

### Logging System
- [x] Pino logger integration with pino-pretty
- [x] Module-specific loggers (dbLogger, authLogger, apiLogger)
- [x] Sensitive data redaction (passwords, tokens)
- [x] Configurable log levels via environment variable
- [x] Removed verbose Prisma query logs

---

## Phase 2: Event Core Features (COMPLETED)

### Event Management
| Feature | API | UI | Status |
|---------|-----|-----|--------|
| Create Event | ✅ | ✅ | Complete |
| List Events | ✅ | ✅ | Complete |
| Event Overview Dashboard | ✅ | ✅ | Complete |
| Event Selector in Header | N/A | ✅ | Complete |
| Event Switching | N/A | ✅ | Complete |
| Event Settings/Edit | ✅ | ✅ | Complete |

### Ticket Management
| Feature | API | UI | Status |
|---------|-----|-----|--------|
| Create Ticket Types | ✅ | ✅ | Complete |
| Edit Ticket Types | ✅ | ✅ | Complete |
| Delete Ticket Types | ✅ | ✅ | Complete |
| Ticket Availability Tracking | ✅ | ✅ | Complete |
| Sales Period Configuration | ✅ | ✅ | Complete |

**API Endpoints:**
- `GET /api/events/[eventId]/tickets` - List all ticket types
- `POST /api/events/[eventId]/tickets` - Create ticket type
- `GET /api/events/[eventId]/tickets/[ticketId]` - Get single ticket type
- `PUT /api/events/[eventId]/tickets/[ticketId]` - Update ticket type
- `DELETE /api/events/[eventId]/tickets/[ticketId]` - Delete ticket type

### Registration Management
| Feature | API | UI | Status |
|---------|-----|-----|--------|
| Create Registration | ✅ | ✅ | Complete |
| List Registrations | ✅ | ✅ | Complete |
| View Registration Details | ✅ | ✅ | Complete |
| Update Registration Status | ✅ | ✅ | Complete |
| Update Payment Status | ✅ | ✅ | Complete |
| Check-in (Manual) | ✅ | ✅ | Complete |
| Check-in (QR Code) | ✅ | ✅ | Complete |
| Check-in Scanner Page | ✅ | ✅ | Complete |
| Barcode Import (CSV) | ✅ | ✅ | Complete |
| Badge PDF Generation | ✅ | ✅ | Complete |
| QR Code Generation | ✅ | ✅ | Complete |
| Delete Registration | ✅ | ✅ | Complete (detail-sheet delete + shared-attendee guard) |
| Search/Filter Registrations | ✅ | ✅ | Complete |
| Export to CSV | N/A | ✅ | Complete |
| Import from Contact Store | ✅ | ✅ | Complete |
| Bulk Update Registration Type | ✅ | ✅ | Complete |
| 2-Step Public Registration (Account + Details) | ✅ | ✅ | Complete |
| Registrant Account Creation (Email+Password) | ✅ | ✅ | Complete |
| Registrant Self-Service Portal (/my-registration) | ✅ | ✅ | Complete |
| Registrant Self-Edit Attendee Details | ✅ | ✅ | Complete |
| Registrant Pay Now (Stripe) | ✅ | ✅ | Complete |
| Registration Welcome & Terms HTML (WYSIWYG) | ✅ | ✅ | Complete |

**API Endpoints:**
- `GET /api/events/[eventId]/registrations` - List registrations (with filters)
- `POST /api/events/[eventId]/registrations` - Create registration
- `GET /api/events/[eventId]/registrations/[id]` - Get registration details
- `PUT /api/events/[eventId]/registrations/[id]` - Update registration
- `DELETE /api/events/[eventId]/registrations/[id]` - Delete registration
- `PATCH /api/events/[eventId]/registrations/bulk-type` - Bulk update registration type
- `GET /api/registrant/registrations` - List registrant's own registrations
- `PUT /api/registrant/registrations` - Registrant self-edit attendee details
- `POST /api/events/[eventId]/registrations/[id]/check-in` - Check-in by ID
- `PUT /api/events/[eventId]/registrations/[id]/check-in` - Check-in by QR/barcode
- `POST /api/events/[eventId]/import/barcodes` - Import barcodes from CSV
- `POST /api/events/[eventId]/registrations/badges` - Generate badge PDFs

---

## Phase 3: Speaker & Program Management (COMPLETED)

### Speaker Management
| Feature | API | UI | Status |
|---------|-----|-----|--------|
| Add Speaker | ✅ | ✅ | Complete |
| List Speakers | ✅ | ✅ | Complete |
| View Speaker Details | ✅ | ✅ | Complete |
| Edit Speaker | ✅ | ✅ | Complete |
| Delete Speaker | ✅ | ✅ | Complete |
| Speaker Status Management | ✅ | ✅ | Complete |
| **Companion registration (attend-ready)** | ✅ | ✅ | **Complete (June 25, 2026)** — every speaker auto-gets a linked comp "Faculty" registration → badge / barcode / DTCM / check-in / survey via the normal machinery; excluded from delegate counts. See [docs/SPEAKER_AS_ATTENDEE_PLAN.md](SPEAKER_AS_ATTENDEE_PLAN.md) |
| **Per-speaker / per-registration Activity timeline** | ✅ | ✅ | **Complete** — merged AuditLog + EmailLog + issued certificates (Open/preview), with speaker↔registration counterpart |
| Social Links | ✅ | ✅ | Complete |
| Import from Contact Store | ✅ | ✅ | Complete |

**API Endpoints:**
- `GET /api/events/[eventId]/speakers` - List speakers (with status filter)
- `POST /api/events/[eventId]/speakers` - Add speaker
- `GET /api/events/[eventId]/speakers/[id]` - Get speaker details
- `PUT /api/events/[eventId]/speakers/[id]` - Update speaker
- `DELETE /api/events/[eventId]/speakers/[id]` - Delete speaker

### Track Management
| Feature | API | UI | Status |
|---------|-----|-----|--------|
| Create Track | ✅ | ✅ | Complete |
| List Tracks | ✅ | ✅ | Complete |
| Edit Track | ✅ | ✅ | Complete |
| Delete Track | ✅ | ✅ | Complete |
| Color Coding | ✅ | ✅ | Complete |

**API Endpoints:**
- `GET /api/events/[eventId]/tracks` - List tracks
- `POST /api/events/[eventId]/tracks` - Create track
- `GET /api/events/[eventId]/tracks/[id]` - Get track details
- `PUT /api/events/[eventId]/tracks/[id]` - Update track
- `DELETE /api/events/[eventId]/tracks/[id]` - Delete track

### Session/Schedule Management
| Feature | API | UI | Status |
|---------|-----|-----|--------|
| Create Session | ✅ | ✅ | Complete |
| List Sessions | ✅ | ✅ | Complete |
| Edit Session | ✅ | ✅ | Complete |
| Delete Session | ✅ | ✅ | Complete |
| Assign Speakers to Session | ✅ | ✅ | Complete |
| Assign Track to Session | ✅ | ✅ | Complete |
| Session Status Management | ✅ | ✅ | Complete |
| Schedule View by Date | ❌ | ✅ | Complete |
| Schedule Calendar View | N/A | ✅ | Complete |

**API Endpoints:**
- `GET /api/events/[eventId]/sessions` - List sessions (with filters)
- `POST /api/events/[eventId]/sessions` - Create session
- `GET /api/events/[eventId]/sessions/[id]` - Get session details
- `PUT /api/events/[eventId]/sessions/[id]` - Update session
- `DELETE /api/events/[eventId]/sessions/[id]` - Delete session

### Abstract Management
| Feature | API | UI | Status |
|---------|-----|-----|--------|
| Submit Abstract (Dashboard) | ✅ | ✅ | Complete |
| Submitter Account Registration | ✅ | ✅ | Complete |
| SUBMITTER Role (abstracts-only access) | ✅ | ✅ | Complete |
| REGISTRANT Role (self-service portal) | ✅ | ✅ | Complete |
| Event-Scoped Login (/e/[slug]/login) | N/A | ✅ | Complete |
| Event-Scoped My Registration (/e/[slug]/my-registration) | ✅ | ✅ | Complete |
| Abstract Register (/e/[slug]/abstract/register) | ✅ | ✅ | Complete |
| Presentation Type (Oral/Poster/Video/Workshop) | ✅ | ✅ | Complete |
| Full-Page Abstract Submit/Edit (Submitter) | ✅ | ✅ | Complete |
| Reviewer Portal (Review/Score/Accept/Reject) | ✅ | ✅ | Complete |
| PDF Quote/Proforma with Tax | ✅ | ✅ | Complete |
| Tax Configuration (taxRate/taxLabel/bankDetails) | ✅ | ✅ | Complete |
| Stripe Tax (manual line items) | ✅ | N/A | Complete |
| Bulk Email for Abstract Submitters | ✅ | ✅ | Complete |
| Abstract Feedback Notification (notes/score) | ✅ | N/A | Complete |
| Smart Register Redirect (active tier) | N/A | ✅ | Complete |
| Settings: Branding/Email Branding Split | N/A | ✅ | Complete |
| List Abstracts | ✅ | ✅ | Complete |
| View Abstract | ✅ | ✅ | Complete |
| Edit Own Abstract (Submitter) | ✅ | ✅ | Complete |
| Review Abstract | ✅ | ✅ | Complete |
| Score Abstract | ✅ | ✅ | Complete |
| Accept/Reject Abstract | ✅ | ✅ | Complete |
| Status Notification Emails | ✅ | N/A | Complete |
| Link Abstract to Session | ✅ | ❌ | API Complete |
| Event-Specific Abstract Themes (CRUD) | ✅ | ✅ | Complete |
| Weighted Review Criteria per Event (CRUD) | ✅ | ✅ | Complete |
| Criteria-based Scoring (weighted avg; fallback to plain 0-100) | ✅ | ✅ | Complete |
| Reviewer Recommended Format (Oral/Poster/Neither) | ✅ | ✅ | Complete |
| Submitter Withdraw Abstract (WITHDRAWN status) | ✅ | ✅ | Complete |

**API Endpoints:**
- `GET /api/events/[eventId]/abstracts` - List abstracts (filtered to own for SUBMITTER)
- `POST /api/events/[eventId]/abstracts` - Submit abstract
- `GET /api/events/[eventId]/abstracts/[id]` - Get abstract details
- `PUT /api/events/[eventId]/abstracts/[id]` - Update/Review abstract (SUBMITTER: content only)
- `DELETE /api/events/[eventId]/abstracts/[id]` - Delete abstract (admin only)
- `POST /api/public/events/[slug]/submitter` - Create submitter account (no auth)
- `GET /api/events/[eventId]/abstract-themes` - List themes
- `POST /api/events/[eventId]/abstract-themes` - Create theme
- `PUT /api/events/[eventId]/abstract-themes/[themeId]` - Update theme
- `DELETE /api/events/[eventId]/abstract-themes/[themeId]` - Delete theme (blocked if abstracts linked)
- `GET /api/events/[eventId]/review-criteria` - List criteria
- `POST /api/events/[eventId]/review-criteria` - Create criterion
- `PUT /api/events/[eventId]/review-criteria/[criterionId]` - Update criterion
- `DELETE /api/events/[eventId]/review-criteria/[criterionId]` - Delete criterion

---

## Phase 4: Accommodation Management (COMPLETED)

### Hotel Management
| Feature | API | UI | Status |
|---------|-----|-----|--------|
| Add Hotel | ✅ | ✅ | Complete |
| List Hotels | ✅ | ✅ | Complete |
| Edit Hotel | ✅ | ✅ | Complete |
| Delete Hotel | ✅ | ✅ | Complete |
| Hotel Contact Info | ✅ | ✅ | Complete |
| Star Rating | ✅ | ✅ | Complete |

**API Endpoints:**
- `GET /api/events/[eventId]/hotels` - List hotels
- `POST /api/events/[eventId]/hotels` - Add hotel
- `GET /api/events/[eventId]/hotels/[id]` - Get hotel details
- `PUT /api/events/[eventId]/hotels/[id]` - Update hotel
- `DELETE /api/events/[eventId]/hotels/[id]` - Delete hotel

### Room Type Management
| Feature | API | UI | Status |
|---------|-----|-----|--------|
| Add Room Type | ✅ | ✅ | Complete |
| List Room Types | ✅ | ✅ | Complete |
| Edit Room Type | ✅ | ❌ | API Complete |
| Delete Room Type | ✅ | ❌ | API Complete |
| Pricing Configuration | ✅ | ✅ | Complete |
| Availability Tracking | ✅ | ✅ | Complete |
| Amenities | ✅ | ✅ | Complete |

**API Endpoints:**
- `GET /api/events/[eventId]/hotels/[hotelId]/rooms` - List room types
- `POST /api/events/[eventId]/hotels/[hotelId]/rooms` - Add room type
- `GET /api/events/[eventId]/hotels/[hotelId]/rooms/[id]` - Get room type
- `PUT /api/events/[eventId]/hotels/[hotelId]/rooms/[id]` - Update room type
- `DELETE /api/events/[eventId]/hotels/[hotelId]/rooms/[id]` - Delete room type

### Accommodation Booking
| Feature | API | UI | Status |
|---------|-----|-----|--------|
| Create Booking | ✅ | ✅ | Complete (`AssignAccommodationDialog` — searchable picker, room/date/guests) |
| List Bookings | ✅ | ✅ | Complete |
| View Booking Details | ✅ | ✅ | Complete |
| Update Booking Status | ✅ | ✅ | Complete (inline status buttons on booking cards) |
| Cancel Booking | ✅ | ✅ | Complete (status → CANCELLED, atomically releases the room) |
| Price Calculation | ✅ | ✅ | Complete |

**API Endpoints:**
- `GET /api/events/[eventId]/accommodations` - List bookings
- `POST /api/events/[eventId]/accommodations` - Create booking
- `GET /api/events/[eventId]/accommodations/[id]` - Get booking
- `PUT /api/events/[eventId]/accommodations/[id]` - Update booking
- `DELETE /api/events/[eventId]/accommodations/[id]` - Delete booking

---

## Recent Updates (June 2026)

### Communications filters + Activity edit-history + public SEO + Add-form parity + faculty data fix (June 29, 2026)

- **Bulk-email audience filters (registrations):** the "Send Bulk Email" dialog (registrations-list "Email All" + Communications page) now has in-dialog **multi-select** filters in a collapsible "Filter recipients" section — Payment status + **Registration type** (`ticketTypeIds`, Prisma `in`) + **Badge type** (`badgeTypes`, `in`) + **Tags** (`tagsInclude`, `hasSome`). OR-within-field / AND-across; empty = no restriction. Wider 4xl dialog, 3-up layout, "or"-joined recap, per-filter footnotes. Fixed: the list's "Filter by tag" was never passed to Email All. `src/lib/bulk-email.ts` + `src/components/bulk-email-dialog.tsx`. Count==send preserved; adversarially reviewed (0 blocker/0 high). Follow-on: a one-click **"Exclude faculty / speakers"** toggle (`excludeFaculty` → `NOT ticketType.isFaculty`), and the Communications page's **duplicate single-select registration filters were removed** so the dialog is the single registration-filter surface (Speakers card keeps its own). Plus a cerulean accent pass + Email-Type trigger height fix.
- **Activity edit-history diffs:** registration + speaker timeline renders field-level before→after diffs from `AuditLog.changes` (incl. nested attendee), finance-redacted (`src/lib/activity-feed.ts`). Dedup follow-on: shared activity types → client-safe `src/lib/activity-feed-types.ts`; the two global audit feeds share `src/components/activity/audit-log-display.ts` (icon/colour maps + describe/actor helpers) — components kept separate.
- **Public SEO metadata:** per-event OG/Twitter + per-section titles on `/e/[slug]/*` (`src/lib/public-event-metadata.ts`); org-scoping deferred to multi-tenant.
- **Add Registration ↔ Add Speaker parity:** shared `PersonFormFields` (speaker form was dropping Phone).
- **Faculty registration-type correction (prod backfill, audited):** 33 legacy companions with `registrationType="Faculty"` → 3 restored, **30 → "Physician"**; badge/ticket-type untouched; companion-create path unchanged.
- **Speaker phone/additionalEmail enrichment (prod backfill, audited, enrich-only):** 1 row.
- **scheduled-email 0-recipient → benign skip** (terminal SENT/0, info; not a paging FAILED). Plus: removed confirmation "Back to Event" button, deleted orphaned `docker/Dockerfile`, sidebar `w-64→w-56`.

### registration-detail-sheet.tsx staged refactor — A → E (May 20, 2026)

Five careful commits (`8ad760b` → `64dc640`), each independently
revertable, gated by tsc + lint + 1237 vitest + build + 62-spec
Playwright suite (58/62 passing, 0 regressions; the 4 failures
pre-date the refactor and are in the unrelated bulk-email flow).

- **A** typed `useBillingAccounts` / `useBillingAccount` returns, dropped 3 `any[]` casts at picker call sites.
- **B** extracted pure mappers `toEditData(reg)` / `toServerPayload(editData, expectedUpdatedAt)` into `src/app/(dashboard)/events/[eventId]/registrations/registration-edit-mapping.ts`. The same ~30-field shape used to live inline three times in the sheet. **14 unit tests** pin the null-vs-undefined-vs-trim contract, the studentIdExpiry ISO parse, the `attendeeIsGuarantor ?? false` legacy-null path, and a round-trip identity. Sheet **−99 lines**.
- **C** introduced `src/lib/api-fetch.ts` — `ApiError` (Error subclass with `status` + `code` + raw `data`) + `apiFetch` / `apiPostJson` / `apiPutJson` / `apiDelete`. All 5 mutationFn bodies in the sheet collapse to one-liners; `updateRegistration.onError` uses `error instanceof ApiError` to branch on STALE_WRITE. **8 unit tests** pin the helper. Sheet **−38 lines**.
- **D** fixed the prop-sync — replaced `if (registration !== selectedRegistration && registration !== null)` (compares prop to derived state — React 19 banned, latent prop-revert race) with the canonical "Storing information from previous renders" pattern (compares prop to a previous-prop snapshot in state).
- **E** extracted 5 inline handlers (incl. a 30-line badge-print async block) to named functions.

Sheet: 2,174 → ~2,063 lines (−110 net). +22 unit tests. F + G + H tracked in `docs/ROADMAP.md` with explicit trigger conditions.

### Per-event payer scoping — EventBillingAccount junction (May 20, 2026)

Many-to-many association via junction table with **shared identity**.
v1 (May 19) made `BillingAccount` org-scoped and caused picker overflow.
v2 introduces `EventBillingAccount(eventId, billingAccountId, addedAt, addedByUserId)`
with `@@unique` + Cascade FKs from both ends. Pickers filter by junction
membership via `?eventId=…`. Settings → Billing card gains an "Events"
count column + an `EventsAttachmentDialog` (checkbox per org event).
Defensive migration backfill from existing `Registration.billingAccountId`
pairs (no-op for fresh installs; preserves picker access if v1 had data).
+10 attach/detach RBAC/IDOR/idempotency tests.

### "Charge to another account" v1 — third-party payer / BillingAccount (May 19, 2026)

Doctors funded by their hospital or a pharma grant covering specific
HCPs. New org-scoped `BillingAccount` model + `Registration.billingAccountId`
/ `payerReference` / `attendeeIsGuarantor`.

**Orthogonal to `paymentStatus` by design** (the deliberate
anti-INCLUSIVE decision): money is still owed and the registration
stays UNPAID/PENDING — this only redirects the invoice bill-to party
and suppresses the attendee Pay-Now path. Distinct from `INCLUSIVE`
(bulk pre-paid sponsor) and the `Registration.billing*` block (same
payer, different address).

- **Service**: `src/services/billing-account-service.ts` (create / update / soft-delete via `isActive`, `@@unique([organizationId,name])` dedupe).
- **Registration wiring**: `registration-service.createRegistration` + REST POST + REST PUT + MCP `create_registration` / `update_registration` accept the three fields with org-scoped + active validation (new codes `BILLING_ACCOUNT_NOT_FOUND` / `BILLING_ACCOUNT_INACTIVE`). Setting `billingAccountId: null` reverts to self-pay (the fallback path).
- **Invoice / Quote PDF**: bill-to renders the payer (name / address / VAT) with the attendee dropped to a reference line + PO/grant ref.
- **Finance boundary**: payer keys in `FINANCIAL_KEYS` (MEMBER never sees who funds a doctor — Mecomed-sensitive). `/api/billing-accounts` is `denyFinance` + `denyReviewer` gated.
- **UI**: `BillingAccountsCard` in Settings → Billing (CRUD + soft-delete + needs-review badge); payer picker + PO + guarantor on the full-page Add Registration form; reassign/guarantor/revert + "Billed to" pill on the registration detail sheet's Billing tab.
- Package 0.3.6 → 0.3.7. +13 tests pinning the orthogonality + service contracts + finance redaction.

Deferred to v1.1 (`docs/ROADMAP.md`): public "who pays" step, quick-Add
dialog picker, standalone MCP billing-account tools, list "Payer"
column / CSV, AR aging, VAT reverse-charge, consolidated invoicing,
quote-email recipient redirect.

### Multi-agent audit remediation — 2 BLOCKERs + 4 HIGHs (May 18, 2026)

Supervisor + 4 specialist review agents (React, Prisma, backend/RBAC,
architecture) swept the codebase; six findings verified against source
were remediated in one batch:

- **B1** cross-tenant IDOR on event email templates (GET / PUT / DELETE / POST / PATCH all resolved by `{ id, eventId }` from the URL with zero `organizationId` binding).
- **B2** `soldCount` never released on cancel via MCP `update_registration` / `bulk_update_registration_status` — silent sold-out inflation when "cancel all unpaid registrations" via agent / n8n.
- **H3** registrations LIST returned full payments / card / bank to MEMBER (other registration GETs already redacted).
- **H4** contacts write-guard bypass — inline `REVIEWER||SUBMITTER` check let MEMBER + REGISTRANT write/delete org contacts.
- **H5** `PaymentStatus` enum drift — `ALL_PAYMENT_STATUSES` missing INCLUSIVE; now derived from `Object.values(PaymentStatus)` so it can't drift.
- **H6** `getNextSerialId` race — `aggregate(_max) + 1` replaced with `RegistrationSerialCounter` atomic upsert (mirrors `InvoiceCounter`). Backfill seeds `lastSerial = MAX(existing)` per event for blue-green safety.

+20 tests, suite 1175 → 1195. Independent verification: SHIP.

---

## Recent Updates (April 15–16, 2026)

### MCP Tool Expansion — Sprint A Complete (April 16, 2026)

The MCP server grew from 35 → 65 tools across two coordinated releases, closing most of an external audit's Priority 1 findings. Claude.ai web and Claude Desktop can now drive an end-to-end event lifecycle through MCP.

**Bulk expansion** (commit `3789256`) added **22 tools** across four tranches:

- **Tranche 0** — `create_event` (the missing top-level CRUD): org-scoped, auto-generates unique slug with retries, seeds default terms + speaker agreement HTML, fires `provisionWebinar()` fire-and-forget on WEBINAR type.
- **Tranche A** (orchestration reads) — `get_event_dashboard`, `list_unpaid_registrations`, `list_speaker_agreements`, `list_live_sessions_now`, `search_event`. Each collapses a multi-call sequence into a single natural-language answer.
- **Tranche B** (action tools plugging read/write asymmetry) — `update_registration`, `update_speaker`, `update_session`, `bulk_update_registration_status`. All transactionally safe; `update_registration` auto-adjusts `TicketType.soldCount` on ticket-type change.
- **Tranche C** (recently-shipped features) — webinar reads (info/attendance/engagement), sponsors (list + upsert), speaker agreement template (get), promo codes full CRUD, scheduled emails (list + cancel).

**Sprint A batch 1** (commit `d1b0677`) — audit polish:
- `create_session` + `update_session` now validate session falls within event's date range using the event's `timezone` field (default Asia/Dubai) via `Intl.DateTimeFormat`. Fixed a UTC-comparison bug that would reject legitimate late-evening Dubai sessions.
- `create_speaker` / `create_registration` / `create_contact` return `existingId` on duplicate detection so Claude can auto-pivot to `update_*`.
- `update_abstract_status` no longer swallows errors — three fixes: WITHDRAWN terminal-state guard with structured `code: "ABSTRACT_WITHDRAWN"`, isolated notification failures (DB success stands even if email fails, reports `notificationStatus: "failed"`), outer catch surfaces real Prisma error as `details`.

**Sprint A batch 2** (commit `c226686`) — 8 new tools:
- **Accommodation CREATE flow**: `list_room_types`, `create_accommodation` (atomic overbooking guard inside transaction), `update_accommodation_status` (releases room on cancel, re-checks availability on reinstate).
- **Invoice CREATE / SEND flow**: `create_invoice`, `send_invoice`, `update_invoice_status`. `REFUNDED` is DB-only — does NOT call Stripe (documented in tool description and response).
- **Email template editing**: `update_email_template` (creates override from default if missing), `reset_email_template` (deletes override so system default is used).

**Architecture**: all 65 tools live in [src/lib/agent/event-tools.ts](src/lib/agent/event-tools.ts) as a single `TOOL_EXECUTOR_MAP`, shared between the MCP server and the in-app AI Agent. MCP HTTP registrations in [src/lib/agent/mcp-server-builder.ts](src/lib/agent/mcp-server-builder.ts). Every write tool writes `AuditLog` with `changes.source: "mcp"`. Stdio transport at `src/mcp/server.ts` intentionally not updated — pending consolidation PR.

**Deferred to Sprint B**: reviewer assignment + abstract scoring (needs schema work — new `AbstractReviewer` + `AbstractScore` tables), bulk creates, hard deletes (safety rail).

---

### MCP OAuth 2.1 + DCR for claude.ai web (April 16, 2026)

Claude Desktop connected to `/api/mcp` via `mcp-remote` with `x-api-key` headers, but **claude.ai web couldn't connect at all** because the browser-based connector UI has no way to send custom headers and requires OAuth 2.1 per the MCP spec. Live probes against production found three specific breakages: no `WWW-Authenticate` header on 401, `/.well-known/oauth-*` returning 404, and OPTIONS preflight with no CORS headers.

Implemented spec-compliant OAuth 2.1 with:
- **RFC 9728** Protected Resource Metadata at `/.well-known/oauth-protected-resource`
- **RFC 8414** Authorization Server Metadata at `/.well-known/oauth-authorization-server`
- **RFC 7591** Dynamic Client Registration at `/api/mcp/oauth/register`
- **RFC 6749 §4.1** Authorization Code Grant with **mandatory PKCE S256** (plain PKCE rejected)
- **RFC 6749 §6** Refresh Token Grant with refresh rotation
- **RFC 7009** Token Revocation

**Schema**: three new Prisma models — `McpOAuthClient` (DCR registrations), `McpOAuthAuthCode` (hashed one-time-use codes, 10-min TTL, stores PKCE challenge), `McpOAuthAccessToken` (hashed Bearer tokens, 30-day access TTL + 90-day refresh TTL + `revokedAt` + `lastUsedAt`). All lookups via SHA-256 hash — raw tokens never stored or logged.

**Consent UI** at `/mcp-authorize` is a Next.js server-component page that enforces RBAC (ADMIN / SUPER_ADMIN / ORGANIZER only can grant MCP access). Reviewers / submitters / registrants see a clean access-denied page.

**Backward compatibility**: `authenticate()` in the MCP route tries `validateApiKey()` first (existing Claude Desktop + mcp-remote + n8n path), falls back to `validateOAuthAccessToken()`. Both return `{ organizationId, keyPrefix }` so downstream tools don't care which path authenticated the request.

**Middleware bypass**: early `if (pathname.startsWith("/api/mcp")) return NextResponse.next()` in `src/middleware.ts` so MCP routes handle their own CORS via route-level `OPTIONS` exports (the app-level mobile-only CORS allowlist was silently rejecting claude.ai).

**Hourly cleanup cron** at `/api/cron/mcp-oauth-cleanup` purges expired auth codes and stale tokens past a 7-day grace period.

Migration: `20260416000000_add_mcp_oauth_tables`. Full architectural detail in `docs/MCP_OAUTH.html` (local-only, gitignored per docs convention).

---

### Speaker / Faculty Communications Upgrade (April 2026)

Four-part overhaul of speaker outreach so faculty get professionally personalized invitations and agreements:

1. **Title prefix rendering** on all public surfaces (agenda, session page, registration-page featured speakers) and in every speaker email. Previously `{{firstName}} {{lastName}}` only — now `{{speakerName}}` via `formatPersonName()`.
2. **Presentation details block** in speaker emails — session title, topic title(s), date/time, track, role. Previously a comma-joined session-name list. New `buildSpeakerEmailContext()` helper in `src/lib/speaker-agreement.ts` is the single source of truth for both email vars AND docx merge fields.
3. **Per-user organizer email signature** — new `User.emailSignature` field (HTML, max 10000 chars). Edited via TiptapEditor on `/profile`. Appended to speaker emails via `{{organizerSignature}}` template var. Scheduled-email cron loads it from the triggering user.
4. **Personalized speaker-agreement DOCX attachment** — new `Event.speakerAgreementTemplate` JSON pointer to an uploaded .docx. Admin uploads at Event Settings → Email Branding. Uses `docxtemplater` + `pizzip` to mail-merge `{speakerName}`, `{sessionTitles}`, `{sessionDateTime}`, `{organizationName}`, etc. Per-recipient generation in `executeBulkEmail()`. Single-send and bulk + scheduled paths all attach personalized docx.

Migration: `20260415000000_add_email_signature_and_agreement_template`. New deps: `docxtemplater@3.68.4`, `pizzip@3.2.0`.

---

## Recent Updates (April 14, 2026)

### Webinar Waiting Room (June 23, 2026) — Phases 1–4 ✅ shipped

Producer-gated attendee admission for webinars, watched on our gated session page.
- [x] **P1 — Lobby config + producer control:** `WebinarSettings.viewingMode`/`lobbyVideoUrl`/`lobbyMessage` (settings JSON); `POST /webinar/room` open/close → anchor `EventSession.status` LIVE/COMPLETED; Console **LobbyCard** (mode toggle, holding video, Open/Close room).
- [x] **P2 — Waiting room:** `waiting-room.tsx` (countdown + YouTube/Vimeo holding video); public cached `/lobby-status`; session page polls + auto-admits on open into the chosen mode (embed/HLS) with a "Join now" CTA fallback.
- [x] **P3 — Real-time presence:** `WebinarPresence` table (additive migration) + `webinarFirstJoinedAt`; `/sessions/[id]/presence` heartbeat (`upsert`, no transaction); `/webinar/presence` → "Live now" console card + "Joined" registrations badge.
- [x] **P4 — 5k stream wiring:** `HLS_CDN_BASE` (CloudFront) with origin fallback; cached MediaMTX probe; `LivePlayer` CDN→origin failover + auto-recovery; nginx `/stream/` committed; CloudFront+DR steps in `LIVE_STREAMING.md §13` (operator-run).
- [x] Two-agent adversarial review; all live/high/medium findings fixed in-band.
- [ ] Deferred (ROADMAP backlog): never-opened-room warning, operator visibility, save-time hls validation, Redis limiter; operator prerequisites (Zoom sdkMode→prod, verify box nginx, CloudFront+DR before a real 5k stream).

### Webinar Events as First-Class (April 13–14, 2026) — Phases 1–5

Turns `eventType === 'WEBINAR'` from a cosmetic label into a fully
differentiated event mode. Creating a webinar now auto-provisions an anchor
session + Zoom webinar, wires up a 5-phase email sequence, polls Zoom for
the cloud recording, pulls the attendance report, and surfaces everything
in a dedicated Webinar Console at `/events/[eventId]/webinar`.

**Phase 1 — Conditional UI** (no schema)
- [x] `src/lib/webinar.ts` — `isWebinar()`, `webinarModuleFilter()`, `WEBINAR_HIDDEN_MODULES`
- [x] Sidebar filters Accommodation/Check-In/Promo Codes/Abstracts/Reviewers for webinar events
- [x] Settings page hides Abstract Themes + Review Criteria tabs
- [x] Symmetric filter handles `webinarOnly: true` so non-webinar events drop the new Webinar Console link

**Phase 2 — Auto-provisioning + Webinar Console** (no schema; `Event.settings.webinar` JSON)
- [x] `src/lib/webinar-provisioner.ts` — idempotent `provisionWebinar(eventId, { actorUserId })`; creates anchor `EventSession`, calls `createZoomWebinar()` if org has Zoom, persists `settings.webinar`, logs `zoomStatus` + `zoomDurationMs` + overall `durationMs`
- [x] `POST /api/events` fires provisioner fire-and-forget on `eventType === 'WEBINAR'`
- [x] `GET/PUT/POST /api/events/[eventId]/webinar` — settings + anchor session + Zoom meeting (parallelized); `denyReviewer`, 20/hr settings rate limit, 10/hr manual re-provision rate limit
- [x] Webinar Console page with status badge, anchor session card, Zoom join URL + passcode (copy buttons), Start-as-Host, Re-run provisioner, settings form (child component with lazy-init state to avoid setState-in-effect anti-pattern)

**Phase 3 — Email sequence** (no schema; uses existing `ScheduledEmail` cron)
- [x] 5 default templates: `webinar-confirmation`, `webinar-reminder-24h`, `webinar-reminder-1h`, `webinar-live-now`, `webinar-thank-you`
- [x] Variables: `{{joinUrl}}`, `{{passcode}}`, `{{webinarDate}}`, `{{webinarTime}}`, `{{recordingUrl}}` + conditional `{{passcodeBlock}}` / `{{recordingBlock}}`
- [x] `BulkEmailType` + Zod + `slugMap` extended; `executeBulkEmail` loads anchor session + ZoomMeeting once (not per recipient) and enriches `vars` when `emailType` starts with `webinar-`
- [x] **Sender fix**: `executeBulkEmail` event fetch now includes `emailFromAddress`/`emailFromName`/`emailHeaderImage`/`emailFooterHtml` so `brandingFrom()` resolves to the per-event sender instead of provider defaults (fixes "Forbidden" errors from unauthorized default senders; silently improves every other bulk-email type)
- [x] `src/lib/webinar-email-sequence.ts` — `enqueueWebinarSequenceForEvent()` (idempotent, creates 4 future rows, drops past phases, resolves creator from event admins), `sendWebinarConfirmationForRegistration()` (immediate direct send, no cron latency), `clearPendingWebinarSequence()`
- [x] Public register route branches on `eventType` — WEBINAR events get `sendWebinarConfirmationForRegistration()`, all others keep `sendRegistrationConfirmation`
- [x] `GET/POST /api/events/[eventId]/webinar/sequence` — list + re-enqueue (5/hr rate limit)
- [x] Webinar Console `EmailSequenceCard` with per-phase status, scheduled/sent times, counts, failure errors, Re-enqueue button

**Phase 4 — Cloud recording retrieval** (schema: 6 new `ZoomMeeting` columns + `RecordingStatus` enum)
- [x] `ZoomMeeting.recordingUrl`, `recordingPassword`, `recordingDownloadUrl`, `recordingDuration`, `recordingFetchedAt`, `recordingStatus` (enum: `NOT_REQUESTED`/`PENDING`/`AVAILABLE`/`FAILED`/`EXPIRED`) + index
- [x] Migration `20260413000000_add_webinar_recording_fields` (idempotent)
- [x] `src/lib/zoom/recordings.ts` — `getZoomRecordings()` (uses `/meetings/{id}/recordings`, works for meetings and webinars, null on 404), `pickBestRecordingFile()` (speaker-view MP4 → any MP4 → any playable)
- [x] `src/lib/webinar-recording-sync.ts` — `syncRecordingForZoomMeeting()` idempotent state machine; 10-min min delay after session end, 7-day fetch window, emit structured logs on every return path
- [x] `POST /api/cron/webinar-recordings` — Bearer-auth, up to 10 candidates per tick, serial loop with 500ms delay when batch >3, per-row try/catch
- [x] `POST /api/events/[eventId]/webinar/recording/fetch` — manual refetch (10/hr rate limit); resets `FAILED`/`EXPIRED` → `NOT_REQUESTED` before calling sync helper
- [x] Public session page emerald "Watch Replay" card when session is past and recording is `AVAILABLE`; amber "Recording processing" when past + `PENDING`; Join CTA hidden for past sessions (kills dead-link problem)
- [x] `bulk-email.ts` webinar enrichment reads `recordingUrl` from ZoomMeeting; thank-you email `{{recordingBlock}}` renders Watch Replay button when available, "coming soon" fallback otherwise
- [x] Webinar Console `RecordingCard` with 5 UI states (AVAILABLE/PENDING/FAILED/EXPIRED/NOT_REQUESTED), Refetch button gated on session-ended
- [x] EC2 crontab: `*/5 * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" .../api/cron/webinar-recordings`

**Phase 5 — Attendance tracking** (schema: `ZoomMeeting.lastAttendanceSyncAt` + new `ZoomAttendance` model)
- [x] `ZoomAttendance` model with unique key `(zoomMeetingId, zoomParticipantId, joinTime)` — rejoin history preserved as multiple segments
- [x] Reverse relations on `Event`, `EventSession`, `Registration`
- [x] Migration `20260413010000_add_zoom_attendance` (idempotent)
- [x] `src/lib/zoom/reports.ts` — `getZoomParticipants()` walks `next_page_token` cursor (`page_size=300`, 100-page hard stop = 30k attendees max), null on 404
- [x] `src/lib/webinar-attendance.ts` — `syncWebinarAttendance()` idempotent state machine; 30-min min delay, 30-day fetch window, case-insensitive email → registrationId lookup, per-row upsert try/catch (one bad row never aborts the batch), `attentivenessScore` parser handles `"85"`/`"85%"`/`85`
- [x] `POST /api/cron/webinar-attendance` — Bearer-auth. Candidate query re-syncs hourly **only within 24h of session end** (audit fix) so old webinars don't get polled forever — ~97% reduction in post-48h Zoom API traffic. Serial loop with 500ms delay, per-row try/catch
- [x] `GET /api/events/[eventId]/webinar/attendance` — returns `{ kpis, rows }` or CSV via `?export=csv`. KPIs: registered / attended (unique by email) / rate / avg watch / total watch / **peak concurrent** (edge-event sweep handles rejoin segments correctly) / lastSyncedAt. Parallelized
- [x] `POST` manual re-sync (denyReviewer, 10/hr rate limit)
- [x] CSV export uses RFC-4180 field escaping
- [x] Webinar Console `AttendanceCard` with 4-tile KPI grid, attendee table (Name/Email/Joined/Watched/Reg#), Export CSV, Sync now button (gated)
- [x] EC2 crontab: `*/10 * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" .../api/cron/webinar-attendance`

**Audit fixes (second pass on each phase)**
- [x] Phase 4: EXPIRED marker update wrapped in try/catch (was outside, could crash cron tick); 5 silent state transitions now emit info/warn logs with `zoomMeetingDbId` + `durationMs`
- [x] Phase 5: Both `lastAttendanceSyncAt` marker updates wrapped; "outside fetch window" now logs; 24h cap on attendance re-sync
- [x] All cron workers: per-row defensive try/catch so one bad row can't kill the tick
- [x] Manual refetch routes: warn logs on 400 "no anchor session" / "no zoom meeting" paths

**Observability**
- Every sync helper emits structured logs with `durationMs` + context on every return path. Grep `webinar-recording:` or `webinar-attendance:` to trace any single row's full state history
- All POST/PUT/DELETE routes: `denyReviewer` + `checkRateLimit` + Zod + `apiLogger.warn` on rate-limit rejection

**Decouplability**
All Phase 1–5 code lives under tightly-scoped namespaces (`src/lib/webinar*`, `src/app/api/events/[eventId]/webinar/*`, `src/app/(dashboard)/events/[eventId]/webinar/*`, `src/app/api/cron/webinar-*`, `src/lib/zoom/{recordings,reports}.ts`) with one-way imports from core. Estimate for later microservice extraction: 1–2 days.

**Remaining**
- ~~**Phase 6** — Polls/Q&A reports + panelist management UI~~ → **✅ SHIPPED.** Engagement sync (`src/lib/webinar-engagement.ts` + `/webinar/engagement` route + console Polls/Q&A cards) and panelist management UI (Webinar Console + Import-from-Speakers) are both live. The June 23 producer-gated waiting room + real-time presence + 5k CDN wiring also shipped on top of this (see CLAUDE.md → Recent Features).

**Commits**: `f3921d7` (phases 1–3), `8e212f7` (phase 4), `12497fa` (phase 5)

---

### Event-Scoped Media Library (April 2, 2026)
- [x] `eventId` (nullable FK, CASCADE) added to `MediaFile` model; existing org-wide media unaffected
- [x] `GET/POST /api/events/[eventId]/media` — upload/list images scoped to a specific event; same magic-byte validation, 2MB limit, and rate limit as global route; storage orphan cleanup on DB failure
- [x] `DELETE /api/events/[eventId]/media/[mediaId]` — ownership-checked delete
- [x] `useEventMedia` / `useUploadEventMedia` / `useDeleteEventMedia` React Query hooks
- [x] `/events/[eventId]/media` page — drag-and-drop upload zone, image grid, copy URL, delete; accessible from event sidebar under Tools
- [x] Sidebar reorganised: 7 event nav sections merged to 4 (Overview, Manage, Abstracts, Tools, Config)

### Stripe Refund + Webhook Gap Coverage (April 2, 2026)
- [x] `POST /api/events/[eventId]/registrations/[registrationId]/refund` — admin-initiated full refund via Stripe; optimistic DB lock prevents concurrent duplicates; idempotency key; storage rollback on Stripe failure; refund confirmation email to attendee; admin in-app notification
- [x] Webhook: `checkout.session.expired` resets PENDING → UNPAID (prevents permanently stuck registrations)
- [x] Webhook: `charge.refunded` auto-updates `paymentStatus` + `Payment.status` → REFUNDED when refund issued via Stripe Dashboard
- [x] Webhook: `payment_intent.payment_failed` logged for production visibility
- [x] "Issue Refund" button on registration detail sheet (admin/organizer only, visible when PAID)
- [x] `refund-confirmation` email template added

### EventsAir-Style Abstract Expansion (April 2, 2026)
- [x] `VIDEO` and `WORKSHOP` added to `PresentationType` enum
- [x] `WITHDRAWN` added to `AbstractStatus` enum; submitters can withdraw from SUBMITTED/REVISION_REQUESTED
- [x] New `RecommendedFormat` enum (ORAL, POSTER, NEITHER); reviewers select recommended format during review
- [x] New `AbstractTheme` model; organizers manage event-specific themes in Settings → Abstract Themes; theme badge shown on abstract cards
- [x] New `ReviewCriterion` model; organizers configure weighted criteria (weights must sum to 100%) in Settings → Review Criteria
- [x] `criteriaScores` (JSON snapshot) stored on Abstract; `reviewScore` auto-computed as weighted average; plain 0-100 fallback when no criteria configured
- [x] Theme filter added to abstract list view; withdrawn count shown in stats row
- [x] Idempotent SQL migrations for all schema changes (`prisma db execute` compatible with Supabase pooled connections)

### Recent Improvements (March 2026)

#### Tax Calculation System
- [x] `taxRate` (Decimal), `taxLabel` fields on Event model for per-event tax configuration
- [x] Tax config UI in Settings → Registration tab
- [x] Registration form shows price + VAT breakdown before checkout
- [x] Stripe checkout sends base price + tax as separate line items (removed `automatic_tax`)
- [x] PDF quote/proforma includes tax breakdown with configurable tax label
- [x] Confirmation page, registrant portal, and admin detail sheet all display tax breakdown
- [x] Payment confirmation email includes tax amount

#### Stripe Payment Flow Fixes
- [x] PricingTier fallback: checkout handles missing `pricingTier` gracefully instead of failing
- [x] Double-click protection on Pay Now / checkout buttons
- [x] Tax amount included in confirmation email (was previously omitted)
- [x] Correct zero-decimal currency handling for tax calculations

#### SendGrid as Alternative Email Provider
- [x] Added `@sendgrid/mail` package as alternative to Brevo
- [x] Auto-selected via `SENDGRID_API_KEY` env var; `EMAIL_PROVIDER` env var for explicit selection
- [x] Both providers coexist in `src/lib/email.ts` with unified `sendEmail()` interface
- [x] No code changes needed when switching providers — just change env vars

#### Error Logging Audit
- [x] Fixed 20 silent `catch` blocks across API routes that swallowed errors without logging
- [x] All catch blocks now log via `apiLogger.error()` with context before returning error responses
- [x] Improved debugging visibility for production issues

#### organizationId Null Fixes for SUBMITTER/REGISTRANT
- [x] Fixed API routes that assumed non-null `organizationId` for org-independent roles
- [x] SUBMITTER and REGISTRANT users (with `organizationId: null`) no longer hit 500 errors on event-scoped operations
- [x] Consistent null-safe handling across all role-scoped query paths

#### registrationType Field Cleanup
- [x] `ticketTypeId` confirmed as single source of truth for registration type
- [x] `attendee.registrationType` text field auto-synced from `ticketType.name` on create and type change
- [x] Removed `registrationType` from registration edit forms and Zod schemas to prevent drift
- [x] CSV export uses `ticketType.name` directly

#### Registration Flow Review Fixes
- [x] XSS: sanitized user-provided HTML content in registration welcome/terms fields
- [x] Attendee isolation: registration queries scoped to prevent cross-registration data leakage
- [x] Pricing validation: server-side price verification against ticket type configuration
- [x] Suspense boundaries: added proper loading states to registration flow pages

---

### UI Theming & Branding
- [x] New color scheme with Cerulean Blue (#00aade) as primary color
- [x] Gradient theme: Cerulean to Light Blue
- [x] Yellowish/Amber accent color for notifications and highlights
- [x] Custom CSS variables using oklch color format for better color manipulation
- [x] Gradient utilities: `bg-gradient-primary`, `text-gradient-primary`, `btn-gradient`
- [x] Dark mode support with adjusted color values
- [x] Updated sidebar with gradient logo area
- [x] Updated header with accent gradient line
- [x] Updated auth pages (login, register) with gradient backgrounds
- [x] Gradient CTA buttons across the application

**Color Palette:**
- Primary: Cerulean Blue `oklch(0.65 0.155 220)` / `#00aade`
- Primary Foreground: White
- Accent: Amber/Yellow `oklch(0.85 0.16 85)`
- Gradient Start: `oklch(0.65 0.155 220)` (Cerulean)
- Gradient End: `oklch(0.82 0.1 220)` (Light Blue)


### Photo Upload System & Person Entity Enhancements (February 19, 2026)
- [x] File upload infrastructure for photos (max 500KB, JPEG/PNG/WebP validation)
- [x] Upload API endpoint at `/api/upload/photo` with server-side validation and UUID-based naming
- [x] Local storage in `/public/uploads/photos/YYYY/MM/` (EC2-compatible, upgrade path to cloud storage)
- [x] `PhotoUpload` component with preview, progress indicator, file validation, and helper text
- [x] `CountrySelect` component with searchable dropdown (ISO 3166-1, 249 countries)
- [x] Added `city` and `country` fields to Attendee, Speaker, and Contact models
- [x] Added `photo` field to Contact model (was previously URL-only for Attendee/Speaker)
- [x] Updated 5 forms: registration create/edit, speaker create/edit, contacts
- [x] Updated 6 API routes with Zod schemas for photo/city/country validation
- [x] CSV export includes city and country columns
- [x] All detail views display city, country, and photo with preview

**New Files:**
- `src/app/api/upload/photo/route.ts` — File upload endpoint with validation
- `src/components/ui/photo-upload.tsx` — Reusable photo upload component
- `src/components/ui/country-select.tsx` — Searchable country dropdown
- `src/lib/countries.ts` — ISO 3166-1 country list (249 countries)

**Modified Files:**
- `prisma/schema.prisma` — Added city/country to Attendee, Speaker, Contact; photo to Contact
- `src/app/(dashboard)/events/[eventId]/registrations/add-registration-dialog.tsx` — Photo upload, city, country
- `src/app/(dashboard)/events/[eventId]/registrations/registration-detail-sheet.tsx` — Photo preview + edit
- `src/app/(dashboard)/events/[eventId]/registrations/types.ts` — Updated Attendee interface
- `src/app/(dashboard)/events/[eventId]/registrations/page.tsx` — CSV export with city/country
- `src/app/(dashboard)/events/[eventId]/speakers/new/page.tsx` — Photo upload, city, country
- `src/app/(dashboard)/events/[eventId]/speakers/[speakerId]/page.tsx` — Added photo edit (was missing)
- `src/app/(dashboard)/contacts/page.tsx` — Photo upload, city, country in contact form
- API routes: registrations, speakers, contacts (Zod schemas updated)

### Event Classification Fields (February 19, 2026)
- [x] Added `eventType` enum to Event model (CONFERENCE, WEBINAR, HYBRID)
- [x] Added `tag` and `specialty` fields to Event model for categorization
- [x] Updated event creation form with 3-column grid for type/tag/specialty
- [x] Updated event settings page with new fields
- [x] Updated API routes (`/api/events`, `/api/events/[eventId]`) with Zod validation

**Modified Files:**
- `prisma/schema.prisma` — EventType enum + eventType/tag/specialty on Event model
- `src/app/(dashboard)/events/new/page.tsx` — Event type dropdown + tag/specialty inputs
- `src/app/(dashboard)/events/[eventId]/settings/page.tsx` — Event type/tag/specialty in settings
- `src/app/api/events/route.ts` — createEventSchema with new fields
- `src/app/api/events/[eventId]/route.ts` — updateEventSchema with new fields

### Server & Database Optimization (February 10, 2026)
- [x] Speakers page: parallelized `params`/`auth()`/event/speakers queries with `Promise.all`
- [x] Event detail page: parallelized `params`/`auth()`; switched to Prisma `select` for minimal data transfer
- [x] Added composite indexes on Registration: `[eventId, status]`, `[eventId, ticketTypeId]`
- [x] Removed redundant `@@index([slug])` on Organization (duplicated `@unique`)
- [x] Narrowed middleware matcher to dashboard routes only (`/events/*`, `/dashboard/*`, `/settings/*`)
- [x] Fixed Prisma client `globalThis` caching to apply only in development

**Observed but not yet addressed:**
- `next.config.ts` missing several Radix packages from `optimizePackageImports`
- `date-fns` not in `optimizePackageImports`
- Unused tRPC dependencies in `package.json` (`@trpc/client`, `@trpc/react-query`, `@trpc/server`)
- React Query uses uniform 5-minute stale time for all data types — could be granular

### Reviewers Module (February 10, 2026)
- [x] Per-event reviewer management page at `/events/[eventId]/reviewers`
- [x] GET API returns reviewer list (cross-referenced from `event.settings.reviewerUserIds`, speakers, and users) + available speakers
- [x] POST API with dual add mode: from speakers (links `Speaker.userId`) or by email (creates standalone reviewer)
- [x] DELETE API removes reviewer from event (does not delete User account)
- [x] React Query hooks: `useReviewers`, `useAddReviewer`, `useRemoveReviewer`
- [x] "Reviewers" sidebar tab added after "Abstracts" (not visible to reviewer role)
- [x] Stats cards: Total Reviewers, Active Accounts
- [x] Add Reviewer dialog with tabbed UI: "From Speakers" picker + "By Email" form

### Schema & API Cleanup (February 18, 2026)

#### `company` → `organization` rename
- [x] Renamed `Attendee.company` → `Attendee.organization` across schema, all API routes, and all UI pages
- [x] Renamed `Speaker.company` → `Speaker.organization` across schema, all API routes, and all UI pages
- [x] Renamed `Contact.company` → `Contact.organization` across schema, all API routes, and all UI pages
  - The existing Prisma relation field `Contact.organization` (→ Organization model) was renamed to `Contact.org` to free the name
- [x] Updated all UI labels ("Company" → "Organization") across registrations, speakers, contacts, public registration form, import dialogs, CSV import/export headers, and the contact CSV template
- [x] Migration applied with `prisma db push --accept-data-loss` (only test data in renamed columns)

#### `headshot` → `photo` rename for Speakers
- [x] Renamed `Speaker.headshot` → `Speaker.photo` in Prisma schema
- [x] Updated all speaker API routes (`Zod` schema, destructuring, `db.speaker` calls)
- [x] Updated speaker UI pages (detail page, new speaker form)

#### New `photo` field for Attendees / Registrations
- [x] Added `photo String?` to `Attendee` model in Prisma schema
- [x] Registration detail sheet (slide-out): photo URL input in edit mode, photo thumbnail in view mode
- [x] API: `photo` added to `updateRegistrationSchema` Zod definition and `db.attendee.update` in `PUT /api/events/[eventId]/registrations/[id]`
- [x] `Registration.attendee.photo` exposed in GET response (already included via `include: { attendee: true }`)

#### CSV template download (Contacts page)
- [x] "CSV Template" button added to Contacts toolbar (before "Import CSV")
- [x] Client-side Blob download — no API route needed
- [x] Template includes all 8 columns: `firstName, lastName, email, organization, jobTitle, phone, tags, notes`
- [x] One example row illustrating `tags` format (comma-separated, double-quoted)

#### API key auth for `GET /api/events` (n8n / external integrations)
- [x] `GET /api/events` now accepts both session auth and `x-api-key` / `Authorization: Bearer` header
- [x] Session callers (all roles including REVIEWER/SUBMITTER) path unchanged — `auth()` → `buildEventAccessWhere` role scoping
- [x] API key callers: validated via `validateApiKey` from `@/lib/api-key`; see all org events (org-level credential)
- [x] Optional `?slug=` query param added to both branches — allows resolving a human-readable slug to an event ID
- [x] Enables zero-manual-step n8n workflows: API key → `GET /api/events` to discover IDs → `GET /api/events/{id}/speakers` etc.
- [x] REVIEWER/SUBMITTER regression avoided: `getOrgContext()` was not used here (it returns null for null-organizationId users); `auth()` handles those roles directly

**n8n workflow (before):**
1. Create API key in Settings
2. **Manual step:** open dashboard, navigate to event, copy UUID from URL bar, hardcode into every n8n node

**n8n workflow (after):**
1. Create API key in Settings
2. n8n node 1: `GET /api/events` with `x-api-key` header → JSON array with `id`, `name`, `slug`, dates
3. n8n node 2: `GET /api/events/{id}/speakers` with same header → speakers data

---

### Contact Store (February 18, 2026)
Org-wide contact repository holding up to 100k contacts, with CSV import/export, tagging, event history, and one-click import into event speakers or registrations.

| Feature | API | UI | Status |
|---------|-----|-----|--------|
| Contact list with pagination (50/page) | ✅ | ✅ | Complete |
| Server-side search (name/email/organization) | ✅ | ✅ | Complete |
| Tag filtering & colored tag pills | ✅ | ✅ | Complete |
| Add/Edit contact (slide-out Sheet) | ✅ | ✅ | Complete |
| Delete contact | ✅ | ✅ | Complete |
| CSV bulk import (skip duplicates) | ✅ | ✅ | Complete |
| CSV export (all org contacts) | ✅ | ✅ | Complete |
| Contact detail + event history | ✅ | ✅ | Complete |
| Import contacts → Event Speakers | ✅ | ✅ | Replaced by Import from Registrations |
| Import contacts → Event Registrations | ✅ | ✅ | Complete |
| Import registrations → Event Speakers | ✅ | ✅ | Complete |
| "Import from Registrations" button on Speakers page | N/A | ✅ | Complete |
| "Import from Contacts" button on Registrations page | N/A | ✅ | Complete |

**API Endpoints:**
- `GET /api/contacts` — Paginated list with `search`, `tags`, `page`, `limit`
- `POST /api/contacts` — Create single contact (409 on duplicate email per org)
- `GET /api/contacts/[contactId]` — Single contact + event history (speaker/attendee appearances)
- `PUT /api/contacts/[contactId]` — Update contact
- `DELETE /api/contacts/[contactId]` — Delete contact
- `POST /api/contacts/import` — CSV bulk import via multipart/form-data; returns `{ created, skipped, errors[] }`
- `GET /api/contacts/export` — Downloads CSV attachment with all org contacts
- `POST /api/events/[eventId]/speakers/import-contacts` — `{ contactIds }` → creates speakers skipping duplicates (legacy, replaced by import-registrations on UI)
- `POST /api/events/[eventId]/speakers/import-registrations` — `{ registrationIds }` → imports event registrations as speakers, deduplicates by email
- `POST /api/events/[eventId]/registrations/import-contacts` — `{ contactIds, ticketTypeId }` → creates attendees + registrations in transaction

**Key Design Decisions:**
- Contacts are org-scoped (`@@unique([organizationId, email])`) — no cross-org leakage
- Event history is _derived_ (no join table) — queried live from Speaker/Registration by email match
- CSV import uses manual parser (no extra deps), handles quoted fields with embedded commas
- Import dialog remounts on open (via incrementing `key`) to avoid `setState-in-effect` lint issues
- `createMany({ skipDuplicates: true })` for idempotent CSV imports
- All list queries paginated — never loads full 100k dataset client-side

**New Files:**
- `prisma/schema.prisma` — Contact model + `contacts Contact[]` on Organization
- `src/app/api/contacts/route.ts`
- `src/app/api/contacts/[contactId]/route.ts`
- `src/app/api/contacts/import/route.ts`
- `src/app/api/contacts/export/route.ts`
- `src/app/api/events/[eventId]/speakers/import-contacts/route.ts`
- `src/app/api/events/[eventId]/registrations/import-contacts/route.ts`
- `src/app/(dashboard)/contacts/page.tsx`
- `src/app/(dashboard)/contacts/[contactId]/page.tsx`
- `src/components/contacts/import-contacts-dialog.tsx`
- `src/components/contacts/import-contacts-button.tsx`

**Modified Files:**
- `src/hooks/use-api.ts` — 7 new hooks + `contacts`/`contact` query keys
- `src/components/layout/sidebar.tsx` — Contacts nav item (after Events, hidden for REVIEWER/SUBMITTER)
- `src/app/api/events/[eventId]/speakers/import-registrations/route.ts`
- `src/components/speakers/import-registrations-dialog.tsx`
- `src/components/speakers/import-registrations-button.tsx`
- `src/app/(dashboard)/events/[eventId]/speakers/page.tsx` — Import from Registrations button (replaced Import from Contacts)
- `src/app/(dashboard)/events/[eventId]/registrations/page.tsx` — Import from Contacts button

---

### Title & Registration Type Fields + Sentry Client Instrumentation (February 26, 2026)

#### Title field across all person models
- [x] Added `Title` enum to Prisma schema (MR, MS, MRS, DR, PROF, OTHER)
- [x] Added `title Title?` to Attendee, Speaker, and Contact models
- [x] Created `TitleSelect` dropdown component (`src/components/ui/title-select.tsx`)
- [x] Created shared `titleEnum` Zod schema (`src/lib/schemas.ts`) used across 9+ API routes
- [x] Added `formatPersonName()` and `getTitleLabel()` helpers to `src/lib/utils.ts`
- [x] Updated `PersonFormFields` shared component with TitleSelect in 3-column grid `[100px_1fr_1fr]`
- [x] Updated all standalone forms (speaker edit, contact edit, registration detail sheet, public registration)
- [x] All display views (registration table, speaker list/detail, contact list/detail, breadcrumbs) now show title prefix via `formatPersonName()`
- [x] CSV export (registrations + contacts) includes title column

#### Registration Type field across all person models
- [x] Added `registrationType String?` to Attendee, Speaker, and Contact models
- [x] Created `RegistrationTypeSelect` component (`src/components/ui/registration-type-select.tsx`) — fetches TicketType names when `eventId` provided, falls back to plain text input otherwise
- [x] Updated `PersonFormFields` with `RegistrationTypeSelect` alongside specialty field
- [x] Updated all standalone forms and API routes with Zod validation + DB writes
- [x] CSV export (registrations + contacts) includes registrationType column

#### Sentry client-side instrumentation
- [x] Created `src/instrumentation-client.ts` with DSN from `NEXT_PUBLIC_SENTRY_DSN` env var and replay integration
- [x] Deleted old `sentry.client.config.ts` (prevents duplicate `Sentry.init()`)
- [x] Replay: 10% session sample rate, 100% on error

**New Files:**
- `src/instrumentation-client.ts` — Sentry client initialization (Next.js 15+ convention)
- `src/lib/schemas.ts` — Shared Zod schemas (`titleEnum`)
- `src/components/ui/title-select.tsx` — Title enum dropdown
- `src/components/ui/registration-type-select.tsx` — Registration type dropdown with event context

**Modified Files:**
- `prisma/schema.prisma` — Title enum + title/registrationType on 3 models
- `src/lib/utils.ts` — `formatPersonName()`, `getTitleLabel()`
- `src/components/forms/person-form-fields.tsx` — Title + registrationType fields, eventId prop
- 9 API routes — Zod schemas + DB writes for title/registrationType
- 7 display pages — `formatPersonName()` for name rendering with title prefix
- `src/app/api/contacts/export/route.ts` — title + registrationType in CSV export
- `src/app/(dashboard)/events/[eventId]/registrations/page.tsx` — title + registrationType in CSV export

**Deleted Files:**
- `sentry.client.config.ts` — Replaced by `src/instrumentation-client.ts`

---

### Sentry Error Monitoring & CI/CD Hardening (February 24, 2026)

#### Sentry integration
- [x] Installed `@sentry/nextjs@10` via Sentry wizard
- [x] `src/instrumentation-client.ts` — session replay (10% sample, 100% on error) with DSN from `NEXT_PUBLIC_SENTRY_DSN` env var (replaced old root-level `sentry.client.config.ts`)
- [x] `sentry.server.config.ts` / `sentry.edge.config.ts` — server and edge runtime error capture
- [x] `src/instrumentation.ts` — `register()` loads server/edge configs; `onRequestError` captures server-side route errors (Next.js 15+ hook)
- [x] `src/app/global-error.tsx` — root React error boundary, calls `Sentry.captureException` for client-side crashes
- [x] `next.config.ts` wrapped with `withSentryConfig`; `org`/`project`/`authToken` read from env vars
- [x] Sentry source map upload wired into GitHub Actions Build step via `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT` secrets

**New Files:**
- `src/instrumentation-client.ts` (replaced root-level `sentry.client.config.ts`)
- `sentry.server.config.ts`
- `sentry.edge.config.ts`
- `src/app/global-error.tsx`

**Required GitHub Secrets:**
- `SENTRY_AUTH_TOKEN` — Internal Integration token (Sentry → Developer Settings → Internal Integrations)
- `SENTRY_ORG` — Sentry org slug
- `SENTRY_PROJECT` — Sentry project slug

#### Blue-green zero-downtime deploy
- [x] `scripts/deploy.sh` — builds inactive slot, health-checks it, switches nginx upstream, stops old slot
- [x] Database migrations run via builder-stage Docker container before traffic switches (full `node_modules` available; `DIRECT_URL` used to bypass connection pooler)
- [x] `docker run --env-file` quote-stripping fixed — values extracted and unquoted via `sed` before passing as `-e "DATABASE_URL=..."`)
- [x] All rollback paths (migration failure, health check, nginx config) now `stop` + `rm -f` the failed container
- [x] Migrator image (`ea-sys-migrator`) tagged from cached builder stage (~1s), removed after migrations complete

#### GitHub Actions CI/CD improvements
- [x] Removed broken `npm install @lightningcss/linux-x64-gnu` workaround (wrong scoped package name; no longer needed after lockfile fix)
- [x] Removed redundant lightningcss binding verification step
- [x] SSH `command_timeout` increased from `15m` → `25m` (Docker build + health check on t3.large was tight)
- [x] Sentry source maps uploaded during Build step in CI

#### npm lockfile stability
- [x] Root cause: `npm install` on macOS only resolves platform-specific optional binaries for the current OS; Linux binaries were absent from `package-lock.json`, causing `npm ci` to fail on GitHub Actions (Linux) with `Invalid Version`
- [x] Fixed by pinning Linux binaries in `optionalDependencies`:
  - `lightningcss-linux-x64-gnu: 1.30.2` (TailwindCSS CSS engine)
  - `@tailwindcss/oxide-linux-x64-gnu: 4.1.18` (TailwindCSS v4 native compiler)
- [x] Lockfile regenerated; all 760 packages have valid version fields

#### Dockerfile improvements
- [x] Builder stage: `COPY package.json package-lock.json` + `npm ci` replaces `npm install` without lockfile — deterministic builds, faster due to lockfile cache layer
- [x] Runner stage: removed incomplete `node_modules/prisma` copy (missing `effect` transitive dep); migrations now run from the builder stage instead

---

### Fixes & Enhancements (February 23, 2026)

#### Specialty field on Abstract
- [x] Added `specialty` field to `Abstract` model (Prisma schema)
- [x] Added to create/edit Zod schemas and `db.abstract.create/update` in API routes
- [x] `SpecialtySelect` added to Submit Abstract dialog and Edit Abstract dialog on abstracts page
- [x] SUBMITTER role can set specialty on own abstracts (not restricted as a review field)

#### Speaker `specialty` field
- [x] Added `specialty String?` to `Speaker` model in Prisma schema
- [x] Updated submitter registration API (`POST /api/public/events/[slug]/submitter`) to accept and store specialty
- [x] Updated speakers POST/PUT API routes to accept `specialty`
- [x] Added `SpecialtySelect` to the public abstract submitter form (`/e/[slug]/submitAbstract`)

#### TagInput chip component
- [x] Created `src/components/ui/tag-input.tsx` — badge chips with × to remove, Enter/comma to add, Backspace on empty removes last tag; no duplicates
- [x] Replaced comma-string `<Input>` tag fields in `PersonFormFields`, `RegistrationDetailSheet`, and the contacts form
- [x] Contacts form state changed from `tags: string` to `tags: string[]`

#### Photo upload fixes
- [x] Fixed photo not saving: removed `z.string().url()` from 5 API route Zod schemas — upload returns relative paths (`/uploads/photos/...`) which `.url()` rejects
- [x] Fixed contacts POST not persisting `photo`, `city`, `country` (were validated but missing from `db.contact.create`)
- [x] Added `src/app/uploads/[...path]/route.ts` — Next.js standalone mode does not serve `public/` directory automatically; this catch-all handler streams uploaded files with correct `Content-Type` and `Cache-Control: immutable` headers; includes path-traversal protection

#### Public URL restructure
- [x] `/e/[slug]` is now a server-side redirect to `/e/[slug]/register`
- [x] Full submitter registration form moved to `/e/[slug]/register`
- [x] Abstract submission URL widget added to abstracts page (organizer/admin only) — copyable link with description

#### Docker deployment fix
- [x] Fixed container naming conflict in GitHub Actions deploy workflow
- [x] Replaced `docker compose up -d --no-deps ea-sys` with `docker compose down --remove-orphans && docker compose up -d`
- [x] Prior failed deployments left hash-prefixed orphan containers that caused "already in use" errors on next deploy

#### PersonFormFields shared component
- [x] Created `src/components/forms/person-form-fields.tsx` — reusable fields block (name, email, org, job title, photo, city/country, specialty, tags, bio, website, dietary) used across registrations, speakers, and contacts forms

---

### EC2 Production Deployment (February 18, 2026)
- [x] Docker multi-stage build (builder + runner stages, `node:22-slim`)
- [x] `docker-compose.prod.yml` — production compose file with `ea-sys` service on port 3000
- [x] nginx reverse proxy with HTTP→HTTPS redirect, gzip, security headers, long-cache for `/_next/static/`
- [x] SSL via Let's Encrypt — automated renewal with `certbot-dns-godaddy` plugin (no manual renewal needed)
- [x] GitHub Actions workflow (`.github/workflows/deploy.yml`) — triggers on push to `main`; runs tsc + lint + build (with Sentry source map upload), SSHes into EC2, runs `scripts/deploy.sh`
- [x] Blue-green deploy (`scripts/deploy.sh`) — builds inactive slot, runs DB migrations via builder-stage container, health-checks on `/api/health`, switches nginx upstream, stops old slot; zero downtime
- [x] systemd service (`ea-sys.service`) — Docker container auto-starts on EC2 reboot
- [x] Elastic IP associated to EC2 instance for stable DNS
- [x] Docker data root moved to `/mnt/data` (30 GB attached EBS volume) — keeps root volume free

**Infrastructure:**
- Platform: AWS EC2 t3.large (2 vCPU, 8 GB RAM) — `me-central-1` region
- OS: Ubuntu 24.04 LTS
- Domain: `events.meetingmindsgroup.com`
- Container: Docker Compose (`docker-compose.prod.yml`)
- Reverse proxy: nginx (system service)
- SSL: Let's Encrypt via certbot + GoDaddy DNS plugin (auto-renews)
- Deploy: GitHub Actions → SSH → git reset → docker compose build + restart

**Disk Layout:**
| Mount | Device | Size | Notes |
|-------|--------|------|-------|
| `/` | `/dev/root` | 8.7 GB | OS + app code only (~57% used) |
| `/mnt/data` | `/dev/nvme1n1` | 30 GB | Docker data root (images, volumes, build cache) |
| `/boot` | `/dev/nvme0n1p16` | 881 MB | Boot partition |

Docker data root configured in `/etc/docker/daemon.json`:
```json
{ "data-root": "/mnt/data/docker" }
```

**Disk Maintenance:**
- `docker image prune -f` runs automatically after each deploy (removes dangling images)
- All Docker storage (images, volumes, build cache) lives on `/mnt/data` — root volume stays clean
- Run `docker system prune -af` on `/mnt/data` if the data volume fills up

**New Files:**
- `Dockerfile` — multi-stage Docker build
- `docker-compose.prod.yml` — production compose with template blocks for future apps
- `deploy/nginx.conf` — nginx SSL config with template for additional apps
- `deploy/setup.sh` — one-time EC2 server setup script
- `.github/workflows/deploy.yml` — GitHub Actions CI/CD pipeline
- `.dockerignore` — excludes node_modules, .env, .next, logs

---

### Authenticated Abstract Submission via SUBMITTER Accounts (February 16, 2026)
- [x] SUBMITTER role — org-independent restricted user (mirrors REVIEWER pattern)
- [x] Submitter account registration at `/e/[slug]/register` (public, no auth)
- [x] Registration API at `POST /api/public/events/[slug]/submitter` — creates User (role=SUBMITTER) + Speaker linkage
- [x] Checks `event.settings.allowAbstractSubmissions` and `abstractDeadline` before accepting
- [x] Find-or-create Speaker by `(eventId, email)` on registration
- [x] Event scoping: submitters see only events where they have a linked Speaker record
- [x] Abstracts page: SUBMITTER view shows only own abstracts, submit dialog auto-selects speaker, edit button for DRAFT/SUBMITTED/REVISION_REQUESTED
- [x] Review actions hidden for submitters; review feedback shown read-only
- [x] `denyReviewer()` guard blocks both REVIEWER and SUBMITTER on all non-abstract write endpoints
- [x] Middleware redirects SUBMITTER from non-abstract routes to abstracts (same as REVIEWER)
- [x] Sidebar shows only "Events" globally, only "Abstracts" in event context for SUBMITTER
- [x] Dashboard redirects SUBMITTER to `/events`; header shows "Submitter Portal"
- [x] Status notification emails sent to speaker when reviewer changes abstract status
- [x] "Call for Abstracts" card on public event page (`/e/[slug]`) links to registration
- [x] Public event API extended with tracks and abstract settings
- [x] Email templates: `abstractSubmissionConfirmation`, `abstractStatusUpdate`

**New Files:**
- `src/app/api/public/events/[slug]/submitter/route.ts` — Submitter account creation
- `src/app/e/[slug]/register/page.tsx` — Submitter registration form

**Modified Files:**
- `prisma/schema.prisma` — `managementToken` on Abstract, `SUBMITTER` in UserRole
- `src/lib/email.ts` — `abstractSubmissionConfirmation` + `abstractStatusUpdate` templates
- `src/lib/auth-guards.ts` — `denyReviewer()` now blocks SUBMITTER too
- `src/lib/event-access.ts` — `buildEventAccessWhere()` adds SUBMITTER branch (`speakers.some.userId`)
- `src/middleware.ts` — Redirects both REVIEWER and SUBMITTER from non-abstract routes
- `src/components/layout/sidebar.tsx` — SUBMITTER nav filtering (Events only, Abstracts only)
- `src/components/layout/header.tsx` — "Submitter Portal" fallback
- `src/app/(dashboard)/dashboard/page.tsx` — Redirect SUBMITTER to `/events`
- `src/app/(dashboard)/events/[eventId]/abstracts/page.tsx` — SUBMITTER-specific view (own abstracts, edit, no review actions)
- `src/app/api/events/[eventId]/abstracts/route.ts` — SUBMITTER filter + speaker ownership validation
- `src/app/api/events/[eventId]/abstracts/[abstractId]/route.ts` — SUBMITTER edit restrictions + status notification emails
- `src/app/api/public/events/[slug]/route.ts` — Tracks + abstract settings in response
- `src/app/e/[slug]/page.tsx` — "Call for Abstracts" link to `/e/[slug]/register`

### Org-Independent Reviewers (February 11, 2026)
- [x] `User.organizationId` made nullable in Prisma schema
- [x] Reviewers created with `organizationId: null` — not tied to any organization
- [x] One reviewer can be invited to events across multiple organizations
- [x] `buildEventAccessWhere()` removes org filter for reviewers — scoped only by `event.settings.reviewerUserIds`
- [x] Auth system (NextAuth) handles nullable `organizationId` in JWT/session callbacks
- [x] Dashboard redirects reviewers to `/events` (no org dashboard data)
- [x] Header shows "Reviewer Portal" fallback for org-less users
- [x] Cross-org check removed from `findOrCreateReviewerUser()` — existing reviewers can be re-assigned to any org's events
- [x] All 30+ admin-only API routes use non-null assertion (`!`) for `organizationId` (safe behind `denyReviewer()` guard)

### Reviewer API Access Hardening (February 10, 2026)
- [x] Created `src/lib/auth-guards.ts` with reusable `denyReviewer()` helper
- [x] Added 403 Forbidden guard to **29 POST/PUT/DELETE handlers** across **20 API route files**
- [x] Registrations: POST, PUT, DELETE, check-in, email — all blocked for reviewers
- [x] Speakers: POST, PUT, DELETE, email — all blocked for reviewers
- [x] Tickets (registration types): POST, PUT, DELETE — all blocked for reviewers
- [x] Sessions: POST, PUT, DELETE — all blocked for reviewers
- [x] Tracks: POST, PUT, DELETE — all blocked for reviewers
- [x] Hotels + room types: POST, PUT, DELETE — all blocked for reviewers
- [x] Accommodations: POST, PUT, DELETE — all blocked for reviewers
- [x] Bulk emails: POST — blocked for reviewers
- [x] Registrations page split into 4 focused files (~68% reduction in main page size)

### Reviewer Event Visibility Hardening (Updated February 10, 2026)
- [x] Reviewer access remains limited to events where the reviewer is explicitly assigned.
- [x] Reviewer sidebar event navigation now shows only **Abstracts** (no Overview or other event modules).
- [x] Middleware now redirects reviewers to `/events/[eventId]/abstracts` for any non-abstract event route.
- [x] Direct URL access to event overview, registrations, tickets, schedule, accommodation, speakers, and event settings is blocked for reviewers.
- [x] Final reviewer experience target achieved: reviewer users see only abstracts inside an event context.
- [x] **Event creation blocked**: "Create Event" button hidden from events list page for REVIEWER role.
- [x] Middleware redirects reviewers from `/events/new` to `/events` (previously redirected to non-existent `/events/new/abstracts`).
- [x] Events list page now uses `buildEventAccessWhere` to scope query — reviewers only see assigned events (was showing all org events).
- [x] **Write-action UI hidden for reviewers**: Speakers page (Add Speaker button), Schedule page (Add Track, Add Session, edit/delete buttons on tracks and sessions), Registrations page (Add Registration, Share Link), Registration detail sheet (Edit, Check In, Send Email, Delete, status management dropdowns).

### User Invitation System (Complete)
- [x] User invitation email template with Cerulean Blue gradient header
- [x] Secure invitation token generation (32 bytes, 7-day expiry)
- [x] Token storage in VerificationToken table
- [x] Updated organization users API to send invitation emails
- [x] Accept invitation API endpoint (GET for validation, POST for password setup)
- [x] Accept invitation UI page with form validation
- [x] Email verification on invitation acceptance
- [x] Audit logging for invitation actions
- [x] Settings page updated with toast notifications (replaced temp password alert)
- [x] Loading states and disabled states during invitation submission

**New Files:**
- `src/app/api/auth/accept-invitation/route.ts` - API endpoint for invitation acceptance
- `src/app/(auth)/accept-invitation/page.tsx` - UI for accepting invitations

**Updated Files:**
- `src/app/api/organization/users/route.ts` - Now sends invitation emails
- `src/app/(dashboard)/settings/page.tsx` - Toast notifications, improved UX
- `src/lib/email.ts` - Added `userInvitation` email template
- `src/app/globals.css` - New color scheme and gradient utilities

**Invitation Flow:**
1. Admin invites user via Settings > Team Members > Add User
2. System generates secure token, creates user with placeholder password
3. Invitation email sent with setup link (valid 7 days)
4. User clicks link, validates token, sets password
5. User redirected to login page

**API Endpoints:**
- `GET /api/auth/accept-invitation?token=...&email=...` - Validate invitation token
- `POST /api/auth/accept-invitation` - Accept invitation and set password

---

## Updates (January 27, 2026)

### Vercel Deployment (runs in parallel with EC2 — both deploy from `main`)
- [x] Configured project for Vercel deployment
- [x] Added `postinstall` script for Prisma client generation
- [x] Created `vercel.json` with build configuration
- [x] Fixed Prisma version compatibility (locked to v6.x for `directUrl` support)
- [x] Added `trustHost: true` for NextAuth.js behind Vercel proxy
- [x] Updated `.env.example` with required environment variables

**Deployment Configuration:**
- Platform: Vercel
- Build Command: `prisma generate && next build`
- Node.js Version: 22.x (via Vercel settings)
- Framework: Next.js (auto-detected)
- Region: `iad1` (US East - configurable in vercel.json)
- Function Max Duration: 30 seconds

**Required Environment Variables for Vercel:**
- `DATABASE_URL` - PostgreSQL connection string (pooled, with `?pgbouncer=true&connection_limit=1`)
- `DIRECT_URL` - PostgreSQL direct connection (for migrations)
- `NEXTAUTH_SECRET` - Random secret for JWT signing
- `NEXTAUTH_URL` - Production URL (e.g., https://your-app.vercel.app)

### API Performance Optimizations
- [x] Parallel query execution using `Promise.all` for auth + params
- [x] Fetch event validation and data queries in parallel
- [x] Added `stale-while-revalidate` cache headers to GET endpoints
- [x] Optimized validation queries with `select: { id: true }`
- [x] Configured Vercel region closer to database
- [x] Bulk email API uses `Promise.allSettled` for parallel email sending
- [x] Registrations route: parallelized params/auth/body, event/ticketType/attendee queries
- [x] Sessions POST route: parallelized all validation queries (event, track, abstract, speakers)
- [x] Speakers POST route: parallelized event validation and existing speaker check

### Session Edit Popup (Calendar & List Views)
- [x] Click-to-edit session popup in calendar view
- [x] Full session form with all fields (name, description, times, track, status)
- [x] Speaker assignment with multi-select checkboxes
- [x] Speaker status badges (CONFIRMED, INVITED, DECLINED)
- [x] Fetch all speakers (not just confirmed) for assignment

### Speaker Assignment Improvements
- [x] All speakers visible in session forms (regardless of status)
- [x] Status badges displayed next to speaker names
- [x] Color-coded status (green=CONFIRMED, yellow=INVITED, red=DECLINED)

### UX Improvements
- [x] Global cursor pointer styles for all interactive elements (buttons, links, inputs)
- [x] Click-once protection on form submissions (prevents double-click issues)
- [x] Disabled state styling with `cursor-not-allowed`
- [x] Loading state styling with `cursor-wait` and `pointer-events: none`

### Email Notifications (Brevo Integration)
- [x] Brevo SDK installed and configured
- [x] Email service with professional HTML templates
- [x] Speaker invitation email template
- [x] Speaker agreement email template
- [x] Registration confirmation email template
- [x] Event reminder email template
- [x] Custom notification email template
- [x] Send email to individual speaker (invitation, agreement, custom)
- [x] Send email to individual registration (confirmation, reminder, custom)
- [x] Bulk email API for multiple recipients
- [x] Email dropdown menu on speaker detail page
- [x] Fixed User model field references (firstName/lastName vs name)
- [x] Fixed Registration model to include Attendee relation for email access
- [x] DB-backed email templates (EmailTemplate model, CRUD API, per-event customization)
- [x] WYSIWYG email editor (Tiptap v2) replacing raw HTML textarea
- [x] Email preview dialog with desktop (600px) / mobile (375px) toggle
- [x] Consistent email branding: `emailHeaderImage` + `emailFooterHtml` fields on Event model
- [x] Branding wrapper (`wrapWithBranding`) applied at render time to all outgoing emails
- [x] CSS inlining via `juice` for email-client compatibility
- [x] Templates stored as body fragments (branding applied at render time, not stored per-template)
- [x] Template list inlined in Settings → Email Templates tab (no separate page navigation)
- [x] Template editor: source toggle, variable insertion sidebar, save/preview/test/reset/delete
- [x] `renderAndWrap()` helper combining variable substitution + branding + CSS inlining

**API Endpoints:**
- `POST /api/events/[eventId]/speakers/[speakerId]/email` - Send email to speaker
- `POST /api/events/[eventId]/registrations/[registrationId]/email` - Send email to registration
- `POST /api/events/[eventId]/emails/bulk` - Send bulk emails
- `GET /api/events/[eventId]/email-templates` - List all templates for event
- `POST /api/events/[eventId]/email-templates` - Create custom template
- `GET /api/events/[eventId]/email-templates/[templateId]` - Get template + variables
- `PUT /api/events/[eventId]/email-templates/[templateId]` - Update template
- `DELETE /api/events/[eventId]/email-templates/[templateId]` - Delete custom template
- `POST /api/events/[eventId]/email-templates/[templateId]` - Preview or send test email
- `PATCH /api/events/[eventId]/email-templates/[templateId]` - Reset to default

**Required Environment Variables:**
- `BREVO_API_KEY` - Get from https://app.brevo.com/settings/keys/api
- `EMAIL_FROM` - Verified sender email address
- `EMAIL_FROM_NAME` - Sender display name

> **General Guidance:** The email template system uses Tiptap v2 (not v3). Tiptap v3 ships source-only packages without compiled `dist/` files, which breaks standard npm installs. If upgrading Tiptap, verify that the new version ships pre-compiled artifacts. The `juice` package is used for CSS inlining — it is stable and rarely changes. All email branding is applied at send time via `renderAndWrap()`, not stored in templates. System-level templates (user invitation, password reset) are hardcoded in `src/lib/email.ts` and do NOT use event branding.

---

## Updates (March 23, 2026)

### Barcode, Badge & Check-In System

#### Barcode Import
- [x] `barcode` field on Registration model (`@unique` with index)
- [x] CSV import API (`POST /api/events/[eventId]/import/barcodes`)
- [x] Matches by `registrationId` or `email` + eventId fallback
- [x] Duplicate barcode validation
- [x] Import dialog UI with results summary (imported/skipped/errors)
- [x] CSV export includes Registration ID and Barcode columns

#### Badge PDF Generation
- [x] Server-side PDF generation with `pdfkit`
- [x] Barcode image rendering with `bwip-js` (Code128 format)
- [x] A4 layout: 6 badges per page (2×3 grid), 4"×3" badge size
- [x] Badge layout: event name header, ticket type, attendee name, organization, barcode
- [x] Fallback to QR code text when no barcode imported
- [x] Generate for selected registrations or all
- [x] Badge dialog UI with download

#### Check-In Scanner Page
- [x] Mobile-optimized full-screen check-in page (`/events/[eventId]/check-in`)
- [x] Camera mode: `html5-qrcode` library for QR/barcode scanning via device camera
- [x] Manual/Scanner mode: auto-focused text input for hardware barcode scanners
- [x] Check-in API searches by both `qrCode` and `barcode` fields
- [x] Live attendance counter with progress bar
- [x] Recent scans log (last 10) with color-coded results (success/warning/error)
- [x] Sound feedback via Web Audio API (success beep, error buzz)
- [x] Debounce: prevents double-scan within 2 seconds
- [x] Sidebar navigation link with ScanBarcode icon

### Performance Optimization (March 2026)
- [x] `select: { id: true }` on all event existence-check queries (25+ route files)
- [x] Parallelized event + entity lookups in speaker and abstract routes
- [x] Reduced over-fetching in registration list (accommodation includes)
- [x] Event footer WYSIWYG editor (TiptapEditor replacing textarea in settings)

### Public Registration UI Improvements
- [x] Banner image constrained to container width (not full viewport)
- [x] Removed org logo from public pages
- [x] Center-aligned footer on public pages
- [x] White email background (replaced gray #f4f4f5)
- [x] Registration type editable via dropdown in registration detail sheet

---

## Updates (January 26, 2026)

### New Features

#### Event Settings
- [x] Event settings page with tabs (General, Registration, Notifications)
- [x] Update event details (name, description, dates, venue, address)
- [x] Event deletion with confirmation
- [x] Event status management
- [x] Settings stored in event.settings JSON field

#### Organization Settings
- [x] Organization settings page
- [x] Update organization name and details
- [x] Team member management (view members)

#### Schedule Calendar View
- [x] Calendar/time-grid view for sessions (`/events/[eventId]/schedule/calendar`)
- [x] Sessions displayed on time grid (6 AM - 10 PM)
- [x] Multi-track column layout when viewing all tracks
- [x] Date navigation (prev/next day)
- [x] Track filtering
- [x] Session cards with tooltips showing full details
- [x] Color-coded by track

#### Speaker Assignment to Sessions
- [x] Multi-select checkbox UI in session form
- [x] Assign multiple speakers to a session
- [x] Speaker selection persists when editing sessions
- [x] Shows confirmed speakers only

### Infrastructure Updates

#### Authentication Fixes
- [x] Fixed Edge Runtime compatibility (split auth.config.ts for middleware)
- [x] Fixed credential verification in authorize function
- [x] Session properly includes user organization context

#### Date/Time Handling
- [x] Fixed hydration errors with UTC-based date formatting
- [x] Consistent date formatting across server/client
- [x] Added formatTime, formatDate, formatDateLong utilities

#### Development Environment
- [x] Removed Docker dependency for local development
- [x] Added .nvmrc for Node.js 22
- [x] Created .env.example template
- [x] Updated next.config.ts with standalone output

### UI Components Added
- [x] Checkbox component (`/components/ui/checkbox.tsx`)
- [x] Alert Dialog component (`/components/ui/alert-dialog.tsx`)
- [x] Switch component (`/components/ui/switch.tsx`)

---

## Updates (January 22, 2026)

### UI/UX Improvements

#### Collapsible Sidebar
- [x] Sidebar toggle button at the bottom
- [x] Collapse to icon-only mode (64px width)
- [x] State persistence in localStorage
- [x] Tooltips for navigation items when collapsed
- [x] Smooth transition animations
- [x] "Back to Events" link when on event pages

#### Enhanced Header
- [x] Event selector dropdown when on event pages
- [x] Switch between events while staying on same sub-page
- [x] Breadcrumb navigation showing current location
- [x] Clickable "Overview" link in breadcrumb
- [x] Current page indicator in breadcrumb

#### Registration Page Enhancements
- [x] "Add Registration" button with dialog form
- [x] Search by name, email, or company
- [x] Filter by registration status
- [x] Filter by payment status
- [x] Filter by ticket type
- [x] Export to CSV functionality
- [x] Clear filters button

### Infrastructure

#### Logging System
- [x] Replaced console.error with structured logging (pino)
- [x] Module-specific loggers for different parts of the application
- [x] Automatic sensitive data redaction
- [x] Removed verbose Prisma query logging from console
- [x] Pretty-printed logs in development

---

## Remaining Phases

> **⚠️ Historical section.** The phase labels below were accurate at their original
> time of writing. Several have **shipped since** and are corrected inline. Treat the
> "Current Status" block at the top of this document as authoritative.

### Phase 5: Payment Integration (✅ COMPLETED)

| Feature | Status |
|---------|--------|
| Stripe Checkout Setup | ✅ Complete (`src/lib/stripe.ts`, live keys via env) |
| Checkout Session Creation | ✅ Complete (`/api/public/events/[slug]/checkout`, IP rate-limited) |
| Webhook Handler | ✅ Complete (`/api/webhooks/stripe` — signature verify + idempotent) |
| Payment Confirmation Flow | ✅ Complete (status polling + confirmation page + email) |
| Refund Processing | ✅ Complete (`.../refund` route + `charge.refunded` webhook) |
| Manual / Offline Payment Capture | ✅ Complete (`.../payments` — cash/bank/card-onsite) |
| Invoice Generation | ✅ Complete (quote PDF at registration → PAID invoice PDF after payment) |
| Invoice Reconciliation Worker | ✅ Complete (recovers webhook-dropped invoices; needs worker deploy) |
| Payment Receipt / Invoice Email | ✅ Complete (Stripe sends receipt; we send the branded invoice) |
| Tax / VAT | ✅ Complete (per-event rate/label, separate Stripe line items) |
| Promo Codes / Pricing Tiers / Third-party Payer / INCLUSIVE | ✅ Complete |

### Phase 6: Email Notifications (MOSTLY COMPLETE)

| Feature | Priority | Status |
|---------|----------|--------|
| Email Service Setup (Brevo) | High | ✅ Complete |
| Registration Confirmation Email | High | ✅ Complete |
| Speaker Invitation Email | Medium | ✅ Complete |
| Speaker Agreement Email | Medium | ✅ Complete |
| Event Reminder Emails | Low | ✅ Complete |
| Bulk Email to Attendees | Low | ✅ Complete |
| Custom Notification Emails | Low | ✅ Complete |
| Payment Receipt / Invoice Email | High | ✅ Complete (post-payment branded invoice + payment-confirmation email) |
| Abstract Status Notification | Medium | ✅ Complete |
| Abstract Submission Confirmation | Medium | ✅ Complete |
| DB-backed Email Templates | High | ✅ Complete |
| WYSIWYG Email Editor (Tiptap) | High | ✅ Complete |
| Email Preview Dialog (Desktop/Mobile) | Medium | ✅ Complete |
| Consistent Email Branding (Header/Footer) | High | ✅ Complete |
| CSS Inlining (juice) | Medium | ✅ Complete |
| Check-in Confirmation | Low | Pending |
| Email Preferences Management | Low | Pending |

**Completed Tasks:**
1. ✅ Set up Brevo email service
2. ✅ Create professional HTML email templates
3. ✅ Speaker email APIs (invitation, agreement, custom)
4. ✅ Registration email APIs (confirmation, reminder, custom)
5. ✅ Bulk email API endpoint
6. ✅ DB-backed email template CRUD (per-event customization)
7. ✅ WYSIWYG editor with Tiptap v2 (toolbar, source toggle)
8. ✅ Email preview dialog with desktop/mobile toggle
9. ✅ Consistent email branding (header image + footer) applied to all outgoing emails
10. ✅ CSS inlining via juice for email-client compatibility

**Remaining Tasks:**
1. Add email preferences management
2. Payment receipt email
3. Check-in confirmation email

### Phase 7: Public Registration Portal (PARTIALLY COMPLETE)

| Feature | Priority | Status |
|---------|----------|--------|
| Public Event Landing Page | High | ✅ Complete (`/e/[slug]/register`) |
| Attendee Registration Form | High | ✅ Complete (ticket selection, personal details) |
| Submitter Registration Form | High | ✅ Complete (`/e/[slug]/register` — creates SUBMITTER account) |
| Registration Confirmation Page | High | ✅ Complete (`/e/[slug]/confirmation`) |
| Payment Checkout Flow | High | ✅ Complete (Stripe Checkout — Phase 5) |
| Email Verification | Medium | ✅ Partial (internal-domain verification flow, June 16; general attendee verification not required) |
| Attendee Profile Portal | Low | ✅ Complete (`/my-registration` registrant self-service portal) |

### Phase 8: Reporting & Analytics (✅ PARTIALLY COMPLETE)

| Feature | Status |
|---------|--------|
| Event Dashboard (registration/payment/speaker/session KPIs) | ✅ Complete (event overview page + `get_event_dashboard`) |
| Event Analytics endpoint | ✅ Complete (`/api/events/[eventId]/analytics`, revenue finance-gated) |
| Revenue Reports | ✅ Complete (analytics + invoice list; AR-aging-by-payer is backlog) |
| Attendance Reports | ✅ Complete (registrations + webinar attendance KPIs/CSV) |
| Registrations-by-Tier dashboard tile | ✅ Complete |
| Export to CSV | ✅ Complete (registrations, contacts, attendance) |
| Custom Report Builder | ⬜ Backlog (not started — low priority) |

### Phase 9: Advanced Features (NOT STARTED)

| Feature | Priority | Estimated Effort |
|---------|----------|------------------|
| QR Code Scanner (Mobile Web) | High | ✅ Complete |
| Badge Printing (PDF with barcodes) | Medium | ✅ Complete |
| Barcode Import (CSV) | High | ✅ Complete |
| Check-In Scanner Page (Camera + Manual) | High | ✅ Complete |
| Calendar Integration (ICS Export) | Medium | Low |
| Session Feedback/Ratings | Medium | Medium |
| Networking/Attendee Directory | Low | High |
| Mobile App (PWA) | Low | High |
| Multi-language Support | Low | High |
| Custom Branding per Event | Low | Medium |

### Phase 10: Admin & Operations (IN PROGRESS)

| Feature | Priority | Estimated Effort | Status |
|---------|----------|------------------|--------|
| Event Settings Page | High | Medium | ✅ Complete |
| Organization Settings | High | Medium | ✅ Complete |
| User Management (Invite Team) | High | Medium | ✅ Complete |
| User Invitation Emails | High | Medium | ✅ Complete |
| Role-based Permissions | Medium | Medium | ✅ Complete (8 roles, `denyReviewer` + `canViewFinance` + middleware, 3-layer enforcement) |
| Audit Log Viewer | Medium | Low | ✅ Complete (`AuditLog` + `/logs` SUPER_ADMIN viewer) |
| Data Import (Bulk) | Medium | Medium | ✅ Complete (Contact Store CSV + CSV/EventsAir registration import) |
| Event Duplication | Low | Low | ✅ Complete (`/api/events/[eventId]/clone`) |
| Archive/Delete Events | Low | Low | ✅ Complete |

---

## Technical Debt & Improvements

### Code Quality
- [x] Request validation — Zod on every mutating route (+ `apiLogger.warn` on every validation failure; 0 silent 400s)
- [x] API rate limiting — `checkRateLimit` on every write surface (per-IP / per-user / per-event / per-key buckets) + nginx per-IP limiting + fail2ban
- [x] Unit tests — 1600+ vitest cases (services, RBAC, finance redaction, races, email, etc.)
- [x] E2E tests with Playwright — `e2e/*.spec.ts` (admin smoke, abstract submitter, certificates, bulk-email, manual registration, help-chat, …)
- [ ] Comprehensive error-handling middleware (per-route try/catch + typed errors today; a shared middleware layer is still nice-to-have)
- [ ] Redis-backed shared rate limiter (in-memory store resets on deploy / is per-container — see ROADMAP)

### Performance
- [x] Implement database query optimization (parallel queries)
- [x] Add cache headers (stale-while-revalidate)
- [x] Server page query parallelization (speakers page, event detail page)
- [x] Prisma `select` on server pages to reduce query payload size
- [x] Composite database indexes on Registration (`[eventId, status]`, `[eventId, ticketTypeId]`)
- [x] Removed redundant indexes (Organization `@@index([slug])` duplicated `@unique`)
- [x] Narrowed middleware matcher to dashboard routes only (skip public/API/auth/static)
- [x] Fixed Prisma client caching (dev-only `globalThis` pattern)
- [x] `select: { id: true }` on all event existence-check queries across 25+ API route files
- [x] Parallelized independent queries in speaker/abstract detail routes
- [x] Reduced over-fetching in registration list (trimmed accommodation includes)
- [x] Split registrations page (1,246 → 393 lines) into 4 focused sub-components
- [ ] Add Redis caching for frequently accessed data
- [ ] Optimize bundle size (add missing Radix packages + date-fns to `optimizePackageImports`)
- [ ] Remove unused tRPC dependencies (~200KB in node_modules)
- [ ] Add image optimization for uploads
- [ ] Implement pagination for large lists
- [ ] Add granular React Query stale times per data type
- [x] Extract services layer (thin routes, reusable business logic) — **done**: 5 services (`accommodation`, `abstract`, `speaker`, `registration`, `billing-account`) shared by REST + MCP; conventions in `src/services/README.md`

### Security
- [x] CSRF protection — Origin header validation on all API mutations; missing Origin blocked for browser sessions (middleware)
- [x] `customFields` XSS prevention — replaced `z.any()` with strict `z.union([string, number, boolean, null])` on registration routes
- [x] Accommodation overbooking fix — all room create/update/delete + `bookedRooms` wrapped in `db.$transaction()` with fresh capacity checks
- [x] User list data leak fix — REVIEWER/SUBMITTER blocked from `GET /api/organization/users` via `organizationId` null check
- [x] Event settings protection — `reviewerUserIds` stripped from incoming settings in event update (managed by reviewers API only)
- [x] Import ticket capacity — EventsAir contact import checks `soldCount` vs `quantity` with atomic increment inside transaction
- [x] API key management — restricted to ADMIN+ role (previously only `denyReviewer` guard)
- [x] Implement API key authentication for external access (`GET /api/events`, `/speakers`, `/registrations` support `x-api-key` header)
- [x] Input sanitization — DOMPurify on stored HTML, `escapeHtml` in emails, Zod typing, magic-byte file validation
- [x] Rate limiting per user/IP — `checkRateLimit` + nginx `limit_req` + fail2ban
- [x] Security audits — multiple multi-agent adversarial passes (May 18 IDOR/RBAC, June 23 multi-tenant readiness — see `docs/PRODUCTION_AUDIT.md`); `getClientIp` spoofing fix
- [ ] Formal third-party OWASP-Top-10 pen test (internal audits done; external engagement still recommended before white-label launch)

### DevOps
- [x] Vercel deployment configured (note: photo uploads not supported on Vercel)
- [x] Create deployment documentation
- [x] CI/CD pipeline via GitHub Actions (auto-deploy to EC2 on push to `main`)
- [x] EC2 production deployment (Docker + nginx + SSL)
- [x] Fixed Docker container naming conflict in deploy workflow (`down --remove-orphans` before `up -d`)
- [x] Blue-green zero-downtime deploy (`scripts/deploy.sh`) — health-checked slot swap, nginx upstream reload, automated DB migrations
- [x] Error monitoring via Sentry (`@sentry/nextjs`) — client crashes, server route errors, source maps uploaded in CI
- [x] Fixed `npm ci` failures on Linux (pinned `lightningcss-linux-x64-gnu` + `@tailwindcss/oxide-linux-x64-gnu` in `optionalDependencies`)
- [x] Dockerfile hardened: `npm ci` with lockfile for deterministic builds
- [x] Database backups / DR — Singapore S3 mirror (uploads hourly, `.env` daily, `pg_dump` daily 23:00 UTC) + quarterly restore drill (`infra/dr/`)
- [x] Background worker tier — dedicated `ea-sys-worker` container, 6 cron jobs, Postgres advisory-lock singleton (`worker/`)
- [x] Observability — Sentry + CloudWatch Logs + `SystemLog`/`/logs` dashboard + per-error SES alert email (four parallel paths)
- [ ] Configure dedicated staging environment (deploys go straight to prod via blue-green today)
- [ ] Dedicated APM / tracing (request-span tracing not yet wired; logs+metrics cover most needs)

---

## File Structure

```
src/
├── app/
│   ├── (auth)/
│   │   ├── login/
│   │   ├── register/
│   │   └── accept-invitation/     ✅ (new - user invitation acceptance)
│   ├── (dashboard)/
│   │   ├── dashboard/
│   │   ├── contacts/               ✅ (new - Contact Store)
│   │   │   ├── page.tsx            ✅ (list + search + CSV import/export)
│   │   │   └── [contactId]/
│   │   │       └── page.tsx        ✅ (detail + event history)
│   │   ├── layout.tsx              ✅ (with SidebarProvider)
│   │   └── events/
│   │       ├── [eventId]/
│   │       │   ├── abstracts/        ✅
│   │       │   ├── accommodation/    ✅
│   │       │   ├── registrations/
│   │       │   │   └── [registrationId]/  ✅
│   │       │   ├── schedule/         ✅
│   │       │   │   └── calendar/     ✅ (new)
│   │       │   ├── settings/         ✅ (new)
│   │       │   ├── speakers/
│   │       │   │   ├── new/          ✅
│   │       │   │   └── [speakerId]/  ✅
│   │       │   └── tickets/          ✅
│   │       └── new/
│   ├── settings/                 ✅ (new - org settings)
│   └── api/
│       ├── auth/
│       │   └── accept-invitation/ ✅ (new - invitation acceptance endpoint)
│       ├── contacts/              ✅ (new - Contact Store)
│       │   ├── route.ts           ✅ (GET list, POST create)
│       │   ├── [contactId]/
│       │   │   └── route.ts       ✅ (GET, PUT, DELETE + event history)
│       │   ├── import/
│       │   │   └── route.ts       ✅ (CSV bulk import)
│       │   └── export/
│       │       └── route.ts       ✅ (CSV download)
│       └── events/
│           └── [eventId]/
│               ├── abstracts/        ✅
│               ├── accommodations/   ✅
│               ├── hotels/           ✅
│               ├── registrations/
│               │   └── import-contacts/ ✅ (new)
│               ├── sessions/         ✅
│               ├── speakers/
│               │   └── import-contacts/ ✅ (new)
│               ├── tickets/          ✅
│               ├── tracks/           ✅
│               └── route.ts          ✅ (new - single event CRUD)
├── components/
│   ├── contacts/                   ✅ (new - Contact Store shared components)
│   │   ├── import-contacts-dialog.tsx  ✅ (reusable contact picker dialog)
│   │   └── import-contacts-button.tsx  ✅ (client wrapper for server pages)
│   ├── layout/
│   │   ├── header.tsx              ✅ (with event selector)
│   │   └── sidebar.tsx             ✅ (collapsible)
│   └── ui/
│       ├── tooltip.tsx             ✅
│       ├── checkbox.tsx            ✅ (new)
│       ├── switch.tsx              ✅ (new)
│       └── alert-dialog.tsx        ✅ (new)
├── contexts/
│   └── sidebar-context.tsx         ✅ (new)
├── lib/
│   ├── auth.ts                       ✅
│   ├── auth.config.ts                ✅ (Edge-compatible)
│   ├── db.ts                         ✅ (with logger)
│   ├── email.ts                      ✅ (Brevo email service + templates)
│   ├── logger.ts                     ✅ (pino logger)
│   └── utils.ts                      ✅ (with UTC date utilities)
└── types/
```

---

## API Summary

| Resource | Endpoints | Status |
|----------|-----------|--------|
| Events | 5 | ✅ Complete |
| Tickets | 5 | ✅ Complete |
| Registrations | 9 | ✅ Complete |
| Speakers | 6 | ✅ Complete |
| Tracks | 5 | ✅ Complete |
| Sessions | 5 | ✅ Complete |
| Abstracts | 5 | ✅ Complete |
| Hotels | 5 | ✅ Complete |
| Room Types | 5 | ✅ Complete |
| Accommodations | 5 | ✅ Complete |
| Organization | 2 | ✅ Complete |
| Organization Users | 4 | ✅ Complete |
| Auth (Accept Invitation) | 2 | ✅ Complete |
| Emails (Bulk) | 1 | ✅ Complete |
| Contacts (CRUD + import/export) | 7 | ✅ Complete |
| Event Speaker Import | 1 | ✅ Complete |
| Event Registration Import | 1 | ✅ Complete |
| Import (Barcodes) | 1 | ✅ Complete |
| Badges | 1 | ✅ Complete |
| **Total** | **75** | |

---

## Next Steps (Recommended Priority)

1. **Phase 5: Payment Integration** - Critical for monetization
2. **Phase 6: Email Notifications** - Essential for user communication
3. **Phase 7: Public Registration Portal** - Required for attendee self-service
4. **Phase 10: Event Settings Page** - Complete the admin experience
5. **Phase 8: Reporting** - Important for event organizers

---

## Planned: Event People Overview Page

> **Context:** Speakers and Registrations remain separate entities (different workflows, data, and statuses). A unified "People" view is planned as a UI-only merge — no schema changes needed.

**Route:** `/events/[eventId]/people`

**Concept:** Client-side merge of `useSpeakers` + `useRegistrations` hooks into a single table with a **Role** column:

| Name | Email | Role | Status | Organization |
|------|-------|------|--------|--------------|
| Jane Smith | jane@example.com | Speaker + Attendee | CONFIRMED / CONFIRMED | Acme |
| John Doe | john@acme.com | Speaker | INVITED | Acme |
| Alice Wu | alice@corp.com | Attendee | CHECKED_IN | Corp |

**Key features planned:**
- Deduplication by email — persons appearing in both lists shown as a single row with "Speaker + Attendee" role
- Filter by role (All / Speaker only / Attendee only / Both)
- Quick-action column: send email, view speaker profile, view registration
- Export combined list to CSV
- No backend API changes needed — pure UI aggregation of existing endpoints

**Design note:** Same contact can be imported as a speaker into **multiple events** independently. The `@@unique([eventId, email])` constraint on Speaker prevents duplicates _within_ an event but allows the same person across any number of events. Their full cross-event history is visible on the Contact Store detail page (`/contacts/[contactId]`).

---

## Getting Started

```bash
# Install dependencies
npm install

# Set up database
npx prisma generate
npx prisma db push

# Run development server
npm run dev
```

**Environment Variables Required:**
```env
DATABASE_URL="postgresql://..."
NEXTAUTH_SECRET="..."
NEXTAUTH_URL="http://localhost:3000"
LOG_LEVEL="debug"  # Optional: debug, info, warn, error
```

---

### Zoom Integration (April 7-8, 2026)

- [x] Added `ZoomMeeting` Prisma model with enums (`ZoomMeetingType`, `ZoomMeetingStatus`) and 1:1 relation to `EventSession`
- [x] Created `src/lib/zoom/` server module (OAuth client with in-memory token cache + debug-level cache hit logging, meetings/webinars CRUD with per-operation logging, org-aware JWT signature generation)
- [x] All credentials stored AES-256-GCM encrypted per-org in `Organization.settings.zoom` — no env vars needed
- [x] Server-to-Server OAuth: accountId, clientId, clientSecretEncrypted
- [x] General App SDK with separate Dev and Prod keys: sdkKeyDev/sdkSecretDevEncrypted, sdkKeyProd/sdkSecretProdEncrypted, sdkMode toggle
- [x] Secrets optional on update — existing encrypted values preserved if left blank; GET returns `hasClientSecret`/`hasSdkSecretDev`/`hasSdkSecretProd` flags, never actual secrets
- [x] Per-event Zoom toggle via `Event.settings.zoom.enabled`
- [x] 7 API routes: credentials CRUD (with dev/prod SDK), test connection, event settings, session meeting CRUD (with startUrl/passcode), panelist sync, public join (org-aware signature), public session detail (event branding + speakers)
- [x] 7 UI components: credentials form with Dev/Prod sections + Active SDK Mode dropdown, settings card with step-by-step setup guide, meeting form with Start as Host / Attendee Join / Copy Link / Open Embed Page, session badge with live pulse, join button, embed viewer (preserved for future), series schedule
- [x] Branded public session landing page at `/e/[slug]/session/[sessionId]` — event banner, org name, session title/date/time/location, speakers sidebar with photos and bios, Live/Upcoming/Ended badges, prominent "Join Meeting" CTA opening Zoom web client, meeting details card, DRAFT events supported for testing
- [x] 10 React Query hooks for Zoom state management
- [x] AI agent tools: `list_zoom_meetings`, `create_zoom_meeting`
- [x] Zoom badge on session cards (calendar tooltip + session list)
- [x] Webinar series support (recurring webinar with `type: 9`, occurrence tracking)
- [x] Rate limiting on all Zoom endpoints: create 30/hr, join 60/hr, credentials 10/hr, test 10/hr, panelists 30/hr — all with `apiLogger.warn` on rejection
- [x] Full logging coverage: `zoom:creating-meeting`, `zoom:api-call` (with durationMs), `zoom:api-error` (with zoomErrorCode), `zoom:token-cache-hit` (with ttlMs), `zoom:oauth-token-refreshed`, `zoom:join-via-sdk`/`zoom:join-via-url`, `zoom:adding-panelists`, `zoom:panelists-synced`, `zoom:credentials-saved`/`deleted`, all validation failures logged as warn
- [x] Performance: OAuth token cache with 5-min pre-expiry refresh, Promise.all on all parallel queries, Prisma select everywhere, no N+1 patterns, stateless public endpoints (~2ms per join request)
- [x] `@zoom/meetingsdk` in `serverExternalPackages` to keep server bundle clean
- [x] Scoped `Permissions-Policy` header for microphone on embed pages only
- [x] `zoom-embed.tsx` preserved for future use — Zoom SDK v5/v6 bundles React 18, incompatible with React 19 (Next.js 16)
- [x] Migration: `20260408000000_add_speaker_accommodation_and_zoom`

**Meeting Types:**
- Meeting (type 2) — interactive, all participants share audio/video, up to 1,000
- Webinar (type 5) — broadcast, panelists speak, attendees view only, up to 10,000
- Webinar Series (type 9) — recurring webinar with multiple occurrences

**Modified Files:**
- `prisma/schema.prisma` — ZoomMeeting model + enums + relations to EventSession/Event
- `next.config.ts` — serverExternalPackages + permissions-policy
- `src/hooks/use-api.ts` — 10 new React Query hooks
- `src/lib/agent/event-tools.ts` — 2 new AI agent tools
- `src/app/(dashboard)/settings/page.tsx` — Zoom card in Integrations tab
- `src/app/(dashboard)/events/[eventId]/settings/page.tsx` — Zoom tab with setup guide
- `src/app/(dashboard)/events/[eventId]/schedule/page.tsx` — Zoom button + badges in session UI
- `src/app/api/events/[eventId]/sessions/route.ts` — zoomMeeting in session response

**New Files (22):**
- `src/lib/zoom/` (5 files) — types (with dev/prod SDK), client, meetings, signature, index
- `src/app/api/` (7 routes) — credentials, test-connection, settings, meeting CRUD, panelists, public join, public detail
- `src/components/zoom/` (7 components) — credentials, settings, meeting form, badge, join button, embed (preserved), series
- `src/app/e/[slug]/session/[sessionId]/page.tsx` — branded public session landing page
- `prisma/migrations/20260408000000_.../migration.sql` — database migration

**Known Limitation:** Zoom Meeting SDK (`@zoom/meetingsdk` v5/v6) bundles React 18 internally — incompatible with React 19 / Next.js 16. In-browser embedded meetings not currently possible. Branded landing page redirects to Zoom web client instead.

**Documentation:** `docs/ZOOM_INTEGRATION.html` — complete implementation guide with architecture, setup, logging, performance, and file list

---

*Document maintained by the development team. Update as features are completed.*
