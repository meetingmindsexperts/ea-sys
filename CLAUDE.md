# CLAUDE.md - Project Context for AI Assistants

This file provides context for AI assistants (like Claude) working on this codebase.

## Project Overview

**EA-SYS (Event Administration System)** is a full-stack event management platform built with Next.js. It enables organizations to manage conferences, meetings, and events including registrations, speakers, schedules, accommodations, and communications.

## Tech Stack

- **Framework:** Next.js 16 (App Router)
- **Language:** TypeScript
- **Database:** PostgreSQL with Prisma ORM
- **Authentication:** NextAuth.js v5 with JWT strategy
- **Styling:** TailwindCSS + Shadcn/ui components
- **State Management:** TanStack Query (React Query) for client-side caching
- **Email:** Brevo (formerly Sendinblue) or SendGrid (auto-detected via env var)
- **Deployment:** AWS EC2 t3.large via Docker (events.meetingmindsgroup.com) — primary production; Vercel also connected but photo uploads are not supported there (no writable filesystem in serverless)

## Project Structure

> Regenerated **August 6, 2026** from the actual tree. This is an **orientation
> map of directories** — deliberately not a file index, because an index is what
> rots. For "which files implement domain X", read
> [docs/DOMAIN_MAP.html](docs/DOMAIN_MAP.html); for the durable invariants, read
> [AGENTS.md](AGENTS.md). When you add a top-level directory (a new `src/lib/*`
> module, a dashboard page group, a worker job), add it here.

```
ea-sys/
├── src/
│   ├── app/                       # Next.js App Router
│   │   ├── (auth)/                # login, register, accept-invitation, forgot/reset-password
│   │   ├── (dashboard)/           # everything behind auth
│   │   │   ├── dashboard/         # org-wide home
│   │   │   ├── events/            # event list + creation
│   │   │   │   └── [eventId]/     # ~28 per-event pages, grouped by workflow:
│   │   │   │                      #  Setup: settings · content · tickets · agenda ·
│   │   │   │                      #    sponsors · media · setup (hub) · readiness
│   │   │   │                      #  People: registrations · speakers · reviewers ·
│   │   │   │                      #    accommodation · imports · onsite-staff (in settings)
│   │   │   │                      #  Program: session-proposals · abstracts
│   │   │   │                      #  Money: invoices · promo-codes · reimbursements
│   │   │   │                      #  Live day: check-in (+ /kiosk) · webinar
│   │   │   │                      #  After: analytics · certificates · survey
│   │   │   │                      #  Comms: communications · email-templates
│   │   │   │                      #  Other: dinner (RSVP) · agent (AI) · my-details
│   │   │   ├── crm/               # CRM module UI (deals/companies/contacts/tasks/
│   │   │   │                      #   products/templates/reports/inbox/activity)
│   │   │   ├── admin/             # SUPER_ADMIN: docs viewer · help-queries · infra
│   │   │   ├── contacts/ invoices/ media/ activity/ logs/ settings/   # org-level
│   │   │   ├── my-registration/ my-reviews/ profile/                  # per-user portals
│   │   │   └── layout.tsx         # sidebar + header shell
│   │   ├── e/[slug]/              # PUBLIC event pages (no auth)
│   │   │   │                      #   register · group/register · abstract/register ·
│   │   │   │                      #   proposal/register · complete-registration ·
│   │   │   │                      #   confirmation · agenda · session/[id] · survey ·
│   │   │   │                      #   rsvp · reimbursement · speaker-form ·
│   │   │   │                      #   speaker-agreement · presenter-agreement ·
│   │   │   │                      #   login · my-registration · forgot/reset-password
│   │   │   └── submitAbstract/    # LEGACY — permanent redirect to abstract/register
│   │   ├── api/
│   │   │   ├── events/[eventId]/  # the big one — ~40 per-event route groups mirroring
│   │   │   │                      #   the dashboard pages above
│   │   │   ├── public/events/[slug]/  # unauthenticated: register · group-register ·
│   │   │   │                      #   checkout · abstract-start · submitter · survey ·
│   │   │   │                      #   rsvp · agenda · sessions · validate-promo …
│   │   │   ├── mcp/               # MCP Streamable HTTP + OAuth 2.1 (register/token/
│   │   │   │                      #   revoke/authorize) — see src/lib/mcp-oauth.ts
│   │   │   ├── crm/               # CRM REST surface
│   │   │   ├── cron/              # LEGACY shims — the worker tier is the live runner
│   │   │   ├── admin/ organization/ contacts/ invoices/ billing-accounts/
│   │   │   ├── registrant/ my-reviews/ profile/ notifications/ activity/
│   │   │   ├── media/ upload/ import/ email-logs/ help-chat/ logs/
│   │   │   ├── auth/ webhooks/    # NextAuth · Stripe (global + per-org)
│   │   │   └── health/ openapi.json/
│   │   ├── .well-known/           # OAuth protected-resource + authorization-server metadata
│   │   ├── mcp-authorize/         # OAuth consent screen (outside the dashboard shell)
│   │   ├── admin/docs/[...path]/  # shareable direct-URL doc server, ADMIN+ (the browsable
│   │   │                          #   viewer lives at (dashboard)/admin/docs)
│   │   ├── uploads/[...path]/     # streams files from public/uploads/ (standalone mode)
│   │   ├── api-docs/              # public Scalar OpenAPI reference
│   │   ├── health/ worker/health/ # liveness probes (app + worker proxy)
│   │   ├── auth/profile/          # LEGACY redirect → /profile
│   │   └── verify-email/          # internal-domain email verification
│   ├── services/                  # SHARED DOMAIN LOGIC — the anti-drift layer.
│   │                              #   Called by REST + MCP + cron; errors-as-values;
│   │                              #   never imports next/server. READ services/README.md
│   │                              #   BEFORE extracting a new one. Shipped: registration ·
│   │                              #   group-registration · speaker · abstract · session ·
│   │                              #   accommodation · payment · promo-code · billing-account
│   ├── crm/                       # CRM module — hard namespace boundary, one-way
│   │                              #   imports crm→core only (components/hooks/lib/services)
│   ├── hr/                        # HR module (attendance + UAE leave) — same one-way
│   │                              #   boundary as crm. MASTER SILO ONLY, gated by
│   │                              #   HR_MODULE_ENABLED; schema is tenant-correct anyway.
│   │                              #   lib/ (pure: balance engine, precedence, dates) ·
│   │                              #   services/ · hooks/
│   ├── lib/                       # cross-cutting server + shared libs
│   │   ├── agent/                 # AI-agent + MCP tool definitions & executors
│   │   │   └── tools/             # per-domain executor files (events, registrations, …)
│   │   ├── ai/                    # provider abstraction (Anthropic, OpenAI)
│   │   ├── certificates/          # render · issue-worker · bundle · tokens
│   │   ├── zoom/ webinar/         # Zoom API clients · webinar state machines
│   │   ├── tenant/                # multi-tenancy spine (host resolver, RLS assert)
│   │   ├── pdf/                   # shared PDF layout primitives (invoice/quote/receipt)
│   │   ├── survey/ rsvp/ reimbursement/ speaker-profile/ help-chat/ infra/
│   │   ├── auth.ts auth-guards.ts event-access.ts   # authN + RBAC + event scoping
│   │   ├── db.ts logger.ts utils.ts                 # Prisma · Pino · helpers
│   │   └── email.ts               # email service (AWS SES in prod; Brevo/SendGrid alt)
│   ├── components/                # React components, grouped by domain
│   │   ├── ui/                    # Shadcn/ui primitives
│   │   ├── layout/                # Header, Sidebar
│   │   └── …                      # speakers/ registrations/ certificates/ webinar/ …
│   ├── hooks/use-api.ts           # React Query hooks (the client data layer)
│   ├── mcp/                       # legacy stdio MCP transport (local dev only)
│   ├── contexts/ constants/ types/
│   └── proxy.ts                   # Next.js middleware (role redirects; renamed in 16.1)
├── worker/                        # BACKGROUND WORKER TIER — separate Node container
│   ├── index.ts                   # node-cron scheduler
│   ├── jobs/                      # 15 jobs: scheduled-emails · cert-issue · webinar-*
│   │                              #   · invoice-reconciliation · crm-* · *-prune · daily-digest
│   └── lib/                       # advisory-lock (singleton) · health-server · shutdown
├── prisma/
│   ├── schema.prisma  migrations/ # forward-only, additive + idempotent
│   ├── rls/                       # per-domain RLS policies (platform instance only)
│   └── seed-*.ts                  # e2e · docs-screenshots · tenancy · local scenarios
├── __tests__/                     # vitest unit/route tests (the main suite)
├── tests/tenancy/                 # RLS isolation harness (real Postgres + pgbouncer)
├── e2e/                           # Playwright specs (+ e2e/screenshots for the manual)
├── loadtest/                      # k6 scripts (capacity rehearsal)
├── docs/                          # DOMAIN_MAP · runbooks · reviews · plans
├── infra/                         # dr/ (Singapore DR) · cloudwatch/ · fail2ban/
├── scripts/                       # deploy.sh + one-off ops/reconciliation scripts
├── deploy/  docker/               # nginx config (+ live snapshot) · Dockerfile.dev
└── public/                        # static assets · user-guide.html · uploads/ (volume)
```

Root files worth knowing: `Dockerfile` + `Dockerfile.worker` (the two prod images),
`docker-compose.prod.yml` (blue/green web + worker + mediamtx), `mediamtx.yml`
(RTMP→HLS live streaming), `AGENTS.md` (invariants), `CHANGELOG.md`.

## Key Files

- `prisma/schema.prisma` - Database schema
- `src/lib/auth.ts` - Authentication configuration
- `src/lib/auth-guards.ts` - `denyReviewer()` guard for API route protection (blocks REVIEWER + SUBMITTER)
- `src/lib/event-access.ts` - `buildEventAccessWhere()` for role-scoped event queries. Reviewers→`settings.reviewerUserIds`, **ONSITE→`settings.onsiteUserIds`** (org-bound AND assigned), submitters→linked Speaker, registrants→linked Registration, else org-scoped. **Every ONSITE-reachable desk route must build its event lookup from this** (assignment-gated, not just org) — see the cross-event isolation test.
- `src/app/api/events/[eventId]/onsite-staff/route.ts` - per-event ONSITE assignment: `POST` (assign a userId to the event's `onsiteUserIds`), `GET` (list assigned), `DELETE` (unassign). Org-scoped, `denyReviewer`-guarded (ADMIN/ORGANIZER), target must be an ONSITE account in the caller's org, atomic `updateEventSettings`, audited.
- `src/app/api/organization/onsite-staff/route.ts` - `GET` org list of every ONSITE account + the events each is assigned to (powers the Settings tab).
- `src/components/settings/onsite-staff-card.tsx` - Settings → **Onsite Staff** tab (admin): create a temp (reuses `POST /api/organization/users` role=ONSITE + password mode) → assign to event(s); per-row searchable "Manage events" popover; remove-from-event chips; delete-account (strips stale ids first). Dialog is `max-w-xl`; event lists are searchable.
- `src/lib/email.ts` - Email templates, sending, branding wrapper, CSS inlining
- `src/lib/email-preview-data.ts` - `buildRealPreviewOverrides(eventId)` — async real-data layer for email previews/test-sends (first session + Zoom passcode/recording state, abstract titles/count, a representative speaker's real presentationDetails, real login/review links). Run by BOTH preview routes in parallel with their event lookup; failure-isolated (samples still render). The module header documents which tokens deliberately STAY representative samples (per-recipient minted links, payment artifacts, un-issued serials, entryBarcode)
- `src/lib/email-utils.ts` - Client-safe email utilities (stripDocumentWrapper)
- `src/lib/email-change.ts` - Shared helpers for the dedicated Change Email flow: `normalizeEmail()` (trim+lowercase+Zod-validate) + `repointOrgContactEmail(tx, …)` (returns `"updated" | "merged" | "none"`; when a Contact at the target email already exists in the org, deletes the old row as a silent merge). Consumed by all three PATCH `/email` routes. **Rule: `email` is immutable on Speaker/Registration/Contact via general PUT** — callers must use the dedicated PATCH routes. The PUT handlers return 400 `EMAIL_IMMUTABLE` with a pointer rather than silently stripping the field.
- `src/app/api/events/[eventId]/speakers/[speakerId]/email/route.ts` - POST sends email to speaker (pre-existing) + PATCH changes the speaker's canonical email. PATCH performs `Speaker.(eventId, email)` + `User.email` (global) collision checks, cascades to `User.email` when `speaker.userId` is set, re-points the org Contact row. Emits a warn log (but does NOT reject) when an unlinked speaker moves to an email that shadows an existing unrelated User row — a later register-to-account link flow would surface P2002 at that point, so the audit trail flags it up front. 30/hr rate limit on `email-change:${userId}` bucket shared with registration PATCH.
- `src/app/api/events/[eventId]/registrations/[registrationId]/email/route.ts` - POST sends email to registrant + PATCH changes canonical email. PATCH either mutates `Attendee.email` **or clones the Attendee row** when it's shared across multiple registrations — public-register's orphan-attendee reuse path can produce multi-registration-per-Attendee rows, and mutating in place would silently change siblings. Cascades `User.email` when `registration.userId` is set. The sibling-count check runs inside the same `$transaction` as the mutation so the read/write is consistent.
- `src/app/api/contacts/[contactId]/email/route.ts` - PATCH only. Org-scoped via `getOrgContext` (session or API key). Does NOT cascade to Speaker / User / Registration — Contact is a CRM snapshot and propagating from there would re-introduce exactly the identity drift this feature prevents; the UI surfaces this in the dialog hint. Separate 30/hr bucket `contact-email-change:org:${organizationId}` because contact edits commonly come from API keys where `userId` is null.
- `src/components/change-email-dialog.tsx` - Shared Dialog consumed by speaker / registration / contact detail sheets. Fields: new email + confirm (client lowercases, mirrors server). Contact mode surfaces a dedicated hint that the change is CRM-only. Toast branches on `userCascaded` + `contactAction` + `attendeeCloned` fields returned by the PATCH.
- `src/lib/countries.ts` - ISO 3166-1 country list (196 countries)
- `src/hooks/use-api.ts` - React Query hooks for data fetching
- `src/components/providers.tsx` - App providers (QueryClient, SessionProvider)
- `src/components/layout/sidebar.tsx` - Sidebar with role-based navigation
- `src/components/ui/photo-upload.tsx` - Reusable photo upload component with preview
- `src/components/ui/country-select.tsx` - Searchable country dropdown component
- `src/components/ui/tag-input.tsx` - Multi-tag chip input (Enter/comma to add, × to remove)
- `src/components/ui/specialty-select.tsx` - Specialty field dropdown
- `src/components/ui/title-select.tsx` - Title enum dropdown (Dr, Mr, Mrs, Ms, Prof — alphabetically sorted)
- `src/components/ui/registration-type-select.tsx` - Registration type dropdown (fetches from TicketType or falls back to text input)
- `src/components/ui/tiptap-editor.tsx` - WYSIWYG email editor (Tiptap v2) with toolbar, source toggle, and Layout dropdown (2-column, 3-column, content boxes, CTA button, divider, spacer)
- `src/components/email-preview-dialog.tsx` - Email preview dialog with desktop/mobile toggle
- `src/lib/speaker-agreement.ts` - `buildSpeakerEmailContext()` (single source of truth for speaker email vars: title, prefixed name, presentation HTML/text blocks, **moderator run-sheet blocks** (`{{moderatorDetails}}` — sessions the speaker moderates with per-topic speakers/durations/computed times), sessions, topics, dates, tracks, roles) + `generateSpeakerAgreementDocx()` (mail-merges an uploaded .docx via `docxtemplater` v3 with `{token}` delimiters; returns null when no template configured; path-traversal guarded). Used by both the single-send speaker email route and the bulk-email pipeline
- `src/app/api/events/[eventId]/speaker-agreement-template/route.ts` - GET/POST/DELETE for the per-event .docx template; DOCX MIME + zip magic-byte validation; 2MB cap; 10/hr rate limit per user; stores `{ url, filename, uploadedAt, uploadedBy }` to `Event.speakerAgreementTemplate` JSON; on replace/delete unlinks the previous file from disk
- `src/components/events/speaker-agreement-template-card.tsx` - Upload UI panel under Event Settings → Email Branding tab with file picker, current filename + uploaded-at, replace/remove buttons, and an inline reference list of the available `{token}` merge fields
- `src/app/api/profile/route.ts` - Per-user GET/PATCH for `User.emailSignature` (HTML, max 10000 chars). **STAFF-ONLY since Aug 7, 2026** (`isTeamRole` gate on both verbs, refusals logged): the signature is appended to ORGANISER emails, so an org-null role (reviewer / submitter / registrant) could only ever store data that never renders. They edit their details on My Details or on their registration instead. Supersedes the original "every authenticated user regardless of role" rule
- `src/app/(dashboard)/profile/page.tsx` - Profile page with Personal Information card (existing) + new Email Signature card (TiptapEditor lazy-loaded via `next/dynamic`). Signature is appended to outgoing speaker invitation/agreement emails sent by that user
- `src/lib/schemas.ts` - Shared Zod schemas (titleEnum) used across API routes
- `src/components/forms/person-form-fields.tsx` - Shared form fields for attendees/speakers/contacts
- `src/app/api/upload/photo/route.ts` - Photo upload endpoint with validation
- `src/app/uploads/[...path]/route.ts` - Static file handler for uploaded photos (streams from public/uploads/)
- `src/proxy.ts` - Route-level REVIEWER/SUBMITTER redirects (Next.js middleware; renamed from `middleware.ts` in Next 16.1)
- `src/lib/stripe.ts` - Stripe SDK singleton, zero-decimal currency helpers (`isZeroDecimalCurrency`, `toStripeAmount`, `fromStripeAmount`)
- `src/components/speakers/import-registrations-dialog.tsx` - Dialog to import event registrations as speakers
- `src/components/speakers/import-registrations-button.tsx` - Button trigger for import-registrations dialog
- `src/components/accommodation/assign-accommodation-dialog.tsx` - Dialog to assign a registration or speaker to a hotel room (searchable picker, room type selector grouped by hotel, date pickers, guest count)
- `src/lib/webinar.ts` - `isWebinar()`, `webinarModuleFilter()`, `WEBINAR_HIDDEN_MODULES`, `WebinarSettings` type — the conditional-UI hinge
- `src/lib/webinar-provisioner.ts` - Idempotent `provisionWebinar(eventId, { actorUserId })`; auto-called from `POST /api/events` on WEBINAR create
- `src/lib/webinar-email-sequence.ts` - `enqueueWebinarSequenceForEvent()` + `sendWebinarConfirmationForRegistration()` + `clearPendingWebinarSequence()`
- `src/lib/webinar-recording-sync.ts` - `syncRecordingForZoomMeeting()` state machine; called by cron + manual refetch
- `src/lib/webinar-attendance.ts` - `syncWebinarAttendance()` state machine; upserts per-segment rows into `ZoomAttendance`
- `src/lib/webinar-engagement.ts` - `syncWebinarEngagement()` state machine for polls + Q&A; transactional poll upsert to avoid duplicate logical polls under concurrent syncs
- `src/lib/zoom/recordings.ts` - `getZoomRecordings()` + `pickBestRecordingFile()` — Zoom cloud recording API client
- `src/lib/zoom/reports.ts` - `getZoomParticipants()` — paginated participant report API client
- `src/lib/zoom/polls-qa.ts` - `getWebinarPollReport()` + `getWebinarQaReport()` — Zoom engagement report clients
- `src/app/(dashboard)/events/[eventId]/webinar/page.tsx` - Webinar Console with sticky status bar + Setup/Analytics/Settings tabs; components: `WebinarStatusBar`, `OverviewCard`, `GlobalRefreshButton`, `PanelistsCard` (Import from Speakers + optimistic UI), `CardLoading`, `CardEmpty`
- `src/app/(dashboard)/events/[eventId]/sponsors/page.tsx` - Sponsors admin editor with draft-based editing, add/edit dialog (logo upload via `PhotoUpload`), up/down reorder arrows, grouped-by-tier list
- `src/components/zoom/zoom-web-embed.tsx` - `ZoomWebEmbed` — dynamic-imports `@zoom/meetingsdk/embedded` v6 Component View. Lifecycle (createClient → init → join → leaveMeeting → destroyClient), module-level `pendingDestroy` promise for StrictMode re-mount safety, `connection-change` subscription so the parent unmounts when the user clicks Zoom's in-meeting Leave button
- `src/app/e/[slug]/session/[sessionId]/page.tsx` - Public session page with sticky CTA + Live Video / Session Details / Sponsors tabs; dynamic-imports `ZoomWebEmbed` and `LivePlayer` so the SDK bundle stays off initial paint; uses `Event.settings.sponsors` via the public detail API
- `src/app/api/events/[eventId]/webinar/route.ts` - GET/PUT/POST webinar settings + manual re-provision
- `src/app/api/events/[eventId]/webinar/sequence/route.ts` - GET/POST webinar email sequence management
- `src/app/api/events/[eventId]/webinar/recording/fetch/route.ts` - POST manual recording refetch
- `src/app/api/events/[eventId]/webinar/attendance/route.ts` - GET attendance KPIs + rows + CSV export; POST manual sync
- `src/app/api/events/[eventId]/webinar/engagement/route.ts` - GET polls + Q&A; POST manual sync
- `src/app/api/events/[eventId]/webinar/panelists/route.ts` - GET/POST/DELETE panelists; exports `resolveAnchorZoomMeeting()` helper for sibling routes
- `src/app/api/events/[eventId]/webinar/panelists/sync-speakers/route.ts` - POST batch import from `SessionSpeaker[]`, dedup'd against existing Zoom panelists
- `src/app/api/events/[eventId]/sponsors/route.ts` - GET + PUT sponsors array (Zod-validated, URL scheme whitelisted so `javascript:`/`data:` URLs are rejected, server reassigns `sortOrder` from array index)
- `src/app/api/public/events/[slug]/sessions/[sessionId]/detail/route.ts` - Public session detail — returns session metadata + topics (with per-topic speakers via `TopicSpeaker`) + speakers with bios + sponsors (via `readSponsors`)
- `src/app/api/public/events/[slug]/sessions/[sessionId]/zoom-join/route.ts` - Returns `mode: "sdk"` (with sdkKey + signature + meetingNumber + passcode for the embed) or `mode: "url"` (generic Zoom web client redirect). 60/hr IP rate limit. Uses `generateZoomSignatureForOrg()`
- `src/app/api/cron/webinar-recordings/route.ts` - Cron worker (every 5 min) for recording retrieval
- `src/app/api/cron/webinar-attendance/route.ts` - Cron worker (every 10 min) for attendance sync; chains `syncWebinarEngagement()` per-row for polls + Q&A
- `src/mcp/server.ts` - Legacy stdio transport (launched via `src/mcp/start.sh` for local dev only); shares the same `registerAllMcpTools()` registration as the HTTP builder, so the two stay in sync (no drift)
- `src/lib/agent/event-tools.ts` - Entry point (~50 lines) that composes the per-domain executor maps into `TOOL_EXECUTOR_MAP` and re-exports `AgentContext`. The hand-written `AGENT_TOOL_DEFINITIONS` list was deleted on Sep 21, 2026 (Event Agent Phase 4): both doors take each tool's name, description and input schema from its Zod registration in `src/lib/agent/register-mcp-tools.ts` (the in-app door through `tool-registry.ts`), so a tool has ONE schema. **Every new tool goes in the appropriate `src/lib/agent/tools/*.ts` domain file**, NOT this entry point, **and is registered in `register-mcp-tools.ts`; bump the `package.json` version** (the MCP client cache-invalidation hint via `serverInfo.version`). An executor that is not registered is reachable by neither door.
- `src/lib/agent/tools/_shared.ts` - Shared types + constants for agent/MCP executors: `AgentContext` interface, `ToolExecutor` type, `EMAIL_RE`, `TITLE_VALUES`, `SPEAKER_STATUSES`, `REGISTRATION_STATUSES`, `MANUAL_REGISTRATION_STATUSES`, `MAX_EMAIL_RECIPIENTS`. Leaf module — must not import from other `tools/*.ts` files.
- `src/lib/agent/tools/events.ts` - events domain: `list_event_info`, `create_event`, `update_event` (safe-fields whitelist), `list_tracks`, `create_track`.
- `src/lib/agent/tools/registrations.ts` - registrations domain: `list_registrations`, `create_registration` (thin MCP wrapper — domain logic in `src/services/registration-service.ts`), `update_registration`, `create_registrations_bulk` (NOT service-backed — different mechanics), `bulk_update_registration_status`, `check_in_registration`, `list_unpaid_registrations`, `list_ticket_types`, `create_ticket_type`.
- `src/lib/agent/tools/speakers.ts` - speakers domain: `list_speakers`, `create_speaker` (thin MCP wrapper — domain logic lives in `src/services/speaker-service.ts`), `update_speaker`, `create_speakers_bulk`, `list_speaker_agreements`, `get_speaker_agreement_template`.
- `src/lib/agent/tools/sessions.ts` - sessions domain: `list_sessions`, `create_session` (persists capacity + topic abstractId), `update_session`, `add_topic_to_session`, `add_speaker_to_session`, `remove_speaker_from_session`, `replace_session_speakers`, `list_live_sessions_now`. **All 8 are registered once in `register-mcp-tools.ts`, which serves both the in-app agent and the MCP server** (the second, hand-written list is gone since Sep 21, 2026, so there is nothing to keep in sync).
- `src/lib/event-time.ts` - isomorphic event-timezone helpers (`resolveTimezone` default `Asia/Dubai`, `localDateInTz`, `isSessionWithinEventDates`, `formatTimeInTz`, `formatDateInTz`, `tzLabel`). Single source of truth for session date-validation (REST + MCP) + public time rendering. `Intl`-only, safe to import from client components.
- `src/lib/agent/tools/abstracts.ts` - abstracts + reviewers: `list_abstract_themes`, `create_abstract_theme`, `list_review_criteria`, `create_review_criterion` / `update_review_criterion` / `delete_review_criterion` (weight 1-100, matches the REST route), `list_abstracts` (caps at 200; uses shared `meanOverallScore` from `src/lib/abstract-review.ts`), `update_abstract_status` (thin MCP wrapper — domain logic in `src/services/abstract-service.ts`; `requiredReviewCount` gate centralized there), `list_reviewers`, `assign_reviewer_to_abstract` (**upserts** the role on re-call) / `unassign_reviewer_from_abstract`, `submit_abstract_review`, `get_abstract_scores`.
- `src/app/(dashboard)/events/[eventId]/abstracts/abstract-enums.ts` - shared abstract display constants (status colours + label, presentation-type options, reviewer-role options) used by the list + edit + new pages and the reviewers card. Exhaustive Prisma-enum-keyed Records (build fails if a new enum value lacks a mapping).
- `src/components/abstracts/abstract-reviewers-card.tsx` - per-abstract reviewer assignment card (admin/organizer only — self-hides for submitters). Assign/unassign reviewers from the event pool to a specific abstract with role (PRIMARY/SECONDARY/CONSULTING) + conflict-of-interest flag + submission status. Mounted on the abstract edit page sidebar + in a dialog from the abstracts list. Backed by `GET/POST/DELETE /api/events/[id]/abstracts/[aid]/reviewers` (POST upserts role/COI).
- `src/lib/agent/tools/accommodations.ts` - accommodations + hotels: `list_hotels`, `create_hotel`, `list_accommodations`, `list_room_types`, `create_accommodation` (thin MCP wrapper — domain logic lives in `src/services/accommodation-service.ts`), `update_accommodation_status`.
- `src/services/` - **Services layer (new — April 22, 2026).** Shared domain logic called by REST routes, MCP agent tools, cron workers, and (soon) external APIs. Errors-as-values result shape, already-typed inputs (no `string`→`Date` inside services), caller identity via `source: "rest" | "mcp" | "api"` written into `AuditLog.changes.source`. Service never imports from `next/server` — if it knew about HTTP, non-HTTP callers couldn't use it. See `src/services/README.md` for the full convention. **When extracting a new service, read the README first.** Services shipped: `accommodation-service`, `abstract-service`, `speaker-service`, `registration-service`, `promo-code-service`, `billing-account-service`, `payment-service` (refund + credit-note + cancel).
- `src/services/accommodation-service.ts` - `createAccommodation()` — the atomic overbooking guard (`updateMany` with `bookedRooms < totalRooms` predicate inside a `$transaction`). Called by REST POST `/api/events/[eventId]/accommodations` + MCP `create_accommodation`. 11 error codes (MISSING_ASSIGNEE, INVALID_DATES, EVENT_NOT_FOUND, REGISTRATION_NOT_FOUND, SPEAKER_NOT_FOUND, REGISTRATION_HAS_ACCOMMODATION, SPEAKER_HAS_ACCOMMODATION, ROOM_NOT_FOUND, GUEST_COUNT_EXCEEDS_CAPACITY, NO_ROOMS_AVAILABLE, UNKNOWN). Each caller maps the code to its own response format (REST → HTTP status, MCP → `{ error, code }`).
- `src/services/abstract-service.ts` - `changeAbstractStatus()` + `submitAbstractReview()` (July 13, 2026 — the ONE review-submission implementation; REST submissions POST + MCP `submit_abstract_review` + `admin_submit_review_on_behalf` all delegate; owns the pool/assignment/org-bound-admin auth matrix, H6 + COI + empty-payload gates, criteria validation, upsert, audit). `changeAbstractStatus()` — status-transition flow (UNDER_REVIEW / ACCEPTED / REJECTED / REVISION_REQUESTED / WITHDRAWN) with `requiredReviewCount` gate + chair-override + terminal-state guard + awaited `notifyAbstractStatusChange` with isolated failure handling (callers receive `notificationStatus`). Called by REST PUT `/api/events/[id]/abstracts/[aid]` (review+WITHDRAWN branch only — field updates stay inline) and MCP `update_abstract_status`. 5 error codes (INVALID_STATUS, ABSTRACT_NOT_FOUND, ABSTRACT_WITHDRAWN, INSUFFICIENT_REVIEWS, UNKNOWN). Reuses `src/lib/abstract-review.ts` + `src/lib/abstract-notifications.ts`.
- `src/services/speaker-service.ts` - `createSpeaker()` — single-create path. Called by REST POST `/api/events/[id]/speakers` + MCP `create_speaker`. 3 error codes (EVENT_NOT_FOUND, SPEAKER_ALREADY_EXISTS, UNKNOWN). Normalizes empty-string optional fields to null as a last line of defense for direct-to-service callers. Bulk paths (`MCP create_speakers_bulk`, `/import-registrations`) intentionally NOT in this service — different mechanics.
- `src/services/payment-service.ts` - the money-movement service (July 8, 2026). `refundRegistration()` (full/partial, credit-note-gated, `refundedAmount` optimistic lock, Stripe partial or offline-record; 8 codes incl. CREDIT_NOTE_REQUIRED / LOST_LOCK / STRIPE_FAILED), `issueCreditNoteForRegistration()` (paid gate + amount cap via `createCreditNote`; 5 codes), and `cancelRegistration()` (refund-BEFORE-cancel: for a PAID reg with `refund:true`, auto-issue a full credit note + refund the remaining, then cancel — release seat via `planSeatTransition`/`releaseSeat` + release promo usage; refund failure ABORTS the cancel; 4 codes). Called by the refund / credit-notes / cancel routes (all delegate; auth + rate-limit + event-access + HTTP mapping stay in the route). Owns audit + admin notification + `refreshEventStats`. `src/services/registration-service.ts` - `createRegistration()` — single-create path. Called by REST POST `/api/events/[id]/registrations` + MCP `create_registration`. 9 error codes (EVENT_NOT_FOUND, TICKET_TYPE_NOT_FOUND, SALES_NOT_STARTED, SALES_ENDED, SOLD_OUT, PRICING_TIER_NOT_FOUND, ALREADY_REGISTERED with `meta.existingRegistrationId`, INVALID_PAYMENT_STATUS, UNKNOWN). Owns: atomic tx with duplicate-check-inside-tx + `soldCount` `updateMany` guard via typed `RegistrationServiceSentinel` class; paymentStatus defaulting (UNASSIGNED for paid / COMPLIMENTARY for free); the Phase 0 confirmation-email gate (`price > 0 && finalPaymentStatus ∈ OUTSTANDING_PAYMENT_STATUSES`) so MCP cannot skip the email silently; empty-string → null normalization on all optional attendee fields. Public register path (`/api/public/events/[slug]/register` — Stripe checkout + REGISTRANT account) and MCP bulk (`create_registrations_bulk`) intentionally NOT in this service.
- `src/lib/registrant-account.ts` - `ensureRegistrantAccount()` — the create-or-link REGISTRANT account block shared by the public `register` + token-gated `complete-registration` routes (was two byte-identical ~60-line copies). Existing user → link this reg + sweep sibling unlinked registrations on the same email + first-time-only terms stamp; else create a REGISTRANT (`isTrustedInternalEmail` org-attach, `needsEmailVerification` verify link, admin SIGNUP notify). **Failure-isolated by contract** (account creation must never block the registration — wrapped try/catch, logs `registrant-account:create-or-link-failed` at error) and **no-ops when no password** (guest registration). Each caller passes its own `signupMessage` wording. NOT the same concern as `registration-service` (which mints the registration row); this only handles the User account behind it.
- `src/lib/registration-confirmation.ts` - `buildEventConfirmationFields(event)` — the ~19-field **event + org/company + tax/bank/support** block of a `sendRegistrationConfirmation` params object, extracted from 4 byte-identical inline copies (public `register`, `complete-registration`, `registration-service`, registrant `resend-confirmation`). Same transforms the callers used (`venue || ""`, `taxRate ? Number : null`, `logo → logoPath`). **Deliberately EXCLUDES `eventSlug`** (register passes the route param, which may be an event id; others pass `event.slug` — folding it in would silently change register) and the **price/discount/qrCode/attendanceMode/billing** fields (they diverge per caller + feed the finance-sensitive quote PDF, so callers still pass them). The `sendRegistrationConfirmation` param object is now the exported `RegistrationConfirmationParams` type in [src/lib/email.ts](src/lib/email.ts).
- `src/lib/agent/tools/contacts.ts` - contacts domain: `list_contacts`, `create_contact`, `update_contact` (email immutable).
- `src/lib/agent/tools/invoices.ts` - invoices domain: `list_invoices`, `create_invoice`, `send_invoice`, `update_invoice_status` (REFUNDED is DB-only, not Stripe).
- `src/lib/agent/tools/webinar.ts` - zoom + webinar + sponsors: `list_zoom_meetings`, `create_zoom_meeting`, `get_webinar_info`, `list_webinar_attendance`, `list_webinar_engagement`, `list_sponsors`, `upsert_sponsors`.
- `src/lib/agent/tools/communications.ts` - email + media: `send_bulk_email`, `list_email_templates`, `update_email_template`, `reset_email_template`, `list_scheduled_emails`, `cancel_scheduled_email`, `list_media`.
- `src/lib/agent/tools/promo-codes.ts` - promo codes (CRUD, soft-delete via `isActive: false`).
- `src/lib/agent/tools/dashboard.ts` - cross-cut reads: `get_event_dashboard`, `get_event_stats`, `search_event`.
- `src/lib/agent/mcp-server-builder.ts` - HTTP MCP registrations calling into `TOOL_EXECUTOR_MAP` via `runTool()`. Event-level tools go in `readTools`/`writeTools` arrays (auto-injects `eventId` + `getOrgIdSecure()` check). Top-level inline tools (`list_events`, `list_contacts`, `create_event`) don't take `eventId`
- `src/app/api/mcp/route.ts` - Streamable HTTP transport for MCP (POST/GET with `Mcp-Session-Id` session state, 30-min TTL); used by n8n, Claude Desktop via mcp-remote, and claude.ai web via OAuth. Accepts **both** `x-api-key`/`Authorization: Bearer <apiKey>` (backward compat) AND OAuth 2.1 Bearer access tokens via `validateOAuthAccessToken()`. On 401, emits `WWW-Authenticate: Bearer resource_metadata="..."` so spec-compliant clients discover the OAuth server automatically. Has `OPTIONS` handler for CORS preflight; every response wrapped with `withCors()` so browser-based clients (claude.ai web) can reach it
- `src/lib/mcp-oauth.ts` - OAuth 2.1 service lib (RFC 7591 DCR + RFC 6749 authorization code + refresh_token grants + RFC 7009 revocation + mandatory PKCE S256). Core functions: `hashToken`, `verifyPkce` (timing-safe), `validateOAuthAccessToken` (hot path, fire-and-forget `lastUsedAt` update), `issueAuthCode`, `exchangeAuthCode` (transactional code→token swap), `exchangeRefreshToken` (rotates refresh, revokes old row), `revokeToken`, `registerClient`, `getClient`, `verifyClientSecret`. Tokens stored SHA-256 hashed, never in plaintext
- `src/lib/mcp-cors.ts` - CORS helper used by every MCP + OAuth route. `handlePreflight()` for OPTIONS, `withCors()` to wrap responses. Allowed origins: `claude.ai`, `*.claude.ai`, `*.anthropic.com`, `console.anthropic.com`, plus localhost in dev
- `src/app/.well-known/oauth-protected-resource/route.ts` - RFC 9728 Protected Resource Metadata. Points claude.ai at our authorization server
- `src/app/.well-known/oauth-authorization-server/route.ts` - RFC 8414 Authorization Server Metadata. Advertises `/api/mcp/oauth/*` endpoints and `authorization_endpoint: /mcp-authorize`
- `src/app/api/mcp/oauth/register/route.ts` - RFC 7591 Dynamic Client Registration. Accepts any valid DCR request, stores `McpOAuthClient` row, returns `client_id` (+ `client_secret` if confidential). 10/hr/IP rate limit
- `src/app/api/mcp/oauth/authorize/decision/route.ts` - POST handler for the consent form. Re-validates server-side, issues auth code via `issueAuthCode()`, 302s back to the client's `redirect_uri` with `?code=...&state=...`. RBAC: only ADMIN/SUPER_ADMIN/ORGANIZER can grant
- `src/app/api/mcp/oauth/token/route.ts` - RFC 6749 token endpoint. Accepts both `application/x-www-form-urlencoded` and JSON. Handles `authorization_code` + `refresh_token` grants. 60/hr/client_id rate limit
- `src/app/api/mcp/oauth/revoke/route.ts` - RFC 7009 token revocation. Always 200 per spec (no enumeration)
- `src/app/mcp-authorize/page.tsx` - Server-component consent UI (outside `(dashboard)` route group so no sidebar). Validates OAuth params, checks NextAuth session (redirects to `/login?callbackUrl=...` if missing), enforces ADMIN/ORGANIZER-only RBAC, renders Approve/Deny form that POSTs to the decision route
- `src/app/api/cron/mcp-oauth-cleanup/route.ts` - Hourly cron (Bearer `$CRON_SECRET`) that deletes expired auth codes and tokens past a 7-day grace period

**MCP client caching caveat** — MCP clients (claude.ai web, Claude Desktop, n8n, etc.) cache the tool list at connection time. When this server adds or changes tools, **existing connected clients must disconnect and reconnect to see the changes**. Claude Desktop: fully quit and relaunch (Cmd+Q / Alt+F4 — window close isn't enough). claude.ai web: Settings → Integrations → disconnect the EA-SYS connector, then re-add. We bump `package.json` version (read into `serverInfo.version` by `mcp-server-builder.ts`) on every tool-changing deploy as a best-effort cache-invalidation hint, but client caching is spec-allowed behavior and can't be force-invalidated from the server side. Include this in user-facing release notes for any deploy that adds MCP tools.
- `src/app/(dashboard)/my-registration/page.tsx` - Registrant self-service portal (view/edit registrations, payment status)
- `src/app/api/registrant/registrations/route.ts` - Registrant self-edit API (GET list, PUT attendee details with ownership check)
- `src/app/(dashboard)/my-reviews/page.tsx` - Reviewer portal: lists all abstracts assigned to the current user across every event (union of event-pool + explicit per-abstract assignments), grouped by event, with PENDING / NEEDS_UPDATE / SUBMITTED submission status
- `src/app/api/my-reviews/route.ts` - Reviewer portal feed — union of `event.settings.reviewerUserIds` membership + `AbstractReviewer` rows, joins own submission row to compute submissionStatus
- `src/lib/abstract-review.ts` - Sprint B aggregation helper — `computeSubmissionAggregates(abstractId)`, `computeWeightedOverallScore(items)`, `readRequiredReviewCount(settings)`, `consolidateReviewNotes(submissions)`; single source of truth for abstract score rollups across dashboard + MCP
- `src/lib/abstract-notifications.ts` - `notifyAbstractStatusChange()` — branded speaker email with `escapeHtml()`-sanitized aggregated reviewNotes + admin notification; called from both the dashboard PUT route and the MCP `update_abstract_status` executor
- `src/app/api/events/[eventId]/abstracts/[abstractId]/reviewers/route.ts` - POST (assign, idempotent) + GET (list with submission status per reviewer)
- `src/app/api/events/[eventId]/abstracts/[abstractId]/reviewers/[userId]/route.ts` - DELETE (unassign — preserves any submission row via SET NULL cascade on `abstractReviewerId`)
- `src/app/api/events/[eventId]/abstracts/[abstractId]/submissions/route.ts` - GET list + aggregates; POST upserts the current user's submission (auth: event reviewer pool OR explicit assignment OR admin)
- `src/app/api/events/[eventId]/registrations/bulk-type/route.ts` - Bulk update registration type (PATCH, adjusts soldCounts + syncs attendee.registrationType)
- `src/lib/default-terms.ts` - Default registration terms & conditions HTML
- `src/components/speakers/speaker-detail-sheet.tsx` - Speaker detail slide-out sheet (used from speakers list for quick view); includes a compact **Registration** block showing the linked companion registration (#, status, payment, badge, entry-barcode, check-in, survey) from the speaker GET route's `sourceRegistration` relation
- `src/components/contacts/contact-detail-sheet.tsx` - Contact detail slide-out sheet with gradient header, 2-col layout, inline edit
- `src/components/org-theme.tsx` - Dynamic org theme provider (applies primaryColor from organization settings)
- `src/lib/org-context.ts` - Organization context for client-side org data access
- `src/lib/notifications.ts` - Notification helpers (`createNotification`, `notifyEventAdmins`); types: REGISTRATION, PAYMENT, ABSTRACT, REVIEW, CHECK_IN, SIGNUP
- `src/lib/csv-parser.ts` - RFC 4180 compliant CSV parsing (`parseCSV`, `parseCSVLine`, `parseCSVHeaders`, `getField`, `parseTags`); max 5000 rows
- `src/lib/contact-sync.ts` - Fire-and-forget sync of attendee/speaker/reviewer data to Contact store (`syncToContact`); non-blocking, failures only logged
- `src/lib/storage.ts` - File storage abstraction; `uploadMedia()` saves to `/uploads/media/{YYYY}/{MM}/`; `deleteMedia()` removes from storage + DB; three providers behind `STORAGE_PROVIDER`: `local` filesystem, `supabase`, and **`s3` (PRODUCTION since Sep 7, 2026: bucket `ea-sys-uploads`, ap-south-1, SSE-KMS CMK, versioned; keys are the stored path minus `/uploads/`, so the DB never changed; MAINT-002)**; 2MB limit with magic byte validation. **⚠ `deletePhoto()` must NOT be called directly by entity deletes** — photo paths are shared across rows; go through `deletePhotoIfUnreferenced()` (see next line, INC-004)
- `src/lib/photo-cleanup.ts` - `deletePhotoIfUnreferenced(url)` — the INC-004 guard (July 29, 2026): counts remaining references across Attendee + Speaker + Contact (the schema's three `photo` columns) and unlinks the file only at zero; never throws (a skipped unlink logs `photo-cleanup:still-referenced`; fail-safe — an orphan file is cheap, a destroyed shared file is data loss). Called by the speaker / registration / contact DELETE routes
- `src/lib/barcode.ts` - Code 128 rendering (`renderBarcodePng`, server-only — requires bwip-js) + QR rendering (`renderQrPng`, Aug 3 2026 — used for the DTCM compliance UUID, which is unscannable as Code 128 at badge width) + the entry-barcode serial-suffix pair (July 29, 2026): `entryBarcodeValue(qrCode, serialId)` → `{qrCode}-{serial padded 3}` encoded in every rendered barcode (badge/PNG/email) while the STORED qrCode stays bare, and `scannedEntryCodeCandidates(scanned)` → the lookup candidates so check-in accepts both forms (legacy + suffixed; DTCM values never stripped)
- `src/components/import/csv-import-dialog.tsx` - CSV import dialog with file upload, first-5-row preview, template download, import results; post-import "Send Registration Forms" button triggers bulk completion emails
- `src/components/bulk-tag-dialog.tsx` - Manage tags on selected registrations/speakers (add/remove/replace modes)
- `src/components/bulk-email-dialog.tsx` - Send emails to selected or all filtered registrations
- `src/app/globals.css` - Global styles and CSS variables

## Database Models

- **Organization** - Organization entity (currently single-org mode); includes `primaryColor` for dynamic org theming
- **User** - Users with roles (SUPER_ADMIN, ADMIN, ORGANIZER, REVIEWER, SUBMITTER, REGISTRANT); `emailSignature` (Text, HTML) is appended to outgoing speaker invitation/agreement emails sent by that user — edited from `/profile`
- **Event** - Events with status tracking; includes `eventType` (CONFERENCE/WEBINAR/HYBRID), `tag`, and `specialty` fields; `registrationWelcomeHtml` and `registrationTermsHtml` for public registration form content; `taxRate` (Decimal), `taxLabel`, and `bankDetails` for tax/payment configuration; `emailFromAddress` and `emailFromName` for per-event sender email; `badgeVerticalOffset` (Int) for badge print positioning; `speakerAgreementTemplate` (JSON `{ url, filename, uploadedAt, uploadedBy }`) is the pointer to an uploaded .docx mail-merge template used to generate per-speaker personalized agreement attachments. **`settings` JSON** holds feature-specific configs: `settings.webinar` (webinar auto-provision config), `settings.sponsors` (`SponsorEntry[]` with six tiers — no dedicated table, see `src/lib/webinar.ts` `readSponsors()` + `readWebinarSettings()` helpers)
- **TicketType** - Registration type configurations (displayed as "Registration Types" in UI); `ticketTypeId` is the single source of truth — `attendee.registrationType` is auto-synced; `virtualPrice` (Decimal?, nullable) is the flat price charged when a registrant picks VIRTUAL attendance on a HYBRID event (null ⇒ virtual uses the in-person `price`; pricing tiers apply to in-person only in v1); **`requiresDocument` / `documentRequired` / `documentLabel` / `documentInstructions`** are the per-type supporting-document policy (Aug 13, 2026) that replaced the `/resident|trainee/i` name match — the two booleans stay separate so "ask but do not block" remains expressible; see [supporting-document.ts](src/lib/supporting-document.ts). **`isFaculty` (Boolean, default false)** marks the auto-provisioned hidden "Faculty" type that backs speaker companion registrations — **hidden from public registration** (filtered out of the public ticket list + the register POST) and **excluded from delegate-focused counts/stats** via `EXCLUDE_FACULTY_WHERE` in [src/lib/faculty-filter.ts](src/lib/faculty-filter.ts) (operational surfaces — badge/check-in/survey/DTCM — deliberately keep faculty)
- **Registration** - Event registrations; `userId` (nullable FK) links to User for registrant self-service; `paymentStatus` includes `COMPLIMENTARY` for admin-set comp registrations and `INCLUSIVE` for sponsor-paid (requires `sponsorId`); `sponsorId` (nullable) references an entry in `Event.settings.sponsors[]` JSON — preserved on payment-status flips away from INCLUSIVE so the historical attribution survives a revert; `pricingTierId` (nullable FK to `PricingTier`) captures which sales window the registration falls under for finance reporting; `billingState` and `billingZipCode` for invoice/billing; `termsAcceptedAt` (DateTime) records when registrant accepted T&C; `refundedAmount` (Decimal, default 0) is the **running total refunded** (partial refunds accumulate; the reg stays PAID while `0 < refundedAmount < paidTotal`, flips to REFUNDED only when fully refunded — see the gated-partial-refund feature); `attendanceMode` (enum `AttendanceMode` IN_PERSON|VIRTUAL, default IN_PERSON) — only a choice on HYBRID events; VIRTUAL ⇒ no qrCode/badge/DTCM, uncapped (skips `soldCount`), priced via `TicketType.virtualPrice`, and the confirmation email swaps the barcode for a "joining instructions will be sent" message. **`createdSource` (enum `RegistrationCreatedSource`)** tags the entry path; **`SPEAKER_COMPANION`** marks the auto-created companion registration backing a Speaker (the "attendee facet" — comp, on the `isFaculty` ticket type, qrCode minted, badge "Faculty", no `soldCount`). A speaker's companion is linked via `Speaker.sourceRegistrationId` and gives the speaker badge/barcode/DTCM/check-in/survey through the normal machinery — see [src/lib/speaker-companion.ts](src/lib/speaker-companion.ts) + [docs/SPEAKER_AS_ATTENDEE_PLAN.md](docs/SPEAKER_AS_ATTENDEE_PLAN.md)
- **Attendee** - Attendee information; includes `title` (Title enum), `photo`, `city`, `state`, `zipCode`, `country`, `registrationType`, `dietaryReqs`, `memberId`, `studentId`, and `studentIdExpiry` (DateTime) fields; member/student fields required conditionally based on registration type name
- **Speaker** - Event speakers; includes `title` (Title enum), `photo`, `city`, `state`, `zipCode`, `country`, `specialty`, and `registrationType` fields; `specialty` is set during submitter registration and editable from dashboard; speakers can be added manually, via CSV import, or imported from the event's registrations. **A Speaker is a first-class, independent entity — it does NOT require a registration** (sponsor/society-suggested faculty are typically manually added and never register). `sourceRegistrationId` (nullable FK → Registration, `SetNull`) is an **optional** pointer set only on the import-registrations path; it lets the speaker's Activity timeline surface the linked registration's activity (pointed, not duplicated) and is **null** for independent speakers. Future "unify Speaker/Registration into one Person identity" is a roadmap item, constrained to `Speaker → Person?` (optional) so independent speakers never break.
- **MediaFile** - Organization media library; `id, organizationId, uploadedById, filename, url, mimeType, size, createdAt`; managed via `/api/media` routes (GET list, POST upload, DELETE); images stored in `/uploads/media/{YYYY}/{MM}/`
- **EventSession** - Schedule sessions; session times validated against event dates; supports session-level roles via `SessionSpeaker` and per-topic speakers via `SessionTopic`/`TopicSpeaker`; **`type` (enum `SessionType`, default SESSION)** — non-SESSION values (REGISTRATION/BREAK/LUNCH/NETWORKING) are **break items**: plain agenda time blocks that may never carry speakers/topics/abstract/Zoom (service-enforced `BREAK_ITEM_HAS_PROGRAM`), render as muted bands, have no public detail page, and are excluded from session counts
- **SessionTopic** - Topics within a session (title, sortOrder, duration, optional abstract link); speakers assigned per topic via `TopicSpeaker`
- **SessionSpeaker** - Session-level roles using `SessionRole` enum (SPEAKER, MODERATOR, CHAIRPERSON, PANELIST)
- **TopicSpeaker** - Join table for speakers per topic within a session
- **Track** - Session tracks
- **Abstract** - Paper submissions; includes `specialty` field; `managementToken` for public token-based access; `themeId` + **`subThemeId`** (both nullable) classify it — see AbstractSubTheme
- **AbstractTheme / AbstractSubTheme** - Per-event submission categories, two levels. A theme is required to submit ONLY when the event has themes; a sub-theme ONLY when the CHOSEN theme has sub-themes (conditional by necessity — an absolute rule would make submission impossible on an event with none, and event-wide keying would make adding sub-themes to one theme demand them on all). Rules live in [src/lib/abstract-theme-requirement.ts](src/lib/abstract-theme-requirement.ts), shared by the 3 submit forms + both write routes. Sub-themes ride nested inside `GET /abstract-themes` (no list endpoint) so both dropdowns read one source; `@@unique([themeId, name])`, theme→sub cascade, `Abstract.subThemeId` SET NULL with an application-level refuse-while-in-use guard
- **Hotel/RoomType/Accommodation** - Lodging management; `Accommodation` links to either `Registration` (via optional `registrationId @unique`) or `Speaker` (via optional `speakerId @unique`); atomic transactions prevent overbooking (`bookedRooms` counter); status flow: PENDING → CONFIRMED → CHECKED_IN → CHECKED_OUT (or CANCELLED at any point); price auto-calculated from nights × `pricePerNight`
- **Contact** - Contact store for organization; includes `title` (Title enum), `photo`, `city`, `state`, `zipCode`, `country`, `registrationType`, `memberId`, `studentId`, `studentIdExpiry`, and `associationName` fields; auto-synced from registrants/speakers via `syncToContact()` in `src/lib/contact-sync.ts`
- **Payment** - Stripe payment records linked to Registration; stores amount, currency, stripePaymentId (unique), stripeCustomerId, status, receiptUrl, metadata (JSON)
- **ZoomMeeting** - 1:1 with `EventSession`; `meetingType` enum (MEETING/WEBINAR/WEBINAR_SERIES), `joinUrl`, `startUrl`, `passcode`, `duration`. Live streaming fields: `liveStreamEnabled`, `streamKey`, `streamStatus`. **Recording** (Phase 4): `recordingUrl`, `recordingPassword`, `recordingDownloadUrl`, `recordingDuration`, `recordingFetchedAt`, `recordingStatus` (enum: NOT_REQUESTED/PENDING/AVAILABLE/FAILED/EXPIRED) + index. **Attendance** (Phase 5): `lastAttendanceSyncAt` + index for cron eligibility
- **ZoomAttendance** - Per-segment webinar attendance records pulled from Zoom's participant report; `zoomMeetingId`, `eventId`, `sessionId`, `registrationId?` (best-effort email match), `zoomParticipantId?`, `name`, `email?`, `joinTime`, `leaveTime?`, `durationSeconds`, `attentivenessScore?`. Unique key `(zoomMeetingId, zoomParticipantId, joinTime)` — a single attendee who leaves and rejoins shows up as multiple segments; upserts safe on re-sync
- **WebinarPoll** / **WebinarPollResponse** - Polls pulled from Zoom's `/report/webinars/{id}/polls`. Collapsed to **one logical poll per webinar** — Zoom's report returns a flat list of (participant, question, answer) tuples with no poll-id field, so we can't distinguish multiple polls. `WebinarPoll` has nullable `zoomPollId` + title + JSON question list; `WebinarPollResponse` has one row per participant submission with JSON answers map. Responses use replace-all strategy (deleteMany + createMany in a transaction) since Zoom doesn't give stable submission ids
- **WebinarQuestion** - Q&A entries pulled from `/report/webinars/{id}/qa`. `zoomMeetingId`, `askerName`, `askerEmail?`, `question`, `answer?`, `answeredByName?`, `askedAt`. Unique key `(zoomMeetingId, askerName, askedAt)` — rows with missing `create_time` are skipped and logged to avoid collisions
- **WebinarPresence** (June 23, 2026) - **Real-time** lobby/live presence of registered webinar attendees on our gated session page (heartbeat-driven), one row per `(sessionId, registrationId)` (`@@unique`); `eventId`, `firstJoinedAt`, `lastSeenAt`, `joinCount`, `phase` (`"lobby"|"joined"`). "Who's here now" = rows with `lastSeenAt` in the last 60s. Written by `POST .../sessions/[id]/presence` as an `upsert` (no transaction, escalate-lobby→joined-only). **This is OUR-page presence — distinct from the authoritative post-event `ZoomAttendance`.** Paired with a write-once `Registration.webinarFirstJoinedAt` (the durable "Joined" badge). Kept off the hot `Registration` row to avoid lock/vacuum churn
- **RsvpCampaign / RsvpItem / RsvpInvite / RsvpResponse** (July 8, 2026; generalized August 14, 2026, migration `20260814120000`). **`RsvpCampaign` = ONE RSVP** — a gala dinner, a set of parallel workshops, a site visit. An event runs several, each owning its own options AND its own guest list. Carries `name`, `description?`, `selectionMode` (`RsvpSelectionMode` SINGLE/MULTI), `allowGuests`, `collectDietary`, `isActive`, `sortOrder`. `RsvpItem` = one thing to say yes to (`campaignId`, `name`, `startsAt`, `location?`, `rsvpDeadline?`, `isActive`). `RsvpInvite` = one invited person **per campaign** (unique `token`, name/email, soft-ref `registrationId?`/`speakerId?`, `dietary?`, `status` PENDING/RESPONDED), **`@@unique([campaignId, inviteeEmail])`** — the load-bearing line: it was `([eventId, inviteeEmail])`, which meant a person held ONE invite per event, so a dinner list and a workshop list could not coexist. A person on two RSVPs holds **two invites and two links** (deliberate: separate deadlines, separate chase cycles, and one hub link would re-expose the dinner list). `RsvpResponse` = the per-item answer (`attending`, `guestCount`), `@@unique([inviteId, itemId])`. **⚠ The physical tables keep the old names via `@@map`** (`RsvpItem`→`RsvpDinner`, `RsvpResponse`→`RsvpDinnerResponse`, `startsAt`→`dinnerAt`, `itemId`→`dinnerId`) because an `ALTER TABLE ... RENAME` is not blue/green safe. See [docs/RSVP.md](docs/RSVP.md).
- **Employee / LeaveCode / AttendanceEntry / AttendanceRule / LeaveGrant / PublicHoliday** - The HR module (master silo only, `HR_MODULE_ENABLED`). Every table carries `organizationId` and an RLS policy in `prisma/rls/` from day one, because a flag flips in a deploy and a tenant-blind data shape cannot. Calendar columns are `@db.Date`, and in code a date is a **`YYYY-MM-DD` string, never a `Date`** (`getDay()` answers in the reader's timezone). **`AttendanceEntry` holds only the days that CARRY INFORMATION** — an ordinary working day has no row; the effective status is derived by [hr-effective-status.ts](src/hr/lib/hr-effective-status.ts), which is the ONE place precedence lives (not-employed → explicit entry → public holiday → weekend → standing rule → assumed P). **`AttendanceRule`** (scope ORG or EMPLOYEE, date range, code, reason) is a standing statement that **stores no days at all**: 252 of 386 imported work-from-home days were twelve company-wide dates and 120 more belonged to one permanently remote person, so 386 rows were holding 27 facts. Creating a rule writes nothing per person and deleting one removes nothing, which is what makes it reversible. A rule can carry any leave code, so **both balance paths expand rules** or a company-wide shutdown booked as AL would be invisible to payroll. `LeaveGrant` records what was carried into a leave year (`Employee.carryoverDays` is only the pre-go-live seed and is never overwritten, so last year's closing balance stays recomputable). Naming trap: **`-HD` means half DAY, `SL-H` means half PAY.**
- **ApiKey** - Organization API keys for MCP/external access; `keyHash` (SHA-256, unique), `prefix` (display), `expiresAt`, `isActive`; validated by `src/lib/api-key.ts`
- **AuditLog** - Action logging
- **SystemLog** - Pino log entries persisted to DB (level, module, message, timestamp); used by `/logs` viewer on Vercel

## API Patterns

All API routes follow this pattern:
```typescript
export async function GET/POST/PUT/DELETE(
  req: Request,
  { params }: { params: Promise<{ eventId: string }> }
) {
  const [session, { eventId }] = await Promise.all([auth(), params]);

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Block reviewers/submitters from write operations (POST/PUT/DELETE on non-abstract routes)
  const denied = denyReviewer(session);
  if (denied) return denied;

  // Verify event access
  const event = await db.event.findFirst({
    where: { id: eventId, organizationId: session.user.organizationId }
  });

  // ... handle request
}
```

**Important:** All POST/PUT/DELETE handlers (except abstract reviews) must call `denyReviewer(session)` from `@/lib/auth-guards`. This blocks both REVIEWER and SUBMITTER roles. Enforced across 29+ handlers in 20+ route files.

## Styling

- **Primary Color:** Cerulean Blue (#00aade)
- **Gradient:** Cerulean to Light Blue
- **Accent:** Amber/Yellow
- Uses oklch color format in CSS variables
- Gradient utilities: `bg-gradient-primary`, `btn-gradient`

## Environment Variables

```env
DATABASE_URL="postgresql://..."       # Pooled connection
DIRECT_URL="postgresql://..."         # Direct connection (migrations)
NEXTAUTH_SECRET="..."                 # JWT secret
NEXTAUTH_URL="http://localhost:3113"  # App URL (dev server runs on :3113 — see package.json "dev" script)
NEXT_PUBLIC_APP_URL="..."             # Public app URL
BREVO_API_KEY="..."                   # Email service (Brevo)
SENDGRID_API_KEY="..."                # Email service (SendGrid, alternative to Brevo)
EMAIL_PROVIDER="..."                  # Optional: "sendgrid" or "brevo" (auto-detected from API keys if omitted)
EMAIL_FROM="..."                      # Sender email
EMAIL_FROM_NAME="..."                 # Sender name
LOG_LEVEL="info"                      # debug, info, warn, error
STORAGE_PROVIDER="local"              # "local" (default) or "supabase" for media uploads
NEXT_PUBLIC_SENTRY_DSN="..."          # Sentry DSN for client error tracking
ANTHROPIC_API_KEY="..."               # Required for AI Agent feature
```

## Common Commands

```bash
npm run dev          # Start dev server (localhost:3113, on the LOCAL test DB)
npm run build        # Build for production
npm run lint         # Run ESLint
npx prisma generate  # Generate Prisma client
npm run db:refresh   # Reset the local test DB from the latest live DR dump
npm run uploads:refresh  # Pull the uploaded FILES those rows point at (photos/banners/certs)
npm run db:push      # Sync schema.prisma → LOCAL test DB (guarded; see the caveat below)
npx prisma studio    # Open Prisma Studio
npx tsc --noEmit     # Type check
```

## Local database & the `prisma migrate` rule

**We develop and test against a LOCAL Postgres DB, never prod.** The
`ea_sys_prod_local` container (`postgres:17`, `localhost:54322`, docker-compose)
holds a full copy of prod data seeded from the latest Singapore DR dump via
`npm run db:refresh`. `.env` / `.env.local` point at it, so every `npm run dev`,
test, and `tsx` script hits local. Full setup + guards:
[docs/LOCAL_DEV_DATABASE.md](docs/LOCAL_DEV_DATABASE.md). Reach prod only,
read-only, via `npm run prod:psql`.

**The dump carries rows, not files.** Uploads live on the box + the DR bucket,
never in git, so a freshly refreshed local DB renders broken images (org logo,
banners, speaker photos, certificate backgrounds) until you also run
`npm run uploads:refresh` ([scripts/dev-uploads-refresh.sh](scripts/dev-uploads-refresh.sh)
— read-only S3 sync into the gitignored `public/uploads/`, no `--delete`).
Counts + the what-is-NOT-in-the-bucket note: docs/LOCAL_DEV_DATABASE.md.

**RULE — never run `prisma migrate dev` or `prisma migrate reset` anywhere.**
Those are the [INC-002](docs/INCIDENTS.md) footgun — an interactive `migrate dev`
"reset the database?" prompt wiped all of prod on 2026-07-30. For local schema
work use `npm run db:migrate` (see the caveat below) or `npm run db:refresh`. The **only**
sanctioned `prisma migrate` invocation is `prisma migrate deploy` (non-destructive;
applies the committed `prisma/migrations/*` to prod), which the box/CI deploy path
runs and `npm run db:migrate` wraps. Do not confuse the two command families.
Migrations themselves stay additive + idempotent, and are never squashed/deleted
(owner, July 20).

**RULE — never pass a real database to `--shadow-database-url`.** A shadow
database is scratch space and Prisma **resets** it. On 2026-08-25 a
`prisma migrate diff --shadow-database-url "$DIRECT_URL"` emptied the whole local
prod copy, because locally `DIRECT_URL` and `DATABASE_URL` are the same database.
It is the same family as the `migrate dev` footgun with one difference that makes
it worse: the destructive behaviour is implied by a **noun**, not announced by a
flag like `--accept-data-loss`, so it does not look dangerous. To check a
migration against the schema, use `prisma validate` + apply the SQL to local with
`psql -v ON_ERROR_STOP=1 -f` and re-run for idempotency.

**Local work has an undo: `npm run db:snapshot` / `npm run db:restore`**
([db-snapshot.sh](scripts/db-snapshot.sh) / [db-restore.sh](scripts/db-restore.sh),
Aug 26 2026). `pg_dump -Fc` into the gitignored `.local-snapshots/`, newest 10
kept. `db:push` takes one automatically and **fails closed** if it cannot; restore
snapshots the current state first, so neither script can lose data. Both address
the container **by name and never read a URL**, so unlike a URL-driven script they
cannot be aimed at prod — pinned by a source assertion. `db:reset` is now refused
outright (it runs the forbidden `migrate reset`); data-loss flags need
`LOCAL_DATA_LOSS_OK=1`. The point is a seatbelt rather than a longer list of
forbidden commands: a snapshot covers the footguns nobody has thought of yet,
which is exactly the class the shadow-database one fell into.

**CAVEAT — `npm run db:push` cannot succeed against the local DB, and this is
structural** (found Aug 26 2026 while verifying the snapshot work). Migration
`20260602100000` created `CertificateIssueRunItem`'s two recipient uniques as
**PARTIAL** indexes (`WHERE "registrationId" IS NOT NULL`), which Prisma cannot
represent, so `schema.prisma` declares plain `@@unique`. The July-22 chain-sync
migration swaps them partial→full **only on the fresh-DB path** and deliberately
leaves prod on the partial pair. The local DB is a restore of a prod dump, so it
has the partial pair too, and every `db:push` tries to create the full index and
dies on the name collision. Nothing is wrong with your schema edit. Use the
documented flow instead: hand-author the migration SQL (or `migrate dev
--create-only`, which writes the file and never touches a database), then
`npm run db:migrate`. **Consequence worth knowing for the platform instance:**
it will be built from the chain, so it gets the FULL indexes while master keeps
the PARTIAL ones. Functionally identical (Postgres treats NULLs as distinct in a
composite unique), but the two databases genuinely differ, and `db:push` will
behave differently on each.

## Rate Limits

Every write endpoint that calls `checkRateLimit` returns HTTP `429` (or a tool-level error with `code: "RATE_LIMITED"` inside the MCP JSON-RPC envelope) with:
- `retryAfterSeconds` — seconds until the window resets
- `limit` — the ceiling for the window
- `windowSeconds` — length of the window
- `Retry-After` header on HTTP responses (per RFC 9110)

Clients (including AI agents) should parse `retryAfterSeconds` and back off. Do NOT sleep a fixed 30s — use the returned value.

| Endpoint / bucket | Limit | Window |
|---|---|---|
| `/api/mcp` (per API key / OAuth token) | 100 | 1 hr |
| `/api/mcp/oauth/token` (per client_id) | 60 | 1 hr |
| `/api/mcp/oauth/register` (per IP) | 10 | 1 hr |
| `send_bulk_email` MCP tool (per event) | 10 | 1 hr |
| `research_sponsor` MCP tool (per user+event) | 30 | 1 hr |
| `speaker-agreement-template` upload (per user) | 10 | 1 hr |
| Public register — burst (per IP) | 15 | 60 s |
| Public register — sustained (per IP) | 100 | 15 min |
| Public register — per email address | 10 | 15 min |
| Public checkout (per IP) | 15 | 60 s |
| Public register preflight `check-email` (per IP) | 200 | 1 hr |
| Public `zoom-join` (per IP) | 60 | 1 hr |
| Mobile login/refresh (per IP) | 10 | 5 min |

Thresholds are best-effort; in-memory store means limits reset on EC2/Docker restart. For stricter SLAs migrate to Redis (Vercel KV / Upstash) — the `checkRateLimit` interface is store-agnostic.

## Role-Based Access Control (RBAC)

> The per-role matrix verified against the code and pinned by test is [docs/ROLES_AND_PERMISSIONS.md](docs/ROLES_AND_PERMISSIONS.md) (Sep 21, 2026). The prose below is each role's history and reasoning.

### Roles
- **SUPER_ADMIN / ADMIN** - Full access to all features (org-bound)
- **ORGANIZER** - Full control of every event in the org (org-wide: `buildEventAccessWhere` scopes it by organisation, never by assignment; older docs said "assigned events only"); no organisation administration
- **MEMBER** - Org-bound **read-only viewer**. Same event scope as ORGANIZER (sees all org events) but **every** write is blocked (`denyReviewer()` includes MEMBER → all non-abstract POST/PUT/DELETE return 403) — EXCEPT the registration-desk opt-ins (`REGISTRATION_DESK_ALLOW` includes MEMBER: add registration, check-in, badge, record payment). **⚠ Doc-drift corrected July 10, 2026 (payments review L3): MEMBER has been finance-CAPABLE since the June 17 'desk staff record payments' decision** — `FINANCE_ROLES` in [src/lib/finance-visibility.ts](src/lib/finance-visibility.ts) is `SUPER_ADMIN/ADMIN/ORGANIZER/MEMBER/ONSITE` (fails closed for unknown roles), so MEMBER SEES money and `redactFinancialFields()`/`denyFinance()` no longer fire for it. The historical description below reflects the pre-June-17 model: `denyFinance()` 403s MEMBER on invoice list/detail/PDF + quote PDF GET routes; the registration-detail / tickets / event GET APIs run `redactFinancialFields()` for MEMBER (strips amounts, invoices, billing, bank/tax, prices — **keeps `paymentStatus`**, which is operational not financial); the agent refuses `FINANCE_ONLY_AGENT_TOOLS` (`list_invoices`, `list_unpaid_registrations`) for MEMBER and redacts financial fields from mixed tool results; the registration detail-sheet hides the Billing & Payments tab and the Tickets page renders `—` for masked prices. **Can use the AI Agent in read-only mode** — the route allows MEMBER but `isReadOnlyTool()` refuses anything not matching `list_`/`get_`/`search_` (fails closed). **⚠ Doc-drift corrected Aug 14, 2026 (owner): MEMBER is INTERNAL STAFF** — org employees who need operational visibility without edit rights. The previous description ("leadership / auditors / sponsor-side stakeholders") was wrong and had a measurable cost: a security reviewer read it, reasoned from "external sponsor-side observer", and produced a trust model exactly backwards, because **ONSITE is the less-trusted population — temp staff, contractors and vendors** (assignment-gated per event), while MEMBER is internal but org-wide in reach. Both dimensions matter and neither dominates; see [supporting-document-visibility.ts](src/lib/supporting-document-visibility.ts), which excludes both for that reason. Invited via Settings → Users like ADMIN/ORGANIZER. Amber badge in the UI.
- **REVIEWER** - Abstracts-only access to assigned events (org-independent, scoped by `event.settings.reviewerUserIds`)
- **SUBMITTER** - Abstracts-only access to own submissions (org-independent, scoped by `Speaker.userId`)
- **REGISTRANT** - Self-service access to own registrations only (org-independent **unless internal-domain — see below**, scoped by `Registration.userId`); can edit personal details, view payment status, make payments via Stripe; no dashboard/events access
- **CRM_USER** - Org-bound **sales-team role, CONFINED to the CRM** (sponsorship pipeline). Added July 15, 2026 (additive enum migration `20260715070000_add_crm_user_role`). Can **fully work the CRM** — own deals, companies, CRM contacts, tasks, notes, reports, CSV export — and **sees deal values** (`canViewDealValues` includes it), but is walled off from everything else: no events, registrations, speakers, invoices, or settings. **NOT in `FINANCE_ROLES`** — it sees CRM *deal* money, not event invoices/registration payments (different money; the CRM has its own visibility predicates in [src/crm/lib/crm-roles.ts](src/crm/lib/crm-roles.ts) — `canViewCrm`/`canOwnDeals`/`canViewDealValues`). Enforced in depth: (1) **Event access** — [buildEventAccessWhere](src/lib/event-access.ts) returns `{ id: { in: [] } }` (zero events); the CRM's deal/report event picker uses the name-only `GET /api/crm/events-lite` instead. (2) **API** — in `denyReviewer`'s restricted set (blocked from all non-CRM writes); the `/api/crm/*` routes gate via their own `requireCrmWrite` → `canOwnDeals`. It IS in `canViewContacts` (owner decision) so it can search the event contact store to link a rep to their registration. (3) **Middleware** ([src/proxy.ts](src/proxy.ts)) — redirects it to `/crm` from every non-CRM dashboard path. (4) **UI** — sidebar shows only the CRM entry; header "CRM User" badge (green). Org-bound team member (`TEAM_ROLES`), invited from **Settings → Users**.
- **ONSITE** - Org-bound **registration-desk staff**, scoped **PER EVENT** (per-event model July 7, 2026; role added June 16, 2026). A temp desk worker is assigned to specific events and sees/acts on **only those events** — NOT every event in the org. Assignment lives in **`Event.settings.onsiteUserIds`** (JSON array, mirroring `reviewerUserIds`), managed from the **Settings → Onsite Staff** tab (create a temp account + assign to event(s), remove-from-event, delete account; one temp can span multiple events). Can ONLY: **add a registration**, **check attendees in**, **view the registrations list**, and **print badges** — for assigned events. **Undo (July 11, 2026, `706ba17`):** the desk can reverse a mistaken check-in via `DELETE .../check-in` → `undoCheckIn()` in [check-in.ts](src/lib/check-in.ts), which clears status + `checkedInAt` together (audited `CHECK_IN_UNDO`, no seat change). An 'Undo Check-in' button appears on the registration detail sheet when CHECKED_IN. **NB — do NOT 'undo' by hand-flipping status:** that leaves `checkedInAt` set and `checkInGate` then refuses the attendee forever with ALREADY_CHECKED_IN. **ONSITE is finance-CAPABLE** (`canViewFinance("ONSITE")` is true — `FINANCE_ROLES` includes it since the June 17 "desk staff record payments" decision), so it sees payment amounts for its assigned events (this is why the cross-event gap below also leaked payment data). Everything else is blocked. Enforced in depth: (1) **Event visibility** — [buildEventAccessWhere](src/lib/event-access.ts) ONSITE branch scopes to `settings.onsiteUserIds` (org-bound AND assigned); unassigned ⇒ zero events. (2) **API** — ONSITE is in `denyReviewer`'s restricted set; the create-registration, check-in (POST+PUT), badge-print, and payments routes opt it back in via `denyReviewer(session, { allow: REGISTRATION_DESK_ALLOW })` **AND** route their event lookup through `buildEventAccessWhere`, so an ONSITE user assigned to Event A gets a **404** on Event B's list/create/edit/check-in/badge. This is the [security fix](__tests__/api/onsite-cross-event-isolation.test.ts) for the adversarial-review BLOCKER — before it, those 5 desk routes org-scoped only, so ONSITE could operate on any event in the org. The other 27 write routes block ONSITE entirely. (3) **Middleware** ([src/proxy.ts](src/proxy.ts)) — confines ONSITE to `/events` (list, now assignment-scoped) + an event's `/registrations*` + `/check-in*` paths; the API layer is the authoritative cross-event gate (middleware can't read settings at the Edge). (4) **UI** — sidebar = Events + the event's Registrations + Check-In; header "Onsite Staff" badge; registrations list keeps Add/Print Badge/Export, hides bulk/import/share; detail sheet keeps Check In + Print Badge, hides Edit/Delete/Send Email/Download Quote. Invited from **Settings → Onsite Staff** (org admins); cyan badge. Migration `20260616120000_add_onsite_role` (additive enum). Per-event scoping is settings-JSON only (no migration).

- **HR_USER** - Org-bound **HR role, CONFINED to the HR module** (attendance + UAE leave). Added August 27, 2026 (additive enum migration `20260827120000_add_hr_user_role`). Modeled directly on CRM_USER: it can fully work HR — employees, attendance, standing rules, leave balances, holidays, leave codes — and sees **nothing else**: no events, registrations, speakers, invoices, contacts or settings. **The module itself is gated by `HR_MODULE_ENABLED`** ([module-flags.ts](src/lib/module-flags.ts)), master silo only; with the flag unset the routes 404 for everyone including this role. Enforced in depth: (1) **Event access** — [buildEventAccessWhere](src/lib/event-access.ts) returns `{ id: { in: [] } }` (zero events). (2) **API** — in `denyReviewer`'s `RESTRICTED_WRITE_ROLES` (blocked from every non-HR write); the `/api/hr/*` routes gate via their own `denyNonHr` → `canViewHr`/`canWriteHr` in [hr-roles.ts](src/hr/lib/hr-roles.ts), which **refuses API keys** (HR is a per-person surface, and elsewhere a key is admin-equivalent). (3) **Middleware** ([src/proxy.ts](src/proxy.ts)) — confines it to `/hr`. (4) **UI** — sidebar shows only the HR entry. Org-bound team member (`TEAM_ROLES`), invited from **Settings → Users**. **The expensive part of adding it was the sweep, not the enum value**: `RESTRICTED_WRITE_ROLES` is the ONE deny-list among the role predicates, so a role absent from it can write to every non-HR route, while every other predicate (`FINANCE_ROLES`, `BARCODE_ROLES`, `canViewContacts`, login-visibility, registration-export) is an allow-list that excludes a new role for free. **Note the population:** HR holds colleagues' sick-leave records, which is health-adjacent personal data about named employees — see [docs/HR_MODULE_PLAN.md](docs/HR_MODULE_PLAN.md) §10.
- **WEBINARS** - Org-bound **webinar team** (added August 4, 2026; owner spec: "ONSITE role + webinar full control, not organizer"). **TWO-TIER access** (tier 2 widened Aug 10, 2026 — see below): **(1)** ALL of the org's **WEBINAR-type events** — **full organizer-grade control**, automatically (no assignment): create webinar events (the events POST hard-refuses any other type with 403 `WEBINAR_ONLY` — no silent coercion), registrations (incl. delete/bulk/imports), communications (bulk email, schedules, templates, previews, email activity/logs), the whole Webinar Console, sessions/agenda/tracks/Zoom, speakers, registration types/tiers, media, sponsors, survey, content + event settings (event PUT). **(2)** Non-webinar events — **MEMBER parity: it sees EVERY event in the org and holds the registration desk on all of them** (view the list, add a registration, check in, print badges, record payments). **Aug 10, 2026 (owner: "they are internal users but they see limited data") this replaced the old per-event `Event.settings.onsiteUserIds` assignment**, which no longer affects this role at all — the Onsite Staff tab still accepts WEBINARS accounts (harmless, now redundant; ONSITE still needs it). The change cost one line because the two roles' write guards were ALREADY identical — both in `RESTRICTED_WRITE_ROLES`, both in `REGISTRATION_DESK_ALLOW`, both in `FINANCE_ROLES` — so event scope was the only thing separating them. **Not yet at full MEMBER parity:** the ~59 event GETs (agenda/sessions, speakers, tickets, analytics) still resolve on the manage surface, so a conference's agenda 404s; widening them is the deferred read sweep in ROADMAP §"WEBINARS MEMBER-parity read sweep". **First one moved (Sep 8, 2026):** the registrations `tags` GET now resolves on the desk surface, because the list it feeds already did and a WEBINARS user on a conference got the rows with a 404 behind them (eight prod warnings in one minute while an organiser was temporarily on that role); pinned with the real builder in `event-tags-desk-surface.test.ts`. **Blocked:** org-level surfaces (org settings/users write, API keys, CRM, contacts — `canViewContacts` false, sign-in activity), refunds/credit-notes/cancel (money movement stays ADMIN/ORGANIZER), certificates (v1), reimbursements, AI agent, event DELETE, clone, promo codes (webinar-hidden module anyway). **Predicates:** IN `FINANCE_ROLES` (desk records payments — ONSITE parity), `BARCODE_ROLES` (badge printing), `ZOOM_HOST_ROLES` (**holds Zoom host credentials — the producer role**), registration-export; in `TEAM_ROLES` (Settings → Users invite, "Webinars" label, violet badge). **Enforcement architecture (fail-closed):** WEBINARS is in `denyReviewer`'s restricted set — every capability is an explicit opt-in via `denyReviewer(session, { allow: WEBINAR_STAFF_ALLOW })` **ALWAYS paired with** a `buildEventAccessWhere` event lookup, whose WEBINARS branch resolves ONLY `{ organizationId, eventType: "WEBINAR" }` (manage surface, the default) — so a route that opts the role in but keeps a hand-rolled org-scoped lookup would fail open on conferences: **never do that** (the invariant is documented on `WEBINAR_STAFF_ALLOW` in [auth-guards.ts](src/lib/auth-guards.ts)). Desk routes (registrations list/create/detail/check-in/badges/payments/activity + the events list/detail GET) pass `buildEventAccessWhere(..., { surface: "desk" })`, which since Aug 10, 2026 widens ONLY this role's resolution to **every event in the org**. **The manage surface deliberately did NOT follow, and must not:** ~55 route files sit behind `WEBINAR_STAFF_ALLOW`, so widening the default would open all of them on conferences in a single edit — pinned by a mutation-verified test. A missed route = 403/404 (feature gap), never a leak. ~45 route files swept; scheduled-email row mutations bind through `event: buildEventAccessWhere(...)` relation wheres; speakers POST carries a route-level access pre-check because the service's internal event check is org-only. Middleware confines the UI to `/events*` (incl. `/events/new`) — `/settings`, `/logs`, `/contacts`, `/crm`, `/admin`, `/dashboard` redirect to `/events`; sidebar is two-tier (webinar event → full module set through `webinarModuleFilter`; conference → Registrations + Check-In pair; loading → blank). 16-test matrix in [webinars-role-isolation.test.ts](__tests__/api/webinars-role-isolation.test.ts) (two-tier where shapes, allow-list matrix, predicate truth table, WEBINAR_ONLY create gate). **Adversarial review same day (0 BLOCKER / 2 HIGH / 3 MED / 5 LOW) — all HIGHs+MEDs + L-4 shipped in-band:** H-1 the **org-wide invoice ledger** (`/api/invoices` + export) explicitly refuses WEBINARS (finance-capable ≠ org-ledger access; `/invoices` added to the proxy block list; also fixed the routes' stale "MEMBER/ONSITE barred" doc-drift); H-2 the scheduled-email PATCH/DELETE/retry **primary `updateMany` writes** now bind through `event: buildEventAccessWhere(...)` (they were org-scoped with the builder only on the fallback read — the exact invariant-violation class); M-1 `/api/email-logs` + body are **desk-confined** for WEBINARS and refuse CONTACT/USER/OTHER entity types (the CONTACT allowance was a side-door around its contacts exclusion); M-2 the event PUT refuses an `eventType` flip for WEBINARS (two-step bypass of the create gate); M-3 the registrations page + detail sheet render the **desk-limited UI** for WEBINARS on non-webinar events (`isDeskOperator` widened); **L-4 (owner-acked): registration DELETE reverted to ADMIN/ORGANIZER** — no refund powers ⇒ no row deletion, even on its own webinars. +7 route-level pins in [webinars-role-regression-matrix.test.ts](__tests__/api/webinars-role-regression-matrix.test.ts) (the H-2 class is now a failing test, not a review find). Deferred L-1/L-2/L-5 + a `WEBINAR_STAFF_ALLOW`⇒`buildEventAccessWhere` CI grep-gate in ROADMAP §"WEBINARS role review". Migration `20260803190000_add_webinars_role` (additive enum).

### Architecture: Org-bound vs. Org-independent Users
- **Team members** (ADMIN, ORGANIZER, MEMBER, **ONSITE**) have a required `organizationId` and are scoped to their organization. MEMBER is the read-only variant; ONSITE is the registration-desk variant. The "team members" set is `TEAM_ROLES` in [src/lib/auth-guards.ts](src/lib/auth-guards.ts) (`isTeamRole()`); the Settings → Users list filters to it, so org-bound registrants (below) don't appear as staff.
- **Reviewers**, **Submitters**, and **Registrants** have `organizationId: null` — they are independent entities scoped only by event assignment
- This allows one reviewer to review events across multiple organizations; submitters self-register per event; registrants create accounts during public registration
- `User.organizationId` is nullable in the schema; non-null assertion (`!`) is used in admin-only code paths
- **Internal-domain rule (June 16, 2026):** registering with an **internal-domain** email ([src/lib/internal-domains.ts](src/lib/internal-domains.ts)) gets the org attached, even as a REGISTRANT. **Two tiers:** **(a) VERIFIED** — `meetingmindsdubai.com` (real mailboxes): created **org-null** at registration + sent a **verify-email link** ([src/lib/email-verification.ts](src/lib/email-verification.ts) → [/verify-email](src/app/verify-email/page.tsx) → `POST /api/auth/verify-email`); clicking it sets `User.emailVerified` **and** attaches the org. Until then they're a normal external registrant (registration works; verification only unlocks internal/org status). **(b) TRUSTED** — `meetingmindsexperts.com` / `meetingmindsgroup.com` (temp accounts, addresses may not be real mailboxes): org attached **immediately, no verification**; admins delete them from Settings → Users when done. An admin **invite/promote** is a trusted human action and works regardless of verification — the gate only governs the *automatic* org-attach at registration. So an internal person is org-bound from the start and can later be **promoted** to a team role (`POST /api/organization/users` updates an existing org-independent — or org-bound non-team — account's org + role in place, keeping its password + registrations) instead of being blocked by the global email-uniqueness check. A *different* org's user is still refused. `/my-registration` is session-scoped (not role-gated), so a promoted staff member keeps access to their own registrations.

### Restricted Role Enforcement (3-layer, applies to REVIEWER, SUBMITTER, and REGISTRANT)
1. **API Layer:** `denyReviewer(session)` guard on all POST/PUT/DELETE handlers (except abstract operations and `/api/registrant/registrations` self-edit) returns 403 for REVIEWER, SUBMITTER, and REGISTRANT
2. **Middleware Layer:** `src/proxy.ts` (Next.js middleware; renamed from `middleware.ts` in Next 16.1) redirects REVIEWER/SUBMITTER from non-abstract event routes; REGISTRANT is redirected to `/my-registration` from all dashboard routes
3. **UI Layer:** Write-action buttons hidden; sidebar hidden for REGISTRANT; header shows "Reviewer Portal", "Submitter Portal", or "Registration Portal"

### Event Scoping
- `buildEventAccessWhere(session.user)` from `src/lib/event-access.ts` scopes event queries by role
- Admins/Organizers see all org events
- Reviewers see only events where their userId is in `event.settings.reviewerUserIds` (no org filter)
- **ONSITE** sees only events where their userId is in `event.settings.onsiteUserIds` (org-bound AND assigned — the per-event registration-desk model). Every ONSITE-reachable desk route (registrations list/create, detail PUT, check-in, badge, payments) routes its event lookup through `buildEventAccessWhere`, so it's assignment-gated, not just org-gated.
- Submitters see only events where they have a linked Speaker record (`speakers.some.userId`)
- Registrants see only events where they have a linked Registration record (`registrations.some.userId`)

### Reviewer Assignment
- Reviewers are assigned per-event via `Event.settings.reviewerUserIds` (JSON array of User IDs)
- `Speaker.userId` (nullable FK) links speakers to User accounts
- The Reviewers page lets admins add reviewers via two methods: pick from speakers, or invite by email
- New reviewer accounts are created with `organizationId: null` and sent an invitation email

### Submitter Registration
- Submitters self-register via `/e/[slug]/register` (public page, no auth)
- Registration creates User (role=SUBMITTER, organizationId=null) + finds-or-creates Speaker linked to event
- After login, submitters see only the event they registered for, with access to Abstracts only
- Submitters can submit abstracts (auto-linked to their speaker record), edit own abstracts (DRAFT/SUBMITTED/REVISION_REQUESTED), and view review feedback

### Registrant Registration
- Registrants create an account during public registration at `/e/[slug]/register/[category]` (2-step form: email+password → personal details)
- Registration creates User (role=REGISTRANT, organizationId=null) and links Registration via `Registration.userId`
- Existing unlinked registrations by the same email are auto-linked to the new user account
- After login, registrants see only `/my-registration` portal with their registration details, edit form, and payment status
- If a registrant later registers as a submitter, their role can upgrade from REGISTRANT to SUBMITTER
- Self-edit API at `/api/registrant/registrations` (GET for list, PUT for attendee detail updates with ownership verification)

## Code Conventions

0. **After every code change:** Run `npm run lint` and `npx tsc --noEmit`. Fix ALL errors and warnings before considering a task complete. Do not skip this step.

1. **API Routes:** Use Promise.all for parallel queries, validate with Zod
2. **Error Handling:** Use try/catch with apiLogger for errors
3. **Auth:** All dashboard routes require authentication via `auth()`
4. **Auth Guards:** All write API routes must call `denyReviewer(session)` from `@/lib/auth-guards`
5. **Forms:** Use react-hook-form with Zod validation
6. **Toasts:** Use sonner for notifications
7. **State:** Use React Query for server state, local useState for UI state
8. **Data Fetching:** Use hooks from `src/hooks/use-api.ts` for client-side data
9. **Guard clauses, not nested `if`s:** Prefer early returns — flatten `if (cond) { …body… }` into `if (!cond) return; …body…` so the happy path reads un-indented. Keep to ~one level of nesting; when a branch grows its own sub-branches, extract it into its own function (e.g. the cert worker's reissue branch → `processReissueRun`). Prefer a small guard-clause helper over a nested ternary (e.g. `cohortTagFilter`). JSX conditional rendering (`cond ? <A/> : <B/>`) is exempt.
10. **Log every failure path:** No silent `400/403/404/409/429/500`s or `.catch(()=>{})`. Every `safeParse`→400 logs the field errors; every rejection returned as an error-value is logged at the route boundary with its code. Errors log at `error`, business rejections at `warn`, successes at `info`. Logging is a hard requirement.

## Performance Optimization

### API Routes
- **Parallel queries:** Use `Promise.all()` for independent database calls
  ```typescript
  const [session, event, tickets] = await Promise.all([
    auth(),
    db.event.findFirst({ where: { id } }),
    db.ticketType.findMany({ where: { eventId: id } })
  ]);
  ```
- **Select only needed fields:** Use Prisma `select` instead of returning full objects
  ```typescript
  db.event.findFirst({
    where: { id },
    select: { id: true, name: true, status: true }  // Not the entire record
  });
  ```
- **Cache headers:** Add appropriate cache headers for public endpoints
  ```typescript
  response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
  ```

### Database
- Use indexes for frequently queried fields (already defined in schema)
- Composite indexes on `Registration` for common query patterns: `[eventId, status]` and `[eventId, ticketTypeId]`
- Avoid N+1 queries - use `include` for related data in single query
- Use `findFirst` instead of `findUnique` when filtering by non-unique fields
- Don't add explicit `@@index` on fields that already have `@unique` (unique creates an implicit index)
- **Event existence checks:** Always use `select: { id: true }` when the event lookup only validates access (don't fetch full event objects)
- **Parallelize independent queries:** Event lookup + entity lookup should use `Promise.all()` when they don't depend on each other

### Server Pages
- **Parallelize `params` + `auth()`:** Always use `Promise.all([params, auth()])` in server page functions
- **Parallelize independent DB queries:** When a page needs both an event and related data (e.g., speakers), fetch them in parallel with `Promise.all` after auth
- **Use `select` over `include`:** Server pages should use Prisma `select` to fetch only columns rendered in the template, not full objects

### Frontend
- Use `Suspense` boundaries for loading states
- Lazy load heavy components with `dynamic()` imports
- Minimize client-side state; prefer server components where possible

### Build & Module Optimization

The project uses several optimizations to reduce module load times:

**Next.js Config** (`next.config.ts`):
- `optimizePackageImports` - Tree-shakes large packages like `lucide-react` (44MB), Radix UI, and `@tiptap/*`
- `serverExternalPackages` - Excludes `pdfkit` from bundling (Turbopack rewrites `__dirname` to `/ROOT/`, breaking font file resolution)
- `transpilePackages` - Better tree-shaking for `@getbrevo/brevo`
- `turbopack` - Faster builds with Next.js 16's default bundler

**Lazy Initialization Patterns**:
- **Brevo SDK** (`src/lib/email.ts`): Uses named imports instead of wildcard (`import * as brevo`), API client lazy-initialized on first use
  ```typescript
  // Good - named imports, lazy init
  import { TransactionalEmailsApi, SendSmtpEmail } from "@getbrevo/brevo";
  let apiInstance: TransactionalEmailsApi | null = null;
  function getApiInstance() { /* create on first call */ }

  // Bad - loads entire SDK at module load
  import * as brevo from "@getbrevo/brevo";
  const apiInstance = new brevo.TransactionalEmailsApi();
  ```
- **Logger** (`src/lib/logger.ts`): No synchronous file system operations at module load; pino transports handle directory creation

**Prisma Client** (`src/lib/db.ts`):
- Singleton pattern with `globalThis` caching in development only (prevents HMR connection leaks)
- In production (Vercel), each serverless function gets its own instance — no global caching needed

**Middleware** (`src/proxy.ts`, renamed from `middleware.ts` in Next 16.1):
- Matcher scoped to only dashboard routes (`/events/*`, `/dashboard/*`, `/settings/*`)
- Redirects REVIEWER and SUBMITTER from non-abstract event routes to `/events/[eventId]/abstracts`
- Public routes (`/e/*`), API routes (`/api/*`), auth pages, `/uploads/*`, and static assets skip middleware entirely

**Header Component** (`src/components/layout/header.tsx`):
- Uses React Query hooks (`useEvents`, `useEvent`) instead of manual `useEffect` fetching
- Data cached across navigation, preventing duplicate API calls

### React Query (Client-Side Caching)
Dashboard pages use React Query for client-side data caching. This provides:
- **Instant navigation:** Cached data displays immediately when returning to pages
- **Background refresh:** Data updates silently while showing cached content
- **Optimistic UI:** Mutations update cache immediately for responsive feel

**Configuration** (`src/components/providers.tsx`):
- `staleTime: 5 minutes` - Data considered fresh for 5 minutes
- `gcTime: 30 minutes` - Unused cache kept for 30 minutes
- `refetchOnWindowFocus: true` - Refresh when tab becomes active

**Using React Query hooks** (`src/hooks/use-api.ts`):
```typescript
// Fetching data (useTickets fetches registration types)
const { data: regTypes = [], isLoading, isFetching } = useTickets(eventId);

// Mutations with cache invalidation
const createRegType = useCreateTicket(eventId);
await createRegType.mutateAsync(formData);

// Manual cache invalidation
const queryClient = useQueryClient();
queryClient.invalidateQueries({ queryKey: queryKeys.tickets(eventId) });
```

**Available hooks:**
- `useTickets`, `useCreateTicket`, `useUpdateTicket`, `useDeleteTicket` (for registration types)
- `useRegistrations`, `useSpeakers`, `useImportRegistrationsToSpeakers`, `useSessions`, `useTracks`
- `useAbstracts`, `useHotels`, `useAccommodations`
- `useEventMedia`, `useUploadEventMedia`, `useDeleteEventMedia` (event-scoped media library)
- `useReviewers`, `useAddReviewer`, `useRemoveReviewer`
- `useEvents`, `useEvent`
- `useMedia`, `useUploadMedia`, `useDeleteMedia` (media library)
- `useSendCompletionEmails` (bulk send completion tokens to CSV-imported registrants)

## Recent Features

The last few things that landed, as one-liners — enough to orient, no more. **The
full history is in [CHANGELOG.md](CHANGELOG.md)**, newest first; read it when a task
actually touches that history, not by default.

- **QuickBooks connector** (Sep 22) — connects and READS only, never posts; the Intuit app is per organisation and entered in the UI, so the `QUICKBOOKS_*` env vars are retired and read nowhere
- **Event Agent, Phases 0–4** (Sep 21–22) — org-level door at `/agent` with the event optional, one tool schema shared by both doors, an approval card on seven irreversible tools, every in-app run stored
- **Budget & Procurement** (Sep 14–17) — LIVE in production: budgets, spend requests, purchase orders, approvals with reminders and escalation, revenue and margin
- **One permissions page** (Sep 21) — [docs/ROLES_AND_PERMISSIONS.md](docs/ROLES_AND_PERMISSIONS.md) is the per-role matrix, pinned by a test that fails the day a predicate drifts
- **Certificates** (Sep 18) — one cover wording per certificate type per event; the per-template cover email is gone

**Keep this list short.** A new entry goes in [CHANGELOG.md](CHANGELOG.md), not here.
If this section is growing past a handful of bullets it is drifting back into being a
changelog — which is what made this file 1.2 MB and cost ~274,000 tokens of context on
every session before anyone typed a word. Durable rules belong in
[AGENTS.md](AGENTS.md); this file is orientation.

## Current Mode

**Single Organization Mode** (multi-org support planned for later):
- User account registration is disabled (`/register` redirects to `/login`)
- Team members (Admin/Organizer) must be invited by an admin via Settings → Users
- Reviewers are org-independent (`User.organizationId = null`) — invited per-event via the Reviewers page
- Submitters are org-independent (`User.organizationId = null`) — self-register per event via `/e/[slug]/register`
- Registrants are org-independent (`User.organizationId = null`) — create accounts during public event registration, see only `/my-registration` portal
- Public event registration is open to all at `/e/[event-slug]`

- **Zoom integration** — Fully decoupled, optional Zoom module for live meetings, webinars, and webinar series linked to event sessions; `ZoomMeeting` Prisma model with 1:1 relation to `EventSession`; `src/lib/zoom/` server module (OAuth client with in-memory token cache + debug-level cache hit logging, meetings/webinars CRUD with per-operation logging, org-aware JWT signature generation with dev/prod SDK mode); all credentials stored AES-256-GCM encrypted per-org in `Organization.settings.zoom` — Server-to-Server OAuth (accountId, clientId, clientSecret) + General App SDK with separate Dev and Prod keys (sdkKeyDev/sdkSecretDev, sdkKeyProd/sdkSecretProd, sdkMode toggle) — no env vars needed; secrets optional on update (existing encrypted values preserved if left blank); per-event toggle via `Event.settings.zoom.enabled`; 7 API routes (credentials CRUD with dev/prod SDK, test connection, event settings, session meeting CRUD with startUrl/passcode, panelist sync with rate limit, public join with org-aware signature, public session detail with event branding + speakers); branded public session landing page at `/e/[slug]/session/[sessionId]` with event banner, session details, speaker photos/bios sidebar, Live/Upcoming/Ended badges, prominent "Join Meeting" CTA opening Zoom web client, meeting details card; DRAFT events allowed for testing; session edit dialog shows "Start as Host" (opens Zoom as host), "Attendee Join Link", "Copy Link", "Open Embed Page", meeting ID + passcode; `ZoomSessionBadge` on session cards in calendar tooltip + session list; rate limiting on all Zoom endpoints (create 30/hr, join 60/hr, credentials 10/hr, panelists 30/hr) with `apiLogger.warn` on every rejection; full logging coverage: `zoom:creating-meeting`, `zoom:api-call` (with durationMs), `zoom:api-error` (with zoomErrorCode), `zoom:token-cache-hit`, `zoom:oauth-token-refreshed`, `zoom:join-via-sdk`/`zoom:join-via-url`, `zoom:panelists-synced`, `zoom:credentials-saved`; performance: OAuth token cache with 5-min pre-expiry, Promise.all on all parallel queries, Prisma select everywhere, no N+1 patterns; `@zoom/meetingsdk@^6.0.0` in `serverExternalPackages`; **Component View (in-page embed) works under React 19** via `src/components/zoom/zoom-web-embed.tsx` — but NOT by npm-importing `@zoom/meetingsdk/embedded` (that UMD externalizes React + uses React-18 `ReactCurrentOwner`, which React 19 removed → crash). It loads the SDK + its own React 18 from Zoom's CDN as isolated globals via `src/lib/zoom/load-embedded-sdk.ts` (`NEXT_PUBLIC_ZOOM_EMBED_LOADER=cdn` default; `npm` flip-back for when Zoom ships React-19 support). See the June 23 "Zoom embed React-19 crash fixed via CDN loader" entry above. The iframe fallback `src/components/zoom/zoom-embed.tsx` (pointing at `zoom.us/wc/join/`) is still preserved as a belt-and-braces escape hatch but not imported by default; Client View (`@zoom/meetingsdk` top-level entry, non-embedded) remains blocked because it mounts into the host fiber tree; supports Meeting (interactive, 1K), Webinar (broadcast, 10K), Webinar Series (recurring, type 9); migration `20260408000000_add_speaker_accommodation_and_zoom`; docs at `docs/ZOOM_INTEGRATION.html`

- **Live streaming (MediaMTX)** — Self-hosted RTMP→HLS media server, the **second live-video path** alongside the Zoom SDK embed. **Why it exists:** the `ZoomWebEmbed` path makes every viewer a Zoom meeting participant (counts against the org's Zoom capacity/seat limits, heavier client, interactive). For a large broadcast-only audience that just needs to *watch*, that's the wrong tool — so a session can instead enable one-way live streaming where the host pushes a **single** RTMP feed and unlimited attendees watch a one-way HLS stream at near-zero marginal cost, no Zoom seat per viewer. **What it is:** `bluenviron/mediamtx` (open-source single-binary media server: RTMP/HLS/WebRTC/RTSP) running as the `ea-sys-mediamtx` Docker container on the same EC2 box (NOT on Zoom's infra — note this contradicts an outdated line in `docs/ZOOM_INTEGRATION.html` that says all streaming runs on Zoom; that's true only for the embed path). **Flow:** session with `ZoomMeeting.liveStreamEnabled` + `streamKey` → host streams to `rtmp://{host}:1935/live/` with the stream key (via Zoom's "Stream to Custom Live Streaming Service" or OBS) → MediaMTX ingests on :1935, remuxes to HLS (mpegts, 7×2s segments, see [mediamtx.yml](mediamtx.yml)) → nginx proxies `/stream/` → MediaMTX :8888 → public [LivePlayer](src/components/zoom/live-player.tsx) plays `{appUrl}/stream/live/{streamKey}/index.m3u8`. **Status:** [stream-status route](src/app/api/public/events/%5Bslug%5D/sessions/%5BsessionId%5D/stream-status/route.ts) (public, 360/hr per IP) probes the MediaMTX HLS endpoint (`MEDIAMTX_HLS_URL` env, defaults `http://localhost:8888`) to detect live/idle/ended and flips `ZoomMeeting.streamStatus` (IDLE→ACTIVE→ENDED); the player polls it. Port 8889 (WebRTC) is reserved for a future low-latency path, currently unused. Admin sees RTMP URL / stream key / HLS URL / attendee page in the `StreamingInfoCard` on the session Zoom form. **Caveat:** the nginx `/stream/` → `:8888` proxy is NOT in the committed `deploy/nginx.conf` — it must be configured on the EC2 box manually (documented in `docs/LIVE_STREAMING.md`). Schema fields on `ZoomMeeting`: `liveStreamEnabled`, `streamKey`, `streamStatus`. Docs at `docs/LIVE_STREAMING.md` / `.html`.

## Logging

Pino-based structured JSON logging with three output modes:

- **Development**: Pretty-print to console + JSON to `logs/app.log` and `logs/error.log`
- **Vercel (production)**: stdout (Vercel's built-in logs) + database (`SystemLog` table) for the `/logs` web viewer
- **EC2/Docker (production)**: stdout + `logs/app.log` + `logs/error.log` + **warn+error → `SystemLog` table** (Aug 4, 2026 — the DB stream was historically Vercel-only, so on the EC2 box the table was NEVER written and everything reading it — the `/admin/infra` "Error rate" + "Abuse & auth" cards, the `/logs` database source — showed zero forever). warn+ only (no info flood); retention 30 days via the `system-log-prune` worker job (04:45 UTC daily, JOB_ID 1014); both web AND worker containers write it.

### Log Viewer (`/logs`)
- SUPER_ADMIN-only web UI at `/logs` with retro terminal theme
- Supports three sources: **Database** (default on Vercel), **File**, **Docker**
- Filters: level (error/warn/info), time range (10m to all), search text
- Auto-refresh (configurable interval), export filtered or all logs to text file
- **Download All** — fetches all logs from current source and exports
- **Clear Logs** — deletes database logs for selected timeframe (database source only); DELETE endpoint at `/api/logs`

### Database Logging (Vercel)
- `SystemLog` model stores log entries in PostgreSQL (level, module, message, timestamp)
- Pino writes to a custom `Writable` stream that buffers entries and batch-inserts every 2s or 20 entries
- Debug-level logs are skipped to reduce DB load
- Lazy Prisma import to avoid circular dependency (`db.ts` → `logger.ts`)

### Logger Modules
- `apiLogger` — API route logging
- `authLogger` — Authentication events
- `dbLogger` — Database operations
- `eventLogger` — Event-related operations

### Coverage
- All API route catch blocks log via `apiLogger`
- Middleware logs CSRF rejections, size limit violations, restricted role redirects
- Auth JWT callback logs DB lookup failures
- Server pages log DB query failures before re-throwing
- File upload handler logs path traversal attempts and read errors
- CSV import logs validation errors

View file logs: `tail -f logs/app.log`

## Documentation

- `AGENTS.md` (repo root) - **The invariants file (July 14, 2026).** Short, durable orientation for *any* AI coding agent — the cross-tool convention (Codex / Cursor / Copilot / Zed auto-load a root-level `AGENTS.md`). Holds ONLY what stays true when a feature ships: the stack, the **five entry-point types**, the **seven hard rules** (no cross-caller duplication · every failure path logs · guard clauses · additive+idempotent migrations · the 4-command verification gate · enrich-only syncs · correctness never depends on which DB connection ran a statement), the **six deliberately-disagreeing visibility boundaries** (finance includes MEMBER+ONSITE; barcode excludes MEMBER, includes ONSITE; contacts includes MEMBER, excludes ONSITE — reaching for a "close enough" existing predicate is the signal to write a new one), the API-route shape, and a pointer table. **Deliberately carries no feature list** — that is what rotted its predecessor (`docs/agents.md`, now a redirect stub, had gone ~4 months stale: Stripe/badges/E2E listed as "Not Started", Brevo named as the mail provider, no services layer / worker / MCP / MEMBER-ONSITE-REGISTRANT roles). **`CLAUDE.md` is the changelog; `AGENTS.md` is the invariants** — keep them in their lanes so neither has to be hand-synced.
- `docs/DOMAIN_MAP.html` - **The context-reload index (July 13, 2026). Read this FIRST when touching an unfamiliar domain.** Interactive collapsible tree (pure `<details>` HTML — works inside the sandboxed `/admin/docs` iframe, no JS required; expand/collapse-all buttons appear when opened in a full tab) mapping all 11 active domains (+ supporting domains): every entry point (UI / REST / public / MCP / worker), the core-logic files (services + libs), data models, per-domain gotchas, review-report status, and where each domain's deferred findings live in ROADMAP. Also holds the review-status scoreboard (which domains have had a production review; Dinner RSVP is the one that hasn't) and the system-shape primer (5 entry-point types, anti-drift services rule, cross-cutting libs table, worker-job schedule). Refresh its "Last updated" stamp after each domain review lands.
- `docs/BUDGET_PROCUREMENT_MODULE.html` - **Budget & Procurement Module spec, rev. 3.6 (Sep 10, 2026), PLANNED, NOT BUILT.** One page in three parts: a plain-language edition for Medhat and finance (what the module does, the four numbers on every line, the budget lifecycle, who approves what, benchmarking against the previous edition or a similar event (planned from Phase 1, built as Phase 6), the timeline, decisions made, what is still to confirm, a glossary); the full technical specification kept word for word (entities, approval engine, QuickBooks adapter, money rules, phasing) for engineering and for AI-assisted review; and the revision history last. Rev. 3.5 applied two independent reviews (against the code and against the document): a third `procurement.settle` grant for Muthu, the bill-from-PO operating rule the read-back depends on, past-event expense from QuickBooks by Class (EventsAir never held costs), and a re-baselined 16-week build (4 to 5 months with revenue and benchmarking). Rev. 3.6 is wording only, in the plain edition: a budget row is a "line item" (glossary entry added), and approvals are taken on the Approvals page in EA-SYS, never from email, which only notifies with a link; Part 2 stays at rev. 3.5. The same page is published as a Claude artifact for sharing; this repo copy is the reference. Do NOT start building without owner go-ahead.
- `docs/BUDGET_PROCUREMENT_BUILD_PLAN.md` - **Budget & Procurement build plan (Sep 10, 2026), PLANNED, NOT BUILT.** The how of the spec above: capacity and deploy-time analysis (the module adds internal load only, totals are stored not recomputed, everything that talks to QuickBooks runs in the worker), why the four new jobs stay in the existing worker container with a `WORKER_JOBS` allow-list as the switch to split later and numeric triggers for when, a Phase 0 load baseline with the k6 read-burst script (never run against prod so far), effort sized against CRM and HR (20 to 22 tables, 150 to 200 files, 30k to 40k LOC), per-phase tables, files, worker jobs, tests and exit gates, the outbox and approvals core primitives' contracts, the tenancy package each phase ships with, rollback, and open risks. Do NOT start building without owner go-ahead.
- `docs/SPEND_REQUESTS_WALKTHROUGH.html` - **Spend requests, screen by screen (Sep 14, 2026).** Fifteen captures from the local standalone in the order a requester and an approver meet them (the form within and past the line, the draft checklist, quotes, submit, pending, the exception, the two inboxes, approval, the amount change, Decided by me, the list, the budget page action), with plain-word captions, what comes next (the purchase order, slice 3) and the words used. One self-contained page with the images embedded, under the docs viewer's 1 MB cap; regenerate from fresh captures with the scratchpad's `build-walkthrough.mjs` rather than editing the base64 by hand.
- `docs/CRM_STATUS.html` - **CRM live status board (July 14, 2026). The page to read — and to KEEP CURRENT — for anything CRM.** What is done, what is pending, and crucially **what is actually LINKED to the rest of EA-SYS vs not**: the deal↔event join is wired (the module's whole reason to exist), but the won-deal→`Event.settings.sponsors[]` handoff, the MCP/agent tools, the CrmNote→Activity-feed merge and the overdue-tasks dashboard tile are **not**; and `Contact.companyId` is wired-but-empty because **no backfill has run**, so every existing contact's company link is null. Also lists the **"API exists, UI does not"** set (pipeline-stage management, deal edit, standalone task create, company edit, deal↔contact link) — working, tested, gated endpoints with no way to reach them from the app. **Not deployed: the migration has not been applied to prod.** Pure `<details>`/CSS, no JS, so it renders inside the sandboxed `/admin/docs` iframe.
- `src/crm/README.md` - **The CRM module developer entry point.** The file to read before touching anything under `src/crm/`: scope (what's in/out of v1), the code layout, the **five load-bearing invariants** (one-way import boundary · CrmContact is a different population from event Contact · the CRM's own visibility predicates · conditional-claim state transitions · org-bound relation ids), the code conventions, and add-a-thing recipes. Points at CRM_STATUS.html for live status and CRM_MODULE_PLAN.md for the blueprint.
- `docs/CRM_MODULE_PLAN.md` - **CRM module assessment + implementation blueprint — IN BUILD (un-parked July 14, 2026; was PARKED July 13).** Owner decision: no new domains until a few real conferences run on EA-SYS. Preserves the full plan (what exists vs Freshsales, build-vs-buy call, measured infra headroom, ~1-month timeline, Prisma schema sketch, services/API/UI/worker/MCP blueprint, week-by-week build order, and the 4 owner decisions that gate the planning round) so the build can start cold the day it un-parks. **Architecture locked (§7.0): "independent module, shared runtime"** — hard-bounded namespace (`src/crm/` code root, `/api/crm/*` routes, `/(dashboard)/crm/*` pages, `Crm*` Prisma models, ESLint-enforced one-way imports crm→core) inside the main app; a separate container/deployable was considered and REJECTED (SSO + duplicated RBAC + contact-sync drift + second deploy pipeline for ~10-20 internal users; the worker-container analogy doesn't transfer — worker is CPU isolation of the same codebase, not a separate system). Do NOT start this without explicit owner go-ahead.
- `docs/FROM_SCRATCH_REBUILD.md` - **Full production-box rebuild runbook (July 13, 2026).** The ordered checklist for standing up a replacement EC2 from nothing: IAM role (all 3 inline policy JSONs snapshotted), SG ports (incl. the oft-forgotten 1935 RTMP), **swap creation (the INC-001 gap no other doc had)**, package bootstrap via `infra/dr/user-data.sh`, `.env`/uploads restore from the DR bucket, nginx from the **live snapshot** (`deploy/nginx.live-snapshot.conf` — never the template), blue-green wiring (SERVER_SETUP.md = its Phase 4), the complete live crontab 📸, fail2ban + CloudWatch, CI reattachment, and a final verification checklist. Also records known drift in MUMBAI_SETUP.md/SERVER_SETUP.md.
- `docs/INCIDENTS.md` - **Incident log & outage post-mortems** (INC-001: on-box `docker build` froze the swapless t3.large) + a reusable "how to diagnose a frozen box" appendix. Read this before/after any prod incident.
- `docs/CI_PIPELINE.html` - **CI/CD pipeline reference + GitHub-VM capacity menu** (July 22, 2026). The post-split `deploy.yml` shape (parallel `checks`/`tests`/`build` → `build-push` → `deploy`; non-gating `tenancy` + `sourcemaps` beside), the what-runs-where fact (ALL CI jobs incl. service containers run on GitHub-hosted VMs — the box is only touched by `deploy`), accepted trade-offs of the split, the **ranked menu of further Actions offloads** (fresh-DB migration replay = recommended next, e2e-in-CI, automated DR drill (needs an OIDC IAM extension), weekly npm-audit, bundle-size guard, schema-drift check — plus the deliberate NOT list: load tests, uptime monitoring, CodeQL, PR previews), quota math (~19 min/push post-split), and the pipeline decision log. Update the diagram + decision log when deploy.yml changes.
- `docs/ROLLBACK.md` - **Rollback runbook** (July 10, 2026; **code path DRILLED on prod July 14, 2026 — it works**). The two independent rollback axes: **code** = blue-green redeploy pinned to a previous ECR image (`IMAGE_TAG=<full-40-char-git-sha> bash scripts/deploy.sh` — same health-check + graceful nginx switch, **measured 22s**, zero downtime; web `<sha>` + worker `worker-<sha>`); **data** = S3 `pg_dump` restore points (Singapore DR bucket; surgical vs full restore via `infra/dr/README.md`); plus uploads/.env restore, a combined-scenario matrix, and a post-rollback checklist. **§1.6 is the drill log** (real timings + what it taught us); **§1.5** documents `workflow_dispatch`. **Four things the drill established:** (1) **docs-only AND empty commits do NOT deploy** (`paths-ignore` — the INC-001 guard), so *the newest commit in `git log` is not necessarily what prod runs — check `docker ps`*; (2) a **pinned rollback is ~22s** (pull-only) while a **full CI deploy is ~7min** (it builds) — don't conflate them in an incident; (3) **the box's git checkout does NOT roll back, only the image does** — a rollback across a `docker-compose.prod.yml` change would run a new compose file against an old image; (4) **migrations across a rollback boundary remain UNDRILLED** (`deploy.sh` runs `prisma migrate deploy` from the image being deployed) — documented as *believed safe, unverified*, and it's the top item for the next drill. Re-drill quarterly + after any change to `deploy.sh` / compose / the CI workflow.
- `docs/DDOS_RESPONSE_PLAN.md` - **DDoS incident runbook** (Aug 3, 2026) — the *during-the-incident* half of the security posture (AWS_OPERATIONS §4 is the static half): the 4-scenario triage table (organic rush vs few-IP abuse vs distributed L7 vs volumetric — incl. the EA-SYS-specific "venue-NAT false positive" trap), 5-minute SSM triage commands, the 3-level response ladder (fail2ban/ufw bans → nginx pattern-blocking + zone tightening + desk-path carve-outs → emergency Cloudflare onboarding per §4.3), live-event rules (pre-whitelist the venue IP; scanner/kiosk/badge paths must stay up; closing public registration is cheap + reversible), stand-down + post-mortem checklist, and a quick-reference appendix (live nginx/fail2ban thresholds, the 6 CloudWatch alarms, instance ids).
- `docs/AWS_OPERATIONS.md` - **Master AWS CLI runbook** — daily ops (SSM access, instance health, CloudWatch logs, SES, S3) + **performance troubleshooting** (CPU/memory/disk spikes, the t3 CPU-credit-throttle trap, which-container triage, DB pool exhaustion, process/thread forensics via docker top + /proc) + **security/DDoS-bot posture** (§4: WAF audit findings, live nginx rate limiting, add-Cloudflare-later playbook) + disaster recovery (uploads/.env/file/DB restore, full regional failover), with the inventory of instance IDs / regions / buckets / roles. Aggregates the scattered AWS commands; cross-links the deep runbooks below.
- `infra/dr/README.md` - Disaster-recovery deep runbook (Singapore break-glass box, surgical recovery, promotion/return)
- `infra/cloudwatch/README.md` - CloudWatch agent setup + Insights queries + alarm pipeline
- `docs/runbook-ses.md` - SES email runbook (sender verification, DMARC, bounce triage)
- `docs/DEVELOPMENT_STATUS.md` - Feature status and roadmap
- `docs/CODEBASE_SIZE_BY_DOMAIN.md` - **Route and file counts per domain (Sep 8, 2026).** Derived from the tree (345 API route files, ~1,070 source files at `ded1c939`), bucketed into the domain map's domains with the first-match caveat stated. Its finding: the CRM module (~45 routes, ~128 files, the second-largest surface) had no branch in the domain map; that branch now exists beside the much smaller "Contacts (org CRM store)" entry it was being confused with.
- `docs/DEPENDENCY_LOG.md` - **Dependency log (Sep 7, 2026).** Every dependency change that reached `main`, newest first: what moved, why, the exposure reasoning for security bumps, how it was verified (each entry names the e2e baseline it was diffed against, because the suite carries pre-existing failures), rollback, and what was left open. Starts at the July 23 Next 16.1.4 → 16.2.11 upgrade. Ends with the table of upgrade decisions waiting on the owner (Next 16.3, Prisma's unfixable `deepmerge-ts` high, Tiptap 3, the Anthropic SDK major, Brevo/SendGrid removal). The how-to is `docs/UPGRADE_GUIDE.md`; this is the record.
- `docs/PLATFORM_DECISIONS.md` - **The 8-item pre-platform decision round (Aug 4, 2026) — the single revisit point for what remains before the platform instance can launch.** The Phase-2 sweep queue is EMPTY (all 20 domains done); this doc records the owner's rulings + Claude's inputs on each remaining item: **(1)** tenant offboarding = archive-to-S3 restore-grade dump, delete after years, "offboarded" state in tenant management (DECIDED); **(2)** NULL-org row purge = archive to S3 then delete (DECIDED); **(3+4)** org-null audit-write loss + the 16-instance `?? ""` pass = stamp the default/operator (MMG) org id + a `tenantName`-style identifier instead of losing rows / dead lanes (DECIDED — one operator-lane-visibility nuance to confirm: MMG-stamped rows are readable in MMG's tenant lane, the label doesn't isolate); **(5)** privileged maintenance lane (OPEN — inputs delivered: no-FORCE means the owner DB role bypasses RLS, so the lane = a second owner-role connection string behind a greppable `dbOperator` export + a `check-tenant-als.sh` import allowlist + route-level operator RBAC; owner decisions a–d pending); **(6)** identity model (OPEN — owner thesis: email unique PER TENANT, same address can exist in two tenants; implications incl. tenant-scoped login + `(organizationId, email)` unique + the org-null-roles hard edge recorded); **(7)** per-tenant Stripe/Zoom/Anthropic keys under Org Settings, encrypted, fallback chain tenant-key→platform-default (DECIDED — **next immediate build priority**, not started; partially supersedes the Stripe Connect question — direct keys vs Connect to confirm at kickoff; Zoom/EventsAir per-org AES-256-GCM pattern is the template); **(8)** master ops step ✅ DONE Aug 4, 2026 (TenantDomain `events.meetingmindsgroup.com → MM Group [primary][verified]` seeded via the container script; `DEFAULT_ORG_ID` verified already live in both containers — no redeploy; resolver warns gone). Update this doc in place as items 5/6 close.
- `docs/MULTI_TENANCY.md` - **Forward-looking multi-tenant / white-label SaaS reference** (NOT shipped — EA-SYS is single-org today). **§0 topology DECIDED July 22, 2026: the two-silo plan** — master (current box, MM Group only, unchanged) + a new **platform** instance (fresh DB, ALL external tenants incl. customer #1, Pool+ with RLS from day one); ONE repo / ONE image / two deploy targets, flags-not-forks; guardrails (master runs identical build + `TenantDomain` row; platform first-class prod from birth; dogfood an MMG event before selling; ~6-month merge-vs-silo re-eval trigger; silos capped at two). Build order: Phase-0 spine (TenantDomain + host resolver + AsyncLocalStorage/`SET LOCAL` + isolation test harness + the slug-routing cut) → domain-by-domain sweeps piloting on Contacts. Still open: user-identity model, Stripe Connect details. Tenancy models (Pool/Bridge/Silo), host→tenant routing, **RLS on Prisma + Supabase** deep-dive (the pgbouncer `SET LOCAL` wrinkle), Stripe Connect, per-tenant logging/observability, ops complexity, maintenance, a **real cost model** (CDN egress is the surprise line), security (the IDOR-history lesson → isolation test suite), and a phased roadmap. Read before any white-label work.
- `docs/MULTI_TENANCY_IMPACT.md` - **Codebase-grounded Impact & Blast-Radius assessment** (companion to MULTI_TENANCY.md; June 24, 2026, from a 3-lens read-only audit; §7/§8 recast July 22, 2026 for the two-silo decision — RLS + `organizationId` backfills now land on the greenfield platform DB, not MMG's live DB; §8 decisions #2 isolation + #4 MM-Group-stays-siloed marked DECIDED, #1 identity + #3 Connect still open). Where single-org assumptions actually live + what breaks/leaks if done wrong: **0 RLS today + 25/33 tenant tables lack an `organizationId` column**, the systemic `where:{slug}` with no org filter (the #1 latent leak — `Event.slug` is only unique *per-org*), `User.email` global-unique (the hardest identity call), 193 `organizationId!` assertions, Stripe single-account→Connect, per-tenant email/storage/logging gaps. Has a subsystem impact table (risk/effort/breaking), blast-radius ranking, breaking-vs-additive migration sequencing, what's **already** per-tenant-ready (Zoom/EventsAir/branding), and the human decisions to make first. Read alongside MULTI_TENANCY.md before scoping the work.
- `docs/RSVP.md` - **Dinner RSVP feature** (2026-07-08). Per-dinner RSVP with a personalized token link covering all the event's dinners; organizer console (manage dinners, import from Registrations/Speakers, roster + per-night headcount tiles + CSV, Email invitations / Remind pending with a template-based preview) at Event → Setup → Dinner RSVP. Public form at `/e/[slug]/rsvp/[token]`. MCP `list_dinner_rsvps`. Data model, API, phases, and the "no auto-reminder cron" decision.
- `docs/TRAVEL_GRANT.md` - **Travel Grant reference (2026-08-25) — PARTIALLY BUILT.** An abstract author based OUTSIDE the UAE is offered a travel grant; the invitation rides as a block inside their submission-confirmation email and lands on a token-gated consent form. A UAE-based author sees nothing. **All six steps SHIPPED Aug 25, 2026** (predicate · schema + migration + RLS policy + harness test · organizer controls · the email block · the token-gated public consent form · the console, plus a card on the speaker profile). **Never run on a real event** — the outstanding verification is one test abstract from an overseas author, end to end, before a call for abstracts opens. The load-bearing piece is `classifyResidency()`, which returns `uae | overseas | unknown` and NOT a boolean: `Speaker.country` holds a display name but `CountrySelect` resolves on either code or name and the CSV importers write it as free text, so `"AE"` is reachable and `country !== "United Arab Emirates"` would mail a Dubai resident a grant offer. Unrecognised input resolves to `unknown` and NEVER `overseas`, because `"Dubai"` is a reachable value and Dubai is in the UAE — enumerating emirate names fails OPEN on the ones you forget, falling through fails CLOSED. Decisions + reasoning: `docs/TRAVEL_GRANT_PLAN.md`. Making the exempt country configurable (the multi-tenancy follow-up): `docs/TRAVEL_GRANT_COUNTRIES_PLAN.md`. Operator instructions: user-guide § Travel Grants.
- `docs/TRAVEL_GRANT_PLAN.md` - **Travel Grant plan + decision record (2026-08-25).** The nine locked owner decisions (D1 eligibility-and-interest only with nothing financial · D2 one record per person per event · D3 a block in the existing confirmation email · D4 unknown country means do not send but do flag · D5 going forward only, no bulk retroactive sweep · D6 residency IS the country selection · D7 the console lists everyone including the ineligible · D8 submission only · D9 a remind-pending action), the production numbers behind D5 and D7, the build order, what is deliberately NOT in v1, and the two traps steps 4–6 must design around: the 24 events holding a materialised `abstract-submission-confirmation` template that a default-only token change would silently miss, and the bulk-send button sitting directly above people who must not be emailed.
- `docs/TRAVEL_GRANT_COUNTRIES_PLAN.md` - **Making the exempt country configurable — PLANNED, NOT BUILT (2026-08-25).** `classifyResidency()` has the UAE hard-coded, which is a customer's geography baked into a shared feature and **wrong for every tenant except MM Group** — a Riyadh conference would offer grants to its own locals and withhold them from everyone in Dubai. Cheapest now: **zero real events have used the feature**, so there is nothing to backfill and no live config whose meaning would change. The design **deletes a special case rather than adding one**: six hand-written UAE spellings become a general resolver where the organizer's pick is stored as an **ISO alpha-2 code** and an author's free-text country is resolved through the same `countries.ts` list `KNOWN_COUNTRIES` already walks (it currently throws the code away), leaving a small shared informal-alias table (`uae→AE`, `ksa→SA`, `uk→GB`). **Three things must survive:** `uae|overseas|unknown` becomes `home|overseas|unknown` with `unknown` intact (the alias problem multiplies rather than disappears — `"Jeddah"` and `"Doha"` join `"Dubai"`); a **list**, not a scalar (a Dubai conference plausibly treats Saudi and Qatar as local); and **enabled-but-unconfigured must read as DISABLED**, the one place the intuitive reading fails OPEN — an empty exempt list would classify every recognised country as overseas and mail grant offers to local authors. Grounded cost: **five `classifyResidency` call sites, every one of which already holds the event's `settings` blob, so zero additional queries**; renaming the union member makes the compiler name every consumer via the `Record<ResidencyClass, string>` label map. 6 decisions in §2 (event-level not org-level; no region presets; no org default), 4 open questions in §7 incl. the 2+ country label wording.
- `docs/COMMITTEE_MEMBERS.md` - **Design decision record: how committee members are modeled** (2026-07-08). Committee = a **tag** (`committee` + optional `committee-organizing`/`committee-scientific`), NOT a ticket type — because it stacks with faculty (a ticket type is a mutually-exclusive slot). Comp registration + committee `badgeType` + the tag; everything operational (badge/barcode/check-in/DTCM/survey/cert) is registration-level and works automatically. Pull via REST `GET …/registrations?tags=committee` (works today; any-of `attendee.tags hasSome`). **Faculty vs committee are two dimensions** (faculty = the `isFaculty` ticket type, committee = a tag), so there's no single union query today — §4a/4b/4c cover pulling faculty (`GET /speakers` or `?ticketTypeId={facultyTypeId}`), the faculty+committee "non-delegate" cohort (two-call+dedup / client-filter / the proposed `?segment=internal` union filter), and how multiple tags reconcile (`hasSome` membership, no double-count). Pending conveniences: a 3-checkbox UI on the registration form, a `tags` param on MCP `list_registrations`, and the `?segment=internal` union filter. Count-exclusion (internal `isFaculty`→`isInternal` type) NOT built — unneeded while events are uncapped. Companion to IDENTITY_AND_ROLES.md.
- `docs/GROUP_REGISTRATION_PLAN.md` - **Group registration blueprint — PLANNED, NOT BUILT** (July 30, 2026; refreshed Aug 6, 2026 against the post-tenancy-sweep codebase — owner: "refresh the plan, hold the build"). A company coordinator registers 2–50 people via ONE organizer-copied shared link, enters the payer (→ `findOrCreateBillingAccount`), pays one cumulative Stripe checkout OR pay-later against a **consolidated invoice**, and manages the group post-submission ("My Group" portal). 6 owner decisions locked (§1). The structural gap: `Invoice.registrationId`/`Payment.registrationId` are required FKs → new `RegistrationGroup` anchor + nullable FKs + a null-guard sweep across the money paths (§3 — the risky part; partially de-risked since the webhook dispatch is now single-sited in `handleStripeEvent()`). §3a (Aug 6) is the born-compliant tenancy package a NEW domain must ship with (org stamping, `tenantTransaction`, `runWithTenant` + CI-gate entries, `prisma/rls/` policy in the same PR). 4-phase build order (§7); explicit NOT-in-v1 list (§8). Do NOT start without owner go-ahead.
- `docs/MULTI_CURRENCY_PLAN.md` - **Pricing in USD / AED / EUR, currency set at the EVENT level: PLANNED, NOT BUILT** (Aug 12, 2026). Groundwork for tenants who do not bill in dollars. **The plan is short because the survey found the money paths already currency-aware**, and each claim in §2 was read in source: the webhook records `session.currency` (Stripe's own answer) rather than our stored value; refunds are denominated from the Payment row, not today's price, which is what Stripe requires; event analytics already does `groupBy: ["currency"]`; the payer roll-up already refuses to total mixed currencies. Every remaining money sum is scoped to ONE registration, which event-level currency makes safe by construction, and there is no org-wide revenue total anywhere. So the actual work is a dropdown (the field is free text today and a trailing space throws a `RangeError` that crashes the tier list AND the public form), a nullable `Event.currency`, inheritance, and a **lock-once-money-has-moved** rule since changing it later silently re-denominates history. USD/AED/EUR are all two-decimal so the `x 100` Stripe conversion needs no change at all. **OMR is deliberately excluded** (§7): three decimals, so our `x 100` would charge a TENTH of the intended amount, silently, and fixing it means consolidating four duplicated conversion sites. The one thing not answerable from the codebase is which presentment currencies the Stripe account has enabled: an unenabled currency fails at checkout creation, i.e. when a registrant clicks Pay (§6, owner Dashboard check). 4 open questions in §9 incl. the DEAD `settings.currency` that is written by the org settings page and read by nothing. Do NOT start without owner go-ahead.
- `docs/HR_MODULE_PLAN.md` - **HR module (attendance + UAE leave tracker): PLANNED, NOT BUILT** (Aug 27, 2026). Replaces the validated Excel tracker `UAE_Employee_Attendance_Leave_Tracker_2026` v5.1, which stays the business-logic reference (where the plan and the workbook disagree, the workbook wins). Independent module on the CRM precedent (`src/hr/`, one-way imports, its own confined `HR_USER` role), 5 tables born tenancy-compliant. **§3 was rewritten the same day from the workbook's FORMULAS rather than its numbers, and the reading overturned a premise: the leave year is the CALENDAR year, not the service year** (entitlement is a flat 30 gated on the first anniversary having passed, and the AL COUNTIFS has no lower date bound), so the anniversary-lump model in the first draft was wrong. It also found **a live defect in the workbook**: the comp-off formula is `previous day was also OD`, but the owner's rule is `both days of the same weekend`, and of 58 OD days across 16 employees exactly one row diverges (EMP002, a Wed+Thu pair earning a comp-off that should not exist), so the import must expect that single deliberate difference rather than treat it as a failure. And it quantified the storage note: 9,125 pre-generated rows of which **943 carry information**. **Three questions remain open** and none is answerable from a workbook that holds one year: whether a negative balance carries into the new year (Leena closes at −15), whether carryover is capped, and whether derived-present is acceptable or a month needs finalising. **§8 enumerates the `HR_USER` sweep file by file** because that is the expensive part, not the enum value: `CRM_USER` touches **32 files**, and `RESTRICTED_WRITE_ROLES` is the ONE deny-list in the set, so a role missing from it can write to every non-HR route while every other predicate (finance/barcode/login/export/contacts) is an allow-list that excludes it for free. §9 is the born-compliant tenancy + worker package (RLS day one, `runWithTenant` + `check-tenant-als.sh` entries, accrual as a worker `JobLease` job with an `expectedPerDay` entry, NOT an `/api/cron/*` shim). §10 is the privacy paragraph the original plan omitted: sick-leave records are health-adjacent personal data about named employees, and SECURITY_AND_PRIVACY_POSTURE.md is handed to a federal health authority. §13's import gate is exact reconciliation against the workbook's Leave Summary, with two live figures chosen because each is hidden by a plausible bug (EMP021 at -23 fails if anything clamps a negative; EMP001 at 45 days fails if half-day weighting or the service-year boundary is wrong). Also notes it reorders PLATFORM_DECISIONS §7. Do NOT start without owner go-ahead.
- `docs/PER_TYPE_DOCUMENT_UPLOAD_PLAN.md` - **Organizer ticks a box per registration type to demand a supporting document — BUILT Aug 13, 2026** (planned + shipped same day; header records 3 deviations from the plan and why). Replaces the name-pattern guess (`/resident|trainee/i`) the Resident letter shipped with, because the owner asked "what about Member?" one day later and a second hardcoded regex is the wrong shape. Four additive `TicketType` columns; the two booleans (`requiresDocument` / `documentRequired`) stay separate so "collect it but do not block" remains expressible. Storage stays ONE column pair on Registration (a registration holds one type, so at most one document) with the resident naming dropped; §3.3 states the limit that accepts. Live counts verified: Member type exists with **0 registrations ever**, so there is no behaviour to preserve there, while "Trainee / Student" currently matches TWO rules by accident. 4 open questions in §8. Do NOT start without owner go-ahead.
- `docs/SPONSOR_ATTRIBUTION_PLAN.md` - **Sponsors, their promo codes, and reporting what they brought. PHASE 1 SHIPPED Sep 2, 2026 (`529e490a`); phases 2 and 3 not started, see [ROADMAP](docs/ROADMAP.md) §"Sponsor attribution".** An organiser signs a sponsor, gives them a promo code, and wants to know at the end who that sponsor brought. Two populations arrive under one sponsor and **two different keys track them with nothing joining the two**: exhibitor staff by `Registration.sponsorId` + `INCLUSIVE`, invited doctors by the promo code they typed. **`PromoCode` has no sponsor column**, so a code belongs to its sponsor only by being named `ABBOTT20`. Consequences, all verified in source: the registrations list cannot filter by sponsor, neither CSV export carries a Sponsor column (both carry Promo Code), and the promo page shows a redemption COUNT with no way to see who. **Two findings reshaped the plan.** `sponsorId` is ALREADY allowed on a paying registration (the service requires it only for INCLUSIVE and validates it for every other status) and the UI hides the picker behind one JSX condition, so the cheapest part of the feature is deleting a condition. And sponsors live in `Event.settings.sponsors[]` with **no FK and no delete guard**, so removing one silently orphans every registration pointing at it, which the detail sheet already anticipates by rendering `(sponsor removed)`. **Three owner decisions locked:** one sponsor per promo code (a nullable column, not a join table); sponsors **promoted to a real table** (the larger option, taken deliberately: a report an organiser invoices against should not rest on a string pointer into JSON); and a paying delegate is taggable to a sponsor directly, whose consequence is stated plainly, **"sponsored by" stops meaning "this sponsor paid"** and becomes attribution, with `paymentStatus` answering the money question. **The sharpest design point is §4:** both writers of the sponsor list are replace-all (the dashboard PUT, and MCP `upsert_sponsors` whose default mode "deletes anything not in the passed array"), so an FK with `Restrict` makes both start failing the first time a sponsor has a registration. That is the guard working, and it means both writers reshape in the same phase; `upsert_sponsors` should also flip its default to `merge`, since an agent omitting a row currently deletes it. §5 enumerates the 13-site blast radius, including the one that would fail silently: **`"sponsors"` is in the clone allow-list**, so once it is a table, clone must copy ROWS or cloning an event drops its sponsors. Phase 1 (the link, the filter, the export column, unhide the picker) is deliberately shippable against the EXISTING JSON model, so the report can be proven right before the schema moves under it.
- `docs/MULTI_SURVEY_PLAN.md` - **Several surveys per event, one of them the certificate survey: PLANNED, NOT BUILT** (revived Sep 17, 2026; parked Aug 7). Owner goal: scale surveys without touching the CME survey, same personal links for other uses. Decided: all four uses (pre-event needs, faculty feedback, per-session rating, exhibitor feedback), registrations only (speakers via companions), repeats configurable per survey, one certificate survey per event. New `Survey` table (config, intro, thank-you, active, `gatesCertificates`, `responseMode` ONCE / ONCE_PER_SESSION / REPEATABLE, `sessionIds`), `SurveyResponse.surveyId` + `dedupKey` (NULL for repeatable so Postgres never collides, a real gate for the other modes) replacing the global `registrationId` unique. **Only the certificate survey stamps `surveyCompletedAt`**, so auto-issue, the thank-you sweep and the audience rules are zero-change, pinned by two mutation-verified tests. Token identifier becomes `survey:{surveyId}:{registrationId}` with a legacy fallback to the certificate survey; `{{surveyLink}}` and the URL are unchanged; the send gets a survey picker (`filters.surveyId`) and a saved-template picker (RSVP pattern) plus `{{surveyName}}`, because the default wording says "Thank you for attending". Keeping links alive for non-ONCE modes is a stated single-use relaxation. Five open decisions in §9, headed by O1: record "answered survey X" by DERIVING a responded / not-responded filter from response rows rather than a JSON field or a tag. Four phases, about 4.5 to 5.5 days. Do NOT start without owner go-ahead on §9.
- `docs/CUSTOM_ROLES_PLAN.md` - **Customizable roles: permission-based access for org staff. PLANNED, NOT BUILT** (Sep 15, 2026; owner: "no longer WEBINARS and MEMBER, completely customizable"). Roles become named sets of `(permission, scope)` grants from a ~105-key code catalogue (CRUD plus the non-CRUD verbs: check-in, refund, export, send, issue, approve; scopes ALL / ASSIGNED / WEBINAR; six sensitive-field permissions; module permissions). The eight staff roles are seeded as clone-only system roles that reproduce what the CODE does today (not the docs); REVIEWER / SUBMITTER / REGISTRANT and the platform operator stay out. Measured surface: 386 route files / 583 handlers, one deny-list (`RESTRICTED_WRITE_ROLES`) among allow-lists, `buildEventAccessWhere` defaulting unknown roles to org-wide, ~57 `denyReviewer`-only handlers with hand-rolled org lookups that turn org-wide the moment a scoped permission replaces the role gate, 61 client files, ~101 MCP tools gated only at registration. Build: Phase 0 hardening (worth doing regardless; closes gaps G1-G8) → Phase 1 catalogue + schema + `can()` + a generated parity test (old predicate == can() for every system role) → Phase 2 route sweep with a gating `check-permission-guards.sh` → UI/middleware/MCP → `EventStaffAssignment` replacing `onsiteUserIds` → role editor behind `CUSTOM_ROLES_ENABLED` with no-escalation rules and "view as role" → retire the old predicates. 15 to 21 weeks. **Revision 2 the same day, after an independent review verified against the code (§12):** a second safety net, a per-handler route status matrix (13 route files combine an allow-list with a second predicate, e.g. `dtcm-pool` admits MEMBER then refuses it on barcode, which predicate parity cannot see); system-role grants live in CODE so a later permission reaches every tenant; custom-role users hold a new `UserRole.CUSTOM` in `TEAM_ROLES` so un-swept allow-lists fail closed for them; custom grants are read in a lane borrowed from the user row (the auth path has no tenant lane, so RLS would silently return zero grants); scoped create/update validates the RESULTING object (replaces `WEBINAR_ONLY` + the eventType-flip refusal); `hrAccess` and the procurement request/settle/approve grants stay PER PERSON (recorded separation-of-duties decisions), which reversed D7; §5 rewritten from the code with a "does not hold" column (SUPER_ADMIN lacks the procurement person grants, ADMIN lacks HR without `hrAccess`, `abstracts.delete` is SUPER_ADMIN only). Also found: API keys refused on the registrations sponsor filter while receiving the field unredacted (G9), and the middleware passing any unrecognised role through. One review claim was overturned (G5 routes keep a separate org-null check). §10 holds 14 owner decisions, recommending Phase 0 alone first. Do NOT start without owner go-ahead.
- `docs/ROLES_AND_PERMISSIONS.md` - **The per-role permission matrix (Sep 21, 2026), verified against the code and pinned by `roles-and-permissions-doc.test.ts`.** Eleven roles plus API keys and custom roles: one line each, the write tiers, event scope, every visibility boundary as an exact role set, the ADMIN/ORGANIZER-only actions, org and operator surfaces, the CRM, HR and Budgets rules, what the middleware does with a URL, and the known gaps. Change a guard and this table in the same commit; the test fails otherwise. The summaries in ROADMAP, HANDOVER, ARCHITECTURE and the posture document point here.
- `docs/CLAUDE_AI_AGENT_GUIDE.md` - **One-page team guide to using EA-SYS from claude.ai (Sep 21, 2026), written for the events team, not developers.** Connect once (Settings, Integrations, add the MMG connector at the MCP URL, approve the screen that names events.meetingmindsgroup.com), what to ask by area with real examples, the habits that keep it safe (name the event, check before creating, confirm bulk sends, Zoom, sponsor and roster replaces, CME settings), the limits (100 requests an hour, 500 recipients a send), reconnecting after a tool change, and where to see what it did. The review's zero-code half; the in-app door is `/agent`.
- `docs/AGENT_ARCHITECTURE_REVIEW.md` - **Event Agent architecture review: one agent, two doors (Sep 21, 2026); all five phases SHIPPED the same day (Phase 4, the deletion of the hand-written definitions, last).** Addendum to EVENT_AGENT_READINESS.html answering "the agent sits inside an event and cannot create one; should we review the architecture?" Three AI doors over one tool registry (in-app Event Agent: 53 event-bound tools, 5 tool calls in 30 days; claude.ai via MCP: about 100 tools incl. `create_event`, 1,014 requests; help assistant: no tools). The in-app door is event-bound in five places by construction, so it cannot create, list or search events or touch contacts, CRM or budgets. Target: one context type with the event optional, `/api/agent/execute` at org level with the event route as an alias, a `/agent` sidebar page with event pre-context, tool selection derived from the registry for both doors, and one guardrail layer (write cap derived from the read-only predicate, an approval step for the irreversible actions, tool output as data, `source` on audit rows, runs stored). Five phases, about two weeks; all five phases are on main (the in-app door consumes the MCP registrations through `src/lib/agent/tool-registry.ts`, so the two doors share one tool list and, since Phase 4, one schema per tool; seven tools pause for approval on both doors; every in-app run is stored as names, counts and tokens); the §8 picks were taken on Sep 21 (MCP-door rules for scope, the two delete tools removed, the approval list accepted, a claude.ai guide next).
- `docs/PROCUREMENT_ROLES_PLAN.md` - **Custom roles for Budget & Procurement: BUILT Sep 16, 2026, on main** (planned Sep 15; kept as the design record). The super admin creates named roles ("PO Author", "PO Approver") as sets of permission checkboxes and tags one or more on a person, on top of their base role. Decisions: tagged on the person, additive, the AED approval limit stays on the person, super admin only. Holds the draft permission list mapped to today's predicates, the separation-of-duties rules checked on the union of a person's roles (final approver never requests, settle never decides), an additive three-table model named generically for CRM and HR later, about 1.5 to 2 weeks, and the conflict with `CUSTOM_ROLES_PLAN.md` (one role replacing the base role) to settle first. Do NOT start without owner go-ahead.
- `docs/IDENTITY_AND_ROLES.md` - **Operator runbook: "one person, many hats."** The two-layer identity model (event-scoped *facets* — speaker/registration/badge/abstract — stack freely by email and never duplicate; the *login account* `User.role` is single-valued and is the ONE seam that collides). Covers the make-an-existing-delegate/submitter-into-a-reviewer workflow (Settings → Users → Invite *promotes in place*), role-flip gains/losses, and the reviewer-vs-submitter single-login limitation. **§1 also records the Aug 6, 2026 owner ruling: external logins (SUBMITTER/REVIEWER/REGISTRANT) stay org-NULL and never inherit the event's org id** — "rows carry the org; external logins don't; a request derives the org from the resource" (org-null is the security fence; `requireOrgId` is for org-admin routes only, submitter-reachable reads authorize via `buildEventAccessWhere`). Mirrored as an operator-facing callout in user-guide §15 so the help chat can answer it. Read before a live conference with committee members who are also faculty.
- `docs/ZOOM_INTEGRATION.html` - Zoom SDK integration guide (architecture, setup, file list)
- `.env.example` - Environment variable template
