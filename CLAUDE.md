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
- **Email:** AWS SES (`@aws-sdk/client-sesv2`, ap-south-1). The ONLY active provider: `getProvider()` returns it unconditionally. Brevo, SendGrid and Postmark are commented out in [src/lib/email.ts](src/lib/email.ts), so `BREVO_API_KEY` / `SENDGRID_API_KEY` / `EMAIL_PROVIDER` are dead (the last is read once, as a log label).
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
│   │   │   ├── procurement/       # Budget & Procurement UI (budgets · requests · orders ·
│   │   │   │                  #   suppliers · products · approvals). LIVE in production
│   │   │   ├── hr/                # HR module UI (attendance grid · leave · holidays)
│   │   │   ├── agent/             # org-level AI Agent page; the per-event one is
│   │   │   │                  #   events/[eventId]/agent
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
│   │   │   ├── procurement/       # Budget & Procurement REST surface (45 route files)
│   │   │   ├── hr/                # HR REST surface
│   │   │   ├── integrations/      # QuickBooks OAuth + reads. The redirect URI is
│   │   │   │                  #   registered in Intuit's console, so this path must not move
│   │   │   ├── agent/             # org-level agent execute
│   │   │   ├── cron/              # LEGACY shims — the worker tier is the live runner
│   │   │   ├── admin/ organization/ contacts/ invoices/ billing-accounts/
│   │   │   ├── registrant/ my-reviews/ profile/ notifications/ activity/
│   │   │   ├── media/ upload/ import/ email-logs/ help-chat/ logs/
│   │   │   ├── auth/ webhooks/    # NextAuth · Stripe (global + per-org)
│   │   │   └── health/ openapi.json/
│   │   ├── .well-known/           # OAuth protected-resource + authorization-server metadata
│   │   ├── mcp-authorize/         # OAuth consent screen (outside the dashboard shell)
│   │   ├── admin/docs/[...path]/  # shareable direct-URL doc server: operator, + ADMIN where
│   │   │                          #   ADMIN_DOC_LINKS_ENABLED=true (master only). The browsable
│   │   │                          #   viewer at (dashboard)/admin/docs stays operator-only
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
│   ├── procurement/               # Budget & Procurement module. LIVE IN PRODUCTION since
│   │                              #   Sep 14, 2026, gated by PROCUREMENT_MODULE_ENABLED. Same
│   │                              #   one-way boundary as crm/ and hr/. components/ · hooks/ ·
│   │                              #   integrations/ (QuickBooks) · lib/ · services/
│   │                              #   Surfaces: (dashboard)/procurement/ + api/procurement/
│   ├── analytics/                 # first-party visitor analytics (no third-party JS, no
│   │                              #   cookies). core/ is written for extraction and may not
│   │                              #   import EA-SYS; react/ · store/ · buffer.ts
│   ├── lib/                       # cross-cutting server + shared libs
│   │   ├── agent/                 # AI-agent + MCP tool definitions & executors
│   │   │   └── tools/             # per-domain executor files (events, registrations, …)
│   │   ├── ai/                    # provider abstraction (Anthropic, OpenAI)
│   │   ├── certificates/          # render · issue-worker · bundle · tokens
│   │   ├── zoom/ webinar/         # Zoom API clients · webinar state machines
│   │   ├── tenant/                # multi-tenancy spine (host resolver, RLS assert)
│   │   ├── pdf/                   # shared PDF layout primitives (invoice/quote/receipt)
│   │   ├── survey/ rsvp/ reimbursement/ speaker-profile/ help-chat/ infra/
│   │   ├── approvals/ permissions/ travel-grant/   # approvals primitive · custom-role
│   │   │                              #   catalogue + route guard · travel-grant rules
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
│   ├── jobs/                      # 23 jobs: scheduled-emails · cert-issue · webinar-* ·
│   │                              #   invoice-reconciliation · approval-escalation ·
│   │                              #   quickbooks-health · hr-year-roll · crm-* · *-prune ·
│   │                              #   daily-digest · log-archive · mirror-archive · oauth-cleanup
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
├── deploy/  docker/               # nginx.conf (THE site config, = the box; NGINX.md) · Dockerfile.dev
└── public/                        # static assets · user-guide.html · uploads/ (volume)
```

Root files worth knowing: `Dockerfile` + `Dockerfile.worker` (the two prod images),
`docker-compose.prod.yml` (blue/green web + worker + mediamtx), `mediamtx.yml`
(RTMP→HLS live streaming), `AGENTS.md` (invariants), `CHANGELOG.md`.

## Key Files

**For "which files implement domain X", read [docs/DOMAIN_MAP.html](docs/DOMAIN_MAP.html); for
the durable rules, read [AGENTS.md](AGENTS.md).** This section is deliberately NOT a file index.
It was one until September 2026, reached 127 entries, and rotted exactly as the structure tree
above warns: it never mentioned procurement, HR, certificates or QuickBooks. What remains is the
spine you need in order to start, and the files where the obvious call is the wrong one.

### The spine

- [prisma/schema.prisma](prisma/schema.prisma) - the database, ~150 models. This is the reference; the Database Models section below is orientation only.
- [src/lib/auth.ts](src/lib/auth.ts) - NextAuth v5 configuration and the credentials authorize path.
- [src/lib/auth.config.ts](src/lib/auth.config.ts) - `SESSION_CONFIG` (48h), consumed by BOTH NextAuth instances (Node + Edge) so the two cannot drift. Background: [docs/SESSION_ARCHITECTURE.md](docs/SESSION_ARCHITECTURE.md).
- [src/lib/auth-guards.ts](src/lib/auth-guards.ts) - `denyReviewer(session, { route })` (**`route` is required**), `denyFinance`, and the role sets `WRITE_ROLES` (an ALLOW-list since Sep 16, 2026), `REGISTRATION_DESK_ALLOW`, `WEBINAR_STAFF_ALLOW`, `ASSIGNABLE_USER_ROLES`.
- [src/lib/event-access.ts](src/lib/event-access.ts) - `buildEventAccessWhere()` + `accessUserFrom()`: the per-role event scoping every event-nested route must build its lookup from.
- [src/lib/db.ts](src/lib/db.ts) - the Prisma client, plus `tenantTransaction`, `dbOperator` (the privileged cross-tenant lane, import-gated by `check-tenant-als.sh`) and `classifyPrismaError`.
- [src/lib/email.ts](src/lib/email.ts) - `sendEmail()` is the ONE sender; also `getEventTemplate()`, the branding wrapper and CSS inlining. AWS SES is the only live provider.
- [src/lib/logger.ts](src/lib/logger.ts) - Pino. Exports `apiLogger` / `authLogger` / `dbLogger` / `eventLogger`.
- [src/proxy.ts](src/proxy.ts) - Next.js middleware (renamed from `middleware.ts` in Next 16.1): per-role route confinement.
- [src/hooks/use-api.ts](src/hooks/use-api.ts) - the client data layer, 168 React Query hooks.

### Where the obvious call is the wrong one

- `src/lib/email-preview-data.ts` - `buildRealPreviewOverrides(eventId)` — async real-data layer for email previews/test-sends (first session + Zoom passcode/recording state, abstract titles/count, a representative speaker's real presentationDetails, real login/review links). Run by BOTH preview routes in parallel with their event lookup; failure-isolated (samples still render). The module header documents which tokens deliberately STAY representative samples (per-recipient minted links, payment artifacts, un-issued serials, entryBarcode)
- `src/lib/email-change.ts` - Shared helpers for the dedicated Change Email flow: `normalizeEmail()` (trim+lowercase+Zod-validate) + `repointOrgContactEmail(tx, …)` (returns `"updated" | "merged" | "none"`; when a Contact at the target email already exists in the org, deletes the old row as a silent merge). Consumed by all three PATCH `/email` routes. **Rule: `email` is immutable on Speaker/Registration/Contact via general PUT** — callers must use the dedicated PATCH routes. The PUT handlers return 400 `EMAIL_IMMUTABLE` with a pointer rather than silently stripping the field.
- `src/lib/speaker-agreement.ts` - `buildSpeakerEmailContext()` (single source of truth for speaker email vars: title, prefixed name, presentation HTML/text blocks, **moderator run-sheet blocks** (`{{moderatorDetails}}` — sessions the speaker moderates with per-topic speakers/durations/computed times), sessions, topics, dates, tracks, roles) + `generateSpeakerAgreementDocx()` (mail-merges an uploaded .docx via `docxtemplater` v3 with `{token}` delimiters; returns null when no template configured; path-traversal guarded). Used by both the single-send speaker email route and the bulk-email pipeline
- `src/app/api/profile/route.ts` - Per-user GET/PATCH for `User.emailSignature` (HTML, max 10000 chars). **STAFF-ONLY since Aug 7, 2026** (`isTeamRole` gate on both verbs, refusals logged): the signature is appended to ORGANISER emails, so an org-null role (reviewer / submitter / registrant) could only ever store data that never renders. They edit their details on My Details or on their registration instead. Supersedes the original "every authenticated user regardless of role" rule
- `src/services/` - **Services layer (new — April 22, 2026).** Shared domain logic called by REST routes, MCP agent tools, cron workers, and (soon) external APIs. Errors-as-values result shape, already-typed inputs (no `string`→`Date` inside services), caller identity via `source: "rest" | "mcp" | "api"` written into `AuditLog.changes.source`. Service never imports from `next/server` — if it knew about HTTP, non-HTTP callers couldn't use it. See `src/services/README.md` for the full convention. **When extracting a new service, read the README first.** Services shipped: `accommodation-service`, `abstract-service`, `speaker-service`, `registration-service`, `promo-code-service`, `billing-account-service`, `payment-service` (refund + credit-note + cancel).
- `src/services/speaker-service.ts` - `createSpeaker()` — single-create path. Called by REST POST `/api/events/[id]/speakers` + MCP `create_speaker`. 3 error codes (EVENT_NOT_FOUND, SPEAKER_ALREADY_EXISTS, UNKNOWN). Normalizes empty-string optional fields to null as a last line of defense for direct-to-service callers. Bulk paths (`MCP create_speakers_bulk`, `/import-registrations`) intentionally NOT in this service — different mechanics.
- `src/services/payment-service.ts` - the money-movement service (July 8, 2026). `refundRegistration()` (full/partial, credit-note-gated, `refundedAmount` optimistic lock, Stripe partial or offline-record; 8 codes incl. CREDIT_NOTE_REQUIRED / LOST_LOCK / STRIPE_FAILED), `issueCreditNoteForRegistration()` (paid gate + amount cap via `createCreditNote`; 5 codes), and `cancelRegistration()` (refund-BEFORE-cancel: for a PAID reg with `refund:true`, auto-issue a full credit note + refund the remaining, then cancel — release seat via `planSeatTransition`/`releaseSeat` + release promo usage; refund failure ABORTS the cancel; 4 codes). Called by the refund / credit-notes / cancel routes (all delegate; auth + rate-limit + event-access + HTTP mapping stay in the route). Owns audit + admin notification + `refreshEventStats`. `src/services/registration-service.ts` - `createRegistration()` — single-create path. Called by REST POST `/api/events/[id]/registrations` + MCP `create_registration`. 9 error codes (EVENT_NOT_FOUND, TICKET_TYPE_NOT_FOUND, SALES_NOT_STARTED, SALES_ENDED, SOLD_OUT, PRICING_TIER_NOT_FOUND, ALREADY_REGISTERED with `meta.existingRegistrationId`, INVALID_PAYMENT_STATUS, UNKNOWN). Owns: atomic tx with duplicate-check-inside-tx + `soldCount` `updateMany` guard via typed `RegistrationServiceSentinel` class; paymentStatus defaulting (UNASSIGNED for paid / COMPLIMENTARY for free); the Phase 0 confirmation-email gate (`price > 0 && finalPaymentStatus ∈ OUTSTANDING_PAYMENT_STATUSES`) so MCP cannot skip the email silently; empty-string → null normalization on all optional attendee fields. Public register path (`/api/public/events/[slug]/register` — Stripe checkout + REGISTRANT account) and MCP bulk (`create_registrations_bulk`) intentionally NOT in this service.
- `src/lib/registrant-account.ts` - `ensureRegistrantAccount()` — the create-or-link REGISTRANT account block shared by the public `register` + token-gated `complete-registration` routes (was two byte-identical ~60-line copies). Existing user → link this reg + sweep sibling unlinked registrations on the same email + first-time-only terms stamp; else create a REGISTRANT (`isTrustedInternalEmail` org-attach, `needsEmailVerification` verify link, admin SIGNUP notify). **Failure-isolated by contract** (account creation must never block the registration — wrapped try/catch, logs `registrant-account:create-or-link-failed` at error) and **no-ops when no password** (guest registration). Each caller passes its own `signupMessage` wording. NOT the same concern as `registration-service` (which mints the registration row); this only handles the User account behind it.
- `src/lib/mcp-oauth.ts` - OAuth 2.1 service lib (RFC 7591 DCR + RFC 6749 authorization code + refresh_token grants + RFC 7009 revocation + mandatory PKCE S256). Core functions: `hashToken`, `verifyPkce` (timing-safe), `validateOAuthAccessToken` (hot path, fire-and-forget `lastUsedAt` update), `issueAuthCode`, `exchangeAuthCode` (transactional code→token swap), `exchangeRefreshToken` (rotates refresh, revokes old row), `revokeToken`, `registerClient`, `getClient`, `verifyClientSecret`. Tokens stored SHA-256 hashed, never in plaintext
- `src/app/api/cron/mcp-oauth-cleanup/route.ts` - Hourly cron (Bearer `$CRON_SECRET`) that deletes expired auth codes and tokens past a 7-day grace period

**MCP client caching caveat** — MCP clients (claude.ai web, Claude Desktop, n8n, etc.) cache the tool list at connection time. When this server adds or changes tools, **existing connected clients must disconnect and reconnect to see the changes**. Claude Desktop: fully quit and relaunch (Cmd+Q / Alt+F4 — window close isn't enough). claude.ai web: Settings → Integrations → disconnect the EA-SYS connector, then re-add. We bump `package.json` version (read into `serverInfo.version` by `mcp-server-builder.ts`) on every tool-changing deploy as a best-effort cache-invalidation hint, but client caching is spec-allowed behavior and can't be force-invalidated from the server side. Include this in user-facing release notes for any deploy that adds MCP tools.
- `src/lib/abstract-review.ts` - Sprint B aggregation helper — `computeSubmissionAggregates(abstractId)`, `computeWeightedOverallScore(items)`, `readRequiredReviewCount(settings)`, `consolidateReviewNotes(submissions)`; single source of truth for abstract score rollups across dashboard + MCP
- `src/lib/storage.ts` - File storage abstraction; `uploadMedia()` saves to `/uploads/media/{YYYY}/{MM}/`; `deleteMedia()` removes from storage + DB; three providers behind `STORAGE_PROVIDER`: `local` filesystem, `supabase`, and **`s3` (PRODUCTION since Sep 7, 2026: bucket `ea-sys-uploads`, ap-south-1, SSE-KMS CMK, versioned; keys are the stored path minus `/uploads/`, so the DB never changed; MAINT-002)**; 2MB limit with magic byte validation. **⚠ `deletePhoto()` must NOT be called directly by entity deletes** — photo paths are shared across rows; go through `deletePhotoIfUnreferenced()` (see next line, INC-004)
- `src/lib/photo-cleanup.ts` - `deletePhotoIfUnreferenced(url)` — the INC-004 guard (July 29, 2026): counts remaining references across Attendee + Speaker + Contact (the schema's three `photo` columns) and unlinks the file only at zero; never throws (a skipped unlink logs `photo-cleanup:still-referenced`; fail-safe — an orphan file is cheap, a destroyed shared file is data loss). Called by the speaker / registration / contact DELETE routes
- `src/lib/barcode.ts` - Code 128 rendering (`renderBarcodePng`, server-only — requires bwip-js) + QR rendering (`renderQrPng`, Aug 3 2026 — used for the DTCM compliance UUID, which is unscannable as Code 128 at badge width) + the entry-barcode serial-suffix pair (July 29, 2026): `entryBarcodeValue(qrCode, serialId)` → `{qrCode}-{serial padded 3}` encoded in every rendered barcode (badge/PNG/email) while the STORED qrCode stays bare, and `scannedEntryCodeCandidates(scanned)` → the lookup candidates so check-in accepts both forms (legacy + suffixed; DTCM values never stripped)

## Database Models

**[prisma/schema.prisma](prisma/schema.prisma) is the reference: ~150 models.** This section
cannot be a model list and does not try to be. It holds only the models whose BEHAVIOUR would
surprise you, where reading the columns is not enough to know how the thing works.

- **Event** - Events with status tracking; includes `eventType` (CONFERENCE/WEBINAR/HYBRID), `tag`, and `specialty` fields; `registrationWelcomeHtml` and `registrationTermsHtml` for public registration form content; `taxRate` (Decimal), `taxLabel`, and `bankDetails` for tax/payment configuration; `emailFromAddress` and `emailFromName` for per-event sender email; `badgeVerticalOffset` (Int) for badge print positioning; `speakerAgreementTemplate` (JSON `{ url, filename, uploadedAt, uploadedBy }`) is the pointer to an uploaded .docx mail-merge template used to generate per-speaker personalized agreement attachments. **`settings` JSON** holds feature-specific configs: `settings.webinar` (webinar auto-provision config), `settings.sponsors` (LEGACY: promoted to the `Sponsor` TABLE on Sep 2, 2026. Every application read now goes through [src/lib/sponsors.ts](src/lib/sponsors.ts); `readSponsors()` in `src/lib/webinar.ts` is the superseded JSON reader kept for the reconcile script. `readWebinarSettings()` is unaffected)
- **TicketType** - Registration type configurations (displayed as "Registration Types" in UI); `ticketTypeId` is the single source of truth — `attendee.registrationType` is auto-synced; `virtualPrice` (Decimal?, nullable) is the flat price charged when a registrant picks VIRTUAL attendance on a HYBRID event (null ⇒ virtual uses the in-person `price`; pricing tiers apply to in-person only in v1); **`requiresDocument` / `documentRequired` / `documentLabel` / `documentInstructions`** are the per-type supporting-document policy (Aug 13, 2026) that replaced the `/resident|trainee/i` name match — the two booleans stay separate so "ask but do not block" remains expressible; see [supporting-document.ts](src/lib/supporting-document.ts). **`isFaculty` (Boolean, default false)** marks the auto-provisioned hidden "Faculty" type that backs speaker companion registrations — **hidden from public registration** (filtered out of the public ticket list + the register POST) and **excluded from delegate-focused counts/stats** via `EXCLUDE_FACULTY_WHERE` in [src/lib/faculty-filter.ts](src/lib/faculty-filter.ts) (operational surfaces — badge/check-in/survey/DTCM — deliberately keep faculty)
- **Registration** - Event registrations; `userId` (nullable FK) links to User for registrant self-service; `paymentStatus` includes `COMPLIMENTARY` for admin-set comp registrations and `INCLUSIVE` for sponsor-paid (requires `sponsorId`); `sponsorId` (nullable) is a real FK to the `Sponsor` table (`onDelete: SetNull`; the inline schema comment saying otherwise is itself stale) — preserved on payment-status flips away from INCLUSIVE so the historical attribution survives a revert; `pricingTierId` (nullable FK to `PricingTier`) captures which sales window the registration falls under for finance reporting; `billingState` and `billingZipCode` for invoice/billing; `termsAcceptedAt` (DateTime) records when registrant accepted T&C; `refundedAmount` (Decimal, default 0) is the **running total refunded** (partial refunds accumulate; the reg stays PAID while `0 < refundedAmount < paidTotal`, flips to REFUNDED only when fully refunded — see the gated-partial-refund feature); `attendanceMode` (enum `AttendanceMode` IN_PERSON|VIRTUAL, default IN_PERSON) — only a choice on HYBRID events; VIRTUAL ⇒ no qrCode/badge/DTCM, uncapped (skips `soldCount`), priced via `TicketType.virtualPrice`, and the confirmation email swaps the barcode for a "joining instructions will be sent" message. **`createdSource` (enum `RegistrationCreatedSource`)** tags the entry path; **`SPEAKER_COMPANION`** marks the auto-created companion registration backing a Speaker (the "attendee facet" — comp, on the `isFaculty` ticket type, qrCode minted, badge "Faculty", no `soldCount`). A speaker's companion is linked via `Speaker.sourceRegistrationId` and gives the speaker badge/barcode/DTCM/check-in/survey through the normal machinery — see [src/lib/speaker-companion.ts](src/lib/speaker-companion.ts) + [docs/SPEAKER_AS_ATTENDEE_PLAN.md](docs/SPEAKER_AS_ATTENDEE_PLAN.md)
- **Speaker** - Event speakers; includes `title` (Title enum), `photo`, `city`, `state`, `zipCode`, `country`, `specialty`, and `registrationType` fields; `specialty` is set during submitter registration and editable from dashboard; speakers can be added manually, via CSV import, or imported from the event's registrations. **A Speaker is a first-class, independent entity — it does NOT require a registration** (sponsor/society-suggested faculty are typically manually added and never register). `sourceRegistrationId` (nullable FK → Registration, `SetNull`) is an **optional** pointer set only on the import-registrations path; it lets the speaker's Activity timeline surface the linked registration's activity (pointed, not duplicated) and is **null** for independent speakers. Future "unify Speaker/Registration into one Person identity" is a roadmap item, constrained to `Speaker → Person?` (optional) so independent speakers never break.
- **EventSession** - Schedule sessions; session times validated against event dates; supports session-level roles via `SessionSpeaker` and per-topic speakers via `SessionTopic`/`TopicSpeaker`; **`type` (enum `SessionType`, default SESSION)** — non-SESSION values (REGISTRATION/BREAK/LUNCH/NETWORKING) are **break items**: plain agenda time blocks that may never carry speakers/topics/abstract/Zoom (service-enforced `BREAK_ITEM_HAS_PROGRAM`), render as muted bands, have no public detail page, and are excluded from session counts
- **AbstractTheme / AbstractSubTheme** - Per-event submission categories, two levels. A theme is required to submit ONLY when the event has themes; a sub-theme ONLY when the CHOSEN theme has sub-themes (conditional by necessity — an absolute rule would make submission impossible on an event with none, and event-wide keying would make adding sub-themes to one theme demand them on all). Rules live in [src/lib/abstract-theme-requirement.ts](src/lib/abstract-theme-requirement.ts), shared by the 3 submit forms + both write routes. Sub-themes ride nested inside `GET /abstract-themes` (no list endpoint) so both dropdowns read one source; `@@unique([themeId, name])`, theme→sub cascade, `Abstract.subThemeId` SET NULL with an application-level refuse-while-in-use guard
- **WebinarPoll** / **WebinarPollResponse** - Polls pulled from Zoom's `/report/webinars/{id}/polls`. Collapsed to **one logical poll per webinar** — Zoom's report returns a flat list of (participant, question, answer) tuples with no poll-id field, so we can't distinguish multiple polls. `WebinarPoll` has nullable `zoomPollId` + title + JSON question list; `WebinarPollResponse` has one row per participant submission with JSON answers map. Responses use replace-all strategy (deleteMany + createMany in a transaction) since Zoom doesn't give stable submission ids
- **WebinarPresence** (June 23, 2026) - **Real-time** lobby/live presence of registered webinar attendees on our gated session page (heartbeat-driven), one row per `(sessionId, registrationId)` (`@@unique`); `eventId`, `firstJoinedAt`, `lastSeenAt`, `joinCount`, `phase` (`"lobby"|"joined"`). "Who's here now" = rows with `lastSeenAt` in the last 60s. Written by `POST .../sessions/[id]/presence` as an `upsert` (no transaction, escalate-lobby→joined-only). **This is OUR-page presence — distinct from the authoritative post-event `ZoomAttendance`.** Paired with a write-once `Registration.webinarFirstJoinedAt` (the durable "Joined" badge). Kept off the hot `Registration` row to avoid lock/vacuum churn
- **RsvpCampaign / RsvpItem / RsvpInvite / RsvpResponse** (July 8, 2026; generalized August 14, 2026, migration `20260814120000`). **`RsvpCampaign` = ONE RSVP** — a gala dinner, a set of parallel workshops, a site visit. An event runs several, each owning its own options AND its own guest list. Carries `name`, `description?`, `selectionMode` (`RsvpSelectionMode` SINGLE/MULTI), `allowGuests`, `collectDietary`, `isActive`, `sortOrder`. `RsvpItem` = one thing to say yes to (`campaignId`, `name`, `startsAt`, `location?`, `rsvpDeadline?`, `isActive`). `RsvpInvite` = one invited person **per campaign** (unique `token`, name/email, soft-ref `registrationId?`/`speakerId?`, `dietary?`, `status` PENDING/RESPONDED), **`@@unique([campaignId, inviteeEmail])`** — the load-bearing line: it was `([eventId, inviteeEmail])`, which meant a person held ONE invite per event, so a dinner list and a workshop list could not coexist. A person on two RSVPs holds **two invites and two links** (deliberate: separate deadlines, separate chase cycles, and one hub link would re-expose the dinner list). `RsvpResponse` = the per-item answer (`attending`, `guestCount`), `@@unique([inviteId, itemId])`. **⚠ The physical tables keep the old names via `@@map`** (`RsvpItem`→`RsvpDinner`, `RsvpResponse`→`RsvpDinnerResponse`, `startsAt`→`dinnerAt`, `itemId`→`dinnerId`) because an `ALTER TABLE ... RENAME` is not blue/green safe. See [docs/RSVP.md](docs/RSVP.md).
- **Employee / LeaveCode / AttendanceEntry / AttendanceRule / LeaveGrant / PublicHoliday** - The HR module (master silo only, `HR_MODULE_ENABLED`). Every table carries `organizationId` and an RLS policy in `prisma/rls/` from day one, because a flag flips in a deploy and a tenant-blind data shape cannot. Calendar columns are `@db.Date`, and in code a date is a **`YYYY-MM-DD` string, never a `Date`** (`getDay()` answers in the reader's timezone). **`AttendanceEntry` holds only the days that CARRY INFORMATION** — an ordinary working day has no row; the effective status is derived by [hr-effective-status.ts](src/hr/lib/hr-effective-status.ts), which is the ONE place precedence lives (not-employed → explicit entry → public holiday → weekend → standing rule → assumed P). **`AttendanceRule`** (scope ORG or EMPLOYEE, date range, code, reason) is a standing statement that **stores no days at all**: 252 of 386 imported work-from-home days were twelve company-wide dates and 120 more belonged to one permanently remote person, so 386 rows were holding 27 facts. Creating a rule writes nothing per person and deleting one removes nothing, which is what makes it reversible. A rule can carry any leave code, so **both balance paths expand rules** or a company-wide shutdown booked as AL would be invisible to payroll. `LeaveGrant` records what was carried into a leave year (`Employee.carryoverDays` is only the pre-go-live seed and is never overwritten, so last year's closing balance stays recomputable). Naming trap: **`-HD` means half DAY, `SL-H` means half PAY.**

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
ADMIN_DOC_LINKS_ENABLED="true"        # master only: org ADMINs may open /admin/docs/<path> shared links (unset = SUPER_ADMIN only)
STORAGE_PROVIDER="s3"                 # "local" (default) | "supabase" | "s3". PRODUCTION is s3 (since Sep 7, 2026)
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
| Mobile refresh (per IP) | 30 | 1 hr |
| Login FAILURES per email (every login door; successes not counted) | 10 | 15 min |
| Login FAILURES per IP (every login door; successes not counted) | 100 | 15 min |

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

- **HR_USER** - Org-bound **HR role, CONFINED to the HR module** (attendance + UAE leave). Added August 27, 2026 (additive enum migration `20260827120000_add_hr_user_role`). Modeled directly on CRM_USER: it can fully work HR — employees, attendance, standing rules, leave balances, holidays, leave codes — and sees **nothing else**: no events, registrations, speakers, invoices, contacts or settings. **The module itself is gated by `HR_MODULE_ENABLED`** ([module-flags.ts](src/lib/module-flags.ts)), master silo only; with the flag unset the routes 404 for everyone including this role. Enforced in depth: (1) **Event access** — [buildEventAccessWhere](src/lib/event-access.ts) returns `{ id: { in: [] } }` (zero events). (2) **API** — in `denyReviewer`'s restricted set (absent from `WRITE_ROLES`, so blocked from every non-HR write); the `/api/hr/*` routes gate via their own `denyNonHr` → `canViewHr`/`canWriteHr` in [hr-roles.ts](src/hr/lib/hr-roles.ts), which **refuses API keys** (HR is a per-person surface, and elsewhere a key is admin-equivalent). (3) **Middleware** ([src/proxy.ts](src/proxy.ts)) — confines it to `/hr`. (4) **UI** — sidebar shows only the HR entry. Org-bound team member (`TEAM_ROLES`), invited from **Settings → Users**. **The expensive part of adding it was the sweep, not the enum value**: the write guard was then `RESTRICTED_WRITE_ROLES`, the ONE deny-list among the role predicates, so a role absent from it could write to every non-HR route while every other predicate (`FINANCE_ROLES`, `BARCODE_ROLES`, `canViewContacts`, login-visibility, registration-export) was an allow-list that excluded a new role for free. **INVERTED Sep 16, 2026**: it is now `WRITE_ROLES`, an allow-list, so an unrecognised role fails CLOSED. Every predicate is an allow-list today; see [auth-guards.ts](src/lib/auth-guards.ts). **Note the population:** HR holds colleagues' sick-leave records, which is health-adjacent personal data about named employees — see [docs/HR_MODULE_PLAN.md](docs/HR_MODULE_PLAN.md) §10.
- **WEBINARS** - Org-bound **webinar team** (added August 4, 2026; owner spec: "ONSITE role + webinar full control, not organizer"). **TWO-TIER access** (tier 2 widened Aug 10, 2026 — see below): **(1)** ALL of the org's **WEBINAR-type events** — **full organizer-grade control**, automatically (no assignment): create webinar events (the events POST hard-refuses any other type with 403 `WEBINAR_ONLY` — no silent coercion), registrations (incl. delete/bulk/imports), communications (bulk email, schedules, templates, previews, email activity/logs), the whole Webinar Console, sessions/agenda/tracks/Zoom, speakers, registration types/tiers, media, sponsors, survey, content + event settings (event PUT). **(2)** Non-webinar events — **MEMBER parity: it sees EVERY event in the org and holds the registration desk on all of them** (view the list, add a registration, check in, print badges, record payments). **Aug 10, 2026 (owner: "they are internal users but they see limited data") this replaced the old per-event `Event.settings.onsiteUserIds` assignment**, which no longer affects this role at all — the Onsite Staff tab still accepts WEBINARS accounts (harmless, now redundant; ONSITE still needs it). The change cost one line because the two roles' write guards were ALREADY identical — both absent from `WRITE_ROLES` (then `RESTRICTED_WRITE_ROLES`), both in `REGISTRATION_DESK_ALLOW`, both in `FINANCE_ROLES` — so event scope was the only thing separating them. **Not yet at full MEMBER parity:** the ~59 event GETs (agenda/sessions, speakers, tickets, analytics) still resolve on the manage surface, so a conference's agenda 404s; widening them is the deferred read sweep in ROADMAP §"WEBINARS MEMBER-parity read sweep". **First one moved (Sep 8, 2026):** the registrations `tags` GET now resolves on the desk surface, because the list it feeds already did and a WEBINARS user on a conference got the rows with a 404 behind them (eight prod warnings in one minute while an organiser was temporarily on that role); pinned with the real builder in `event-tags-desk-surface.test.ts`. **Blocked:** org-level surfaces (org settings/users write, API keys, CRM, contacts — `canViewContacts` false, sign-in activity), refunds/credit-notes/cancel (money movement stays ADMIN/ORGANIZER), certificates (v1), reimbursements, AI agent, event DELETE, clone, promo codes (webinar-hidden module anyway). **Predicates:** IN `FINANCE_ROLES` (desk records payments — ONSITE parity), `BARCODE_ROLES` (badge printing), `ZOOM_HOST_ROLES` (**holds Zoom host credentials — the producer role**), registration-export; in `TEAM_ROLES` (Settings → Users invite, "Webinars" label, violet badge). **Enforcement architecture (fail-closed):** WEBINARS is in `denyReviewer`'s restricted set — every capability is an explicit opt-in via `denyReviewer(session, { allow: WEBINAR_STAFF_ALLOW })` **ALWAYS paired with** a `buildEventAccessWhere` event lookup, whose WEBINARS branch resolves ONLY `{ organizationId, eventType: "WEBINAR" }` (manage surface, the default) — so a route that opts the role in but keeps a hand-rolled org-scoped lookup would fail open on conferences: **never do that** (the invariant is documented on `WEBINAR_STAFF_ALLOW` in [auth-guards.ts](src/lib/auth-guards.ts)). Desk routes (registrations list/create/detail/check-in/badges/payments/activity + the events list/detail GET) pass `buildEventAccessWhere(..., { surface: "desk" })`, which since Aug 10, 2026 widens ONLY this role's resolution to **every event in the org**. **The manage surface deliberately did NOT follow, and must not:** ~55 route files sit behind `WEBINAR_STAFF_ALLOW`, so widening the default would open all of them on conferences in a single edit — pinned by a mutation-verified test. A missed route = 403/404 (feature gap), never a leak. ~45 route files swept; scheduled-email row mutations bind through `event: buildEventAccessWhere(...)` relation wheres; speakers POST carries a route-level access pre-check because the service's internal event check is org-only. Middleware confines the UI to `/events*` (incl. `/events/new`) — `/settings`, `/logs`, `/contacts`, `/crm`, `/admin`, `/dashboard` redirect to `/events`; sidebar is two-tier (webinar event → full module set through `webinarModuleFilter`; conference → Registrations + Check-In pair; loading → blank). 16-test matrix in [webinars-role-isolation.test.ts](__tests__/api/webinars-role-isolation.test.ts) (two-tier where shapes, allow-list matrix, predicate truth table, WEBINAR_ONLY create gate). **Adversarial review same day (0 BLOCKER / 2 HIGH / 3 MED / 5 LOW) — all HIGHs+MEDs + L-4 shipped in-band:** H-1 the **org-wide invoice ledger** (`/api/invoices` + export) explicitly refuses WEBINARS (finance-capable ≠ org-ledger access; `/invoices` added to the proxy block list; also fixed the routes' stale "MEMBER/ONSITE barred" doc-drift); H-2 the scheduled-email PATCH/DELETE/retry **primary `updateMany` writes** now bind through `event: buildEventAccessWhere(...)` (they were org-scoped with the builder only on the fallback read — the exact invariant-violation class); M-1 `/api/email-logs` + body are **desk-confined** for WEBINARS and refuse CONTACT/USER/OTHER entity types (the CONTACT allowance was a side-door around its contacts exclusion); M-2 the event PUT refuses an `eventType` flip for WEBINARS (two-step bypass of the create gate); M-3 the registrations page + detail sheet render the **desk-limited UI** for WEBINARS on non-webinar events (`isDeskOperator` widened); **L-4 (owner-acked): registration DELETE reverted to ADMIN/ORGANIZER** — no refund powers ⇒ no row deletion, even on its own webinars. +7 route-level pins in [webinars-role-regression-matrix.test.ts](__tests__/api/webinars-role-regression-matrix.test.ts) (the H-2 class is now a failing test, not a review find). Deferred L-1/L-2/L-5 + a `WEBINAR_STAFF_ALLOW`⇒`buildEventAccessWhere` CI grep-gate in ROADMAP §"WEBINARS role review". Migration `20260803190000_add_webinars_role` (additive enum).

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

- **Live streaming (MediaMTX)** — Self-hosted RTMP→HLS media server, the **second live-video path** alongside the Zoom SDK embed. **Why it exists:** the `ZoomWebEmbed` path makes every viewer a Zoom meeting participant (counts against the org's Zoom capacity/seat limits, heavier client, interactive). For a large broadcast-only audience that just needs to *watch*, that's the wrong tool — so a session can instead enable one-way live streaming where the host pushes a **single** RTMP feed and unlimited attendees watch a one-way HLS stream at near-zero marginal cost, no Zoom seat per viewer. **What it is:** `bluenviron/mediamtx` (open-source single-binary media server: RTMP/HLS/WebRTC/RTSP) running as the `ea-sys-mediamtx` Docker container on the same EC2 box (NOT on Zoom's infra — note this contradicts an outdated line in `docs/ZOOM_INTEGRATION.html` that says all streaming runs on Zoom; that's true only for the embed path). **Flow:** session with `ZoomMeeting.liveStreamEnabled` + `streamKey` → host streams to `rtmp://{host}:1935/live/` with the stream key (via Zoom's "Stream to Custom Live Streaming Service" or OBS) → MediaMTX ingests on :1935, remuxes to HLS (mpegts, 7×2s segments, see [mediamtx.yml](mediamtx.yml)) → nginx proxies `/stream/` → MediaMTX :8888 → public [LivePlayer](src/components/zoom/live-player.tsx) plays `{appUrl}/stream/live/{streamKey}/index.m3u8`. **Status:** [stream-status route](src/app/api/public/events/%5Bslug%5D/sessions/%5BsessionId%5D/stream-status/route.ts) (public, 360/hr per IP) probes the MediaMTX HLS endpoint (`MEDIAMTX_HLS_URL` env, defaults `http://localhost:8888`) to detect live/idle/ended and flips `ZoomMeeting.streamStatus` (IDLE→ACTIVE→ENDED); the player polls it. Port 8889 (WebRTC) is reserved for a future low-latency path, currently unused. Admin sees RTMP URL / stream key / HLS URL / attendee page in the `StreamingInfoCard` on the session Zoom form. The nginx `/stream/` → `:8888` proxy is in `deploy/nginx.conf`, which since Sep 24, 2026 is the live box file itself (see `deploy/NGINX.md`). Schema fields on `ZoomMeeting`: `liveStreamEnabled`, `streamKey`, `streamStatus`. Docs at `docs/LIVE_STREAMING.md` / `.html`.

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

One line each: what the document is, and when to read it. **The document itself is the
detail; the CODE is the truth.** A status word here ("BUILT", "PLANNED") describes the
DOCUMENT as written, not the current state of the system, so check `src/` before relying
on it. Until September 2026 this section carried ~43 KB of per-document summaries, which
were a second copy of each document and had drifted from both the docs and the code.

- `AGENTS.md` (repo root) - The invariants file (July 14, 2026). Short, durable orientation for *any* AI coding agent — the cross-tool convention (Codex / Cursor / Copilot / Zed auto-load a root-level `AGENTS.md`).
- `docs/DOMAIN_MAP.html` - The context-reload index (July 13, 2026). Read this FIRST when touching an unfamiliar domain.
- `docs/BUDGET_PROCUREMENT_MODULE.html` - Budget & Procurement Module spec, rev. 3.6 (Sep 10, 2026). This is the SPEC; the MODULE IS BUILT AND LIVE IN PRODUCTION (since Sep 14, 2026, gated by `PROCUREMENT_MODULE_ENABLED`).
- `docs/BUDGET_PROCUREMENT_BUILD_PLAN.md` - Budget & Procurement build plan (Sep 10, 2026). This is the PLAN; the module shipped from Sep 14, 2026 onward.
- `docs/SPEND_REQUEST_E2E_VERIFICATION.html` - The spend request walkthrough, screen by screen (re-captured Sep 24, 2026 on the current build, 97 screens): budgets, suppliers, requests, orders, receiving, cancelling, currencies, close-out, the slow-approver reminders and the PO PDF. `SPEND_REQUESTS_WALKTHROUGH.html` is now a pointer to it.
- `docs/CRM_STATUS.html` - CRM live status board (July 14, 2026). The page to read — and to KEEP CURRENT — for anything CRM.
- `src/crm/README.md` - The CRM module developer entry point. The file to read before touching anything under `src/crm/`: scope (what's in/out of v1), the code layout.
- `docs/CRM_MODULE_PLAN.md` - CRM module assessment + implementation blueprint — IN BUILD (un-parked July 14, 2026; was PARKED July 13).
- `docs/FROM_SCRATCH_REBUILD.md` - Full production-box rebuild runbook (July 13, 2026). The ordered checklist for standing up a replacement EC2 from nothing: IAM role (all 3 inline policy JSONs snapshotted), SG ports (incl. the oft-forgotten 1935 RTMP).
- `deploy/NGINX.md` - The ONE nginx site config (`deploy/nginx.conf` = the live box file, Sep 24, 2026) and how to change it: edit the box, `nginx -t`, reload, `npm run nginx:drift` (read-only SSM diff), copy into the repo. Also the pending nginx-owns-compression step.
- `docs/INCIDENTS.md` - Incident log & outage post-mortems (INC-001: on-box `docker build` froze the swapless t3.large) + a reusable "how to diagnose a frozen box" appendix.
- `docs/CI_PIPELINE.html` - CI/CD pipeline reference + GitHub-VM capacity menu (July 22, 2026). The post-split `deploy.yml` shape (parallel `checks`/`tests`/`build` → `build-push` → `deploy`; non-gating `tenancy` + `sourcemaps` beside).
- `docs/ROLLBACK.md` - Rollback runbook (July 10, 2026; code path DRILLED on prod July 14, 2026 — it works).
- `docs/DDOS_RESPONSE_PLAN.md` - DDoS incident runbook (Aug 3, 2026) — the *during-the-incident* half of the security posture (AWS_OPERATIONS §4 is the static half): the 4-scenario triage table (organic rush vs few-IP abuse vs distributed L7 vs volumetric —…
- `docs/AWS_OPERATIONS.md` - Master AWS CLI runbook — daily ops (SSM access, instance health, CloudWatch logs, SES, S3) + performance troubleshooting (CPU/memory/disk spikes, the t3 CPU-credit-throttle trap, which-container triage, DB pool exhaustion.
- `infra/dr/README.md` - Disaster-recovery deep runbook (Singapore break-glass box, surgical recovery, promotion/return)
- `infra/cloudwatch/README.md` - CloudWatch agent setup + Insights queries + alarm pipeline
- `docs/runbook-ses.md` - SES email runbook (sender verification, DMARC, bounce triage)
- `docs/DEVELOPMENT_STATUS.md` - Feature status and roadmap
- `docs/CODEBASE_SIZE_BY_DOMAIN.md` - Route and file counts per domain (Sep 8, 2026). Derived from the tree (345 API route files, ~1,070 source files at `ded1c939`), bucketed into the domain map's domains with the first-match caveat stated.
- `docs/DEPENDENCY_LOG.md` - Dependency log (Sep 7, 2026). Every dependency change that reached `main`, newest first: what moved, why, the exposure reasoning for security bumps, how it was verified (each entry names the e2e baseline it was diffed against.
- `docs/PLATFORM_DECISIONS.md` - The 8-item pre-platform decision round (Aug 4, 2026) — the single revisit point for what remains before the platform instance can launch.
- `docs/MULTI_TENANCY.md` - Forward-looking multi-tenant / white-label SaaS reference (NOT shipped — EA-SYS is single-org today). §0 topology DECIDED July 22, 2026: the two-silo plan — master (current box, MM Group only.
- `docs/MULTI_TENANCY_IMPACT.md` - Codebase-grounded Impact & Blast-Radius assessment (companion to MULTI_TENANCY.md; June 24, 2026, from a 3-lens read-only audit; §7/§8 recast July 22.
- `docs/RSVP.md` - Dinner RSVP feature (2026-07-08). Per-dinner RSVP with a personalized token link covering all the event's dinners; organizer console (manage dinners, import from Registrations/Speakers, roster + per-night headcount tiles + CSV.
- `docs/TRAVEL_GRANT.md` - Travel Grant reference (2026-08-25) — PARTIALLY BUILT. An abstract author based OUTSIDE the UAE is offered a travel grant.
- `docs/TRAVEL_GRANT_PLAN.md` - Travel Grant plan + decision record (2026-08-25). The nine locked owner decisions (D1 eligibility-and-interest only with nothing financial · D2 one record per person per event · D3 a block in the existing confirmation email…
- `docs/TRAVEL_GRANT_COUNTRIES_PLAN.md` - Making the exempt country configurable — PLANNED, NOT BUILT (2026-08-25). `classifyResidency()` has the UAE hard-coded, which is a customer's geography baked into a shared feature and wrong for every tenant except MM Group —…
- `docs/COMMITTEE_MEMBERS.md` - Design decision record: how committee members are modeled (2026-07-08). Committee = a tag (`committee` + optional `committee-organizing`/`committee-scientific`).
- `docs/GROUP_REGISTRATION_PLAN.md` - Group registration blueprint — PLANNED, NOT BUILT (July 30, 2026; refreshed Aug 6, 2026 against the post-tenancy-sweep codebase — owner: "refresh the plan, hold the build").
- `docs/MULTI_CURRENCY_PLAN.md` - Pricing in USD / AED / EUR, currency set at the EVENT level: PLANNED, NOT BUILT (Aug 12, 2026).
- `docs/HR_MODULE_PLAN.md` - HR module (attendance + UAE leave tracker): the PLAN. The MODULE IS BUILT (Aug 27, 2026; `src/hr/`, `/api/hr/*`, gated by `HR_MODULE_ENABLED`).
- `docs/PER_TYPE_DOCUMENT_UPLOAD_PLAN.md` - Organizer ticks a box per registration type to demand a supporting document — BUILT Aug 13, 2026 (planned + shipped same day; header records 3 deviations from the plan and why).
- `docs/SPONSOR_ATTRIBUTION_PLAN.md` - Sponsors, their promo codes, and reporting what they brought. PHASE 1 SHIPPED Sep 2, 2026 (`529e490a`); phases 2 and 3 not started, see [ROADMAP](docs/ROADMAP.md) §"Sponsor attribution".
- `docs/MULTI_SURVEY_PLAN.md` - Several surveys per event, one of them the certificate survey: PLANNED, NOT BUILT (revived Sep 17, 2026; parked Aug 7).
- `docs/CUSTOM_ROLES_PLAN.md` - Customizable roles: permission-based access for org staff. PLANNED, NOT BUILT (Sep 15, 2026; owner: "no longer WEBINARS and MEMBER, completely customizable").
- `docs/ROLES_AND_PERMISSIONS.md` - The per-role permission matrix (Sep 21, 2026), verified against the code and pinned by `roles-and-permissions-doc.test.ts`.
- `docs/CLAUDE_AI_AGENT_GUIDE.md` - One-page team guide to using EA-SYS from claude.ai (Sep 21, 2026), written for the events team, not developers.
- `docs/AGENT_ARCHITECTURE_REVIEW.md` - Event Agent architecture review: one agent, two doors (Sep 21, 2026); all five phases SHIPPED the same day (Phase 4, the deletion of the hand-written definitions, last).
- `docs/PROCUREMENT_ROLES_PLAN.md` - Custom roles for Budget & Procurement: BUILT Sep 16, 2026, on main (planned Sep 15; kept as the design record).
- `docs/IDENTITY_AND_ROLES.md` - Operator runbook: "one person, many hats." The two-layer identity model (event-scoped *facets* — speaker/registration/badge/abstract — stack freely by email and never duplicate.
- `docs/ZOOM_INTEGRATION.html` - Zoom SDK integration guide (architecture, setup, file list)
- `.env.example` - Environment variable template. **NOT tracked by git** (`.gitignore` ignores `.env*`), so a fresh clone will not have it.
