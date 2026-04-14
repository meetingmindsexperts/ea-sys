# Event Management System - Development Status

**Last Updated:** April 14, 2026
**Project:** EA-SYS (Event Administration System)

---

## Executive Summary

This document outlines the current development status of the Event Administration System, detailing completed features, in-progress work, and planned future phases.

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
| Delete Registration | ✅ | ❌ | API Complete |
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
| Create Booking | ✅ | ❌ | API Complete |
| List Bookings | ✅ | ✅ | Complete |
| View Booking Details | ✅ | ✅ | Complete |
| Update Booking Status | ✅ | ❌ | API Complete |
| Cancel Booking | ✅ | ❌ | API Complete |
| Price Calculation | ✅ | ✅ | Complete |

**API Endpoints:**
- `GET /api/events/[eventId]/accommodations` - List bookings
- `POST /api/events/[eventId]/accommodations` - Create booking
- `GET /api/events/[eventId]/accommodations/[id]` - Get booking
- `PUT /api/events/[eventId]/accommodations/[id]` - Update booking
- `DELETE /api/events/[eventId]/accommodations/[id]` - Delete booking

---

## Recent Updates (April 14, 2026)

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
- **Phase 6** — Polls/Q&A reports from Zoom + panelist management UI (existing panelists API just needs a dashboard CRUD page)

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

### Phase 5: Payment Integration (NOT STARTED)

| Feature | Priority | Estimated Effort |
|---------|----------|------------------|
| Stripe Integration Setup | High | Medium |
| Payment Intent Creation | High | Medium |
| Webhook Handler | High | Medium |
| Payment Confirmation Flow | High | Medium |
| Refund Processing | Medium | Medium |
| Invoice Generation | Medium | Medium |
| Payment Receipt Emails | Medium | Low |

**Required Tasks:**
1. Configure Stripe API keys in environment
2. Create `/api/payments/initiate` endpoint
3. Create `/api/payments/webhook` endpoint for Stripe webhooks
4. Build payment UI components
5. Implement payment status synchronization
6. Add payment confirmation emails

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
| Payment Receipt Email | High | Pending |
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
| Payment Checkout Flow | High | ❌ Not Started (requires Stripe) |
| Email Verification | Medium | ❌ Not Started |
| Attendee Profile Portal | Low | ❌ Not Started |

### Phase 8: Reporting & Analytics (NOT STARTED)

| Feature | Priority | Estimated Effort |
|---------|----------|------------------|
| Registration Analytics Dashboard | High | Medium |
| Revenue Reports | High | Medium |
| Attendance Reports | Medium | Medium |
| Speaker Statistics | Medium | Low |
| Export to CSV/Excel | Medium | Medium |
| Check-in Analytics | Low | Low |
| Custom Report Builder | Low | High |

**Required Tasks:**
1. Create analytics API endpoints
2. Build dashboard charts (use Recharts or similar)
3. Implement data export functionality
4. Add date range filters

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
| Role-based Permissions | Medium | Medium | Pending |
| Audit Log Viewer | Medium | Low | Pending |
| Data Import (Bulk) | Medium | Medium | ✅ Complete (Contact Store CSV) |
| Event Duplication | Low | Low | Pending |
| Archive/Delete Events | Low | Low | ✅ Complete |

---

## Technical Debt & Improvements

### Code Quality
- [ ] Add comprehensive error handling middleware
- [ ] Implement request validation middleware
- [ ] Add API rate limiting
- [ ] Write unit tests for API routes
- [ ] Write integration tests for critical flows
- [ ] Add E2E tests with Playwright

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
- [ ] Extract services layer (thin routes, reusable business logic)

### Security
- [x] CSRF protection — Origin header validation on all API mutations; missing Origin blocked for browser sessions (middleware)
- [x] `customFields` XSS prevention — replaced `z.any()` with strict `z.union([string, number, boolean, null])` on registration routes
- [x] Accommodation overbooking fix — all room create/update/delete + `bookedRooms` wrapped in `db.$transaction()` with fresh capacity checks
- [x] User list data leak fix — REVIEWER/SUBMITTER blocked from `GET /api/organization/users` via `organizationId` null check
- [x] Event settings protection — `reviewerUserIds` stripped from incoming settings in event update (managed by reviewers API only)
- [x] Import ticket capacity — EventsAir contact import checks `soldCount` vs `quantity` with atomic increment inside transaction
- [x] API key management — restricted to ADMIN+ role (previously only `denyReviewer` guard)
- [x] Implement API key authentication for external access (`GET /api/events`, `/speakers`, `/registrations` support `x-api-key` header)
- [ ] Add input sanitization
- [ ] Security audit for OWASP top 10
- [ ] Add rate limiting per user/IP

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
- [ ] Configure staging environment
- [ ] Set up database backups
- [ ] Add performance monitoring (APM)

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
