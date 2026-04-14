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

```
src/
├── app/
│   ├── (auth)/              # Auth pages (login, accept-invitation)
│   ├── (dashboard)/         # Protected dashboard pages
│   │   ├── dashboard/       # Main dashboard
│   │   ├── events/          # Event management
│   │   │   └── [eventId]/   # Single event pages
│   │   │       ├── registrations/
│   │   │       ├── speakers/
│   │   │       ├── schedule/
│   │   │       ├── accommodation/
│   │   │       ├── tickets/
│   │   │       ├── abstracts/
│   │   │       ├── reviewers/
│   │   │       ├── communications/ # Centralized event email sending
│   │   │       ├── content/        # Standalone registration & abstract text editors
│   │   │       └── settings/
│   │   └── settings/        # Organization settings
│   ├── e/                   # Public event pages (no auth)
│   │   └── [slug]/          # Redirects to /e/[slug]/register
│   │       ├── register/    # Submitter registration form (public)
│   │       ├── submitAbstract/ # Abstract submission form (public, post-login)
│   │       ├── complete-registration/ # Token-gated completion form for CSV-imported registrants
│   │       └── confirmation/
│   ├── uploads/             # Static file serving for uploaded photos
│   │   └── [...path]/       # Catch-all: streams files from public/uploads/
│   └── api/                 # API routes
│       ├── auth/            # Auth endpoints
│       ├── events/          # Event CRUD (protected)
│       │   └── [eventId]/   # Event-specific endpoints
│       ├── mcp/             # MCP server HTTP transport
│       │   ├── route.ts     # Streamable HTTP (POST/GET with session state)
│       │   └── sse/         # SSE compat redirect
│       ├── media/           # Media library (GET list, POST upload, DELETE by id)
│       ├── organization/    # Organization endpoints
│       ├── upload/          # File upload endpoints
│       │   └── photo/       # Photo upload (POST, auth required)
│       └── public/          # Public API (no auth required)
│           └── events/[slug]/ # Public event details & registration
├── components/
│   ├── layout/              # Header, Sidebar
│   └── ui/                  # Shadcn/ui components
├── contexts/                # React contexts
├── hooks/                   # React hooks
│   └── use-api.ts           # React Query hooks for API calls
├── mcp/                     # MCP server (Model Context Protocol)
│   ├── server.ts            # MCP server with tool definitions and stdio transport
│   └── remote-client.ts     # Remote client utilities
├── lib/                     # Utilities
│   ├── auth.ts              # NextAuth configuration
│   ├── auth-guards.ts       # Role-based access guards (denyReviewer)
│   ├── db.ts                # Prisma client
│   ├── email.ts             # Brevo email service
│   ├── event-access.ts      # Event scoping by role (buildEventAccessWhere)
│   ├── logger.ts            # Pino logger
│   └── utils.ts             # Helper functions
└── types/                   # TypeScript types
```

## Key Files

- `prisma/schema.prisma` - Database schema
- `src/lib/auth.ts` - Authentication configuration
- `src/lib/auth-guards.ts` - `denyReviewer()` guard for API route protection (blocks REVIEWER + SUBMITTER)
- `src/lib/event-access.ts` - `buildEventAccessWhere()` for role-scoped event queries
- `src/lib/email.ts` - Email templates, sending, branding wrapper, CSS inlining
- `src/lib/email-utils.ts` - Client-safe email utilities (stripDocumentWrapper)
- `src/lib/countries.ts` - ISO 3166-1 country list (249 countries)
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
- `src/lib/schemas.ts` - Shared Zod schemas (titleEnum) used across API routes
- `src/components/forms/person-form-fields.tsx` - Shared form fields for attendees/speakers/contacts
- `src/app/api/upload/photo/route.ts` - Photo upload endpoint with validation
- `src/app/uploads/[...path]/route.ts` - Static file handler for uploaded photos (streams from public/uploads/)
- `src/middleware.ts` - Route-level REVIEWER/SUBMITTER redirects
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
- `src/app/api/events/[eventId]/webinar/route.ts` - GET/PUT/POST webinar settings + manual re-provision
- `src/app/api/events/[eventId]/webinar/sequence/route.ts` - GET/POST webinar email sequence management
- `src/app/api/events/[eventId]/webinar/recording/fetch/route.ts` - POST manual recording refetch
- `src/app/api/events/[eventId]/webinar/attendance/route.ts` - GET attendance KPIs + rows + CSV export; POST manual sync
- `src/app/api/events/[eventId]/webinar/engagement/route.ts` - GET polls + Q&A; POST manual sync
- `src/app/api/events/[eventId]/webinar/panelists/route.ts` - GET/POST/DELETE panelists; exports `resolveAnchorZoomMeeting()` helper for sibling routes
- `src/app/api/events/[eventId]/webinar/panelists/sync-speakers/route.ts` - POST batch import from `SessionSpeaker[]`, dedup'd against existing Zoom panelists
- `src/app/api/cron/webinar-recordings/route.ts` - Cron worker (every 5 min) for recording retrieval
- `src/app/api/cron/webinar-attendance/route.ts` - Cron worker (every 10 min) for attendance sync; chains `syncWebinarEngagement()` per-row for polls + Q&A
- `src/mcp/server.ts` - MCP server with 30+ tools across events, registrations, speakers, sessions, abstracts, hotels, media; stdio + HTTP transports; API key auth with rate limiting (100 req/hr)
- `src/app/api/mcp/route.ts` - Streamable HTTP transport for MCP (POST/GET with `Mcp-Session-Id` session state, 30-min TTL); used by n8n and other MCP clients
- `src/app/(dashboard)/my-registration/page.tsx` - Registrant self-service portal (view/edit registrations, payment status)
- `src/app/api/registrant/registrations/route.ts` - Registrant self-edit API (GET list, PUT attendee details with ownership check)
- `src/app/api/events/[eventId]/registrations/bulk-type/route.ts` - Bulk update registration type (PATCH, adjusts soldCounts + syncs attendee.registrationType)
- `src/lib/default-terms.ts` - Default registration terms & conditions HTML
- `src/components/speakers/speaker-detail-sheet.tsx` - Speaker detail slide-out sheet (used from speakers list for quick view)
- `src/components/contacts/contact-detail-sheet.tsx` - Contact detail slide-out sheet with gradient header, 2-col layout, inline edit
- `src/components/org-theme.tsx` - Dynamic org theme provider (applies primaryColor from organization settings)
- `src/lib/org-context.ts` - Organization context for client-side org data access
- `src/lib/notifications.ts` - Notification helpers (`createNotification`, `notifyEventAdmins`); types: REGISTRATION, PAYMENT, ABSTRACT, REVIEW, CHECK_IN, SIGNUP
- `src/lib/csv-parser.ts` - RFC 4180 compliant CSV parsing (`parseCSV`, `parseCSVLine`, `parseCSVHeaders`, `getField`, `parseTags`); max 5000 rows
- `src/lib/contact-sync.ts` - Fire-and-forget sync of attendee/speaker/reviewer data to Contact store (`syncToContact`); non-blocking, failures only logged
- `src/lib/storage.ts` - File storage abstraction; `uploadMedia()` saves to `/uploads/media/{YYYY}/{MM}/`; `deleteMedia()` removes from storage + DB; dual provider: local filesystem or Supabase Storage (`STORAGE_PROVIDER` env var); 2MB limit with magic byte validation
- `src/components/import/csv-import-dialog.tsx` - CSV import dialog with file upload, first-5-row preview, template download, import results; post-import "Send Registration Forms" button triggers bulk completion emails
- `src/components/bulk-tag-dialog.tsx` - Manage tags on selected registrations/speakers (add/remove/replace modes)
- `src/components/bulk-email-dialog.tsx` - Send emails to selected or all filtered registrations
- `src/app/globals.css` - Global styles and CSS variables

## Database Models

- **Organization** - Organization entity (currently single-org mode); includes `primaryColor` for dynamic org theming
- **User** - Users with roles (SUPER_ADMIN, ADMIN, ORGANIZER, REVIEWER, SUBMITTER, REGISTRANT)
- **Event** - Events with status tracking; includes `eventType` (CONFERENCE/WEBINAR/HYBRID), `tag`, and `specialty` fields; `registrationWelcomeHtml` and `registrationTermsHtml` for public registration form content; `taxRate` (Decimal), `taxLabel`, and `bankDetails` for tax/payment configuration; `emailFromAddress` and `emailFromName` for per-event sender email; `badgeVerticalOffset` (Int) for badge print positioning
- **TicketType** - Registration type configurations (displayed as "Registration Types" in UI); `ticketTypeId` is the single source of truth — `attendee.registrationType` is auto-synced
- **Registration** - Event registrations; `userId` (nullable FK) links to User for registrant self-service; `paymentStatus` includes `COMPLIMENTARY` for admin-set complimentary registrations; `billingState` and `billingZipCode` for invoice/billing; `termsAcceptedAt` (DateTime) records when registrant accepted T&C
- **Attendee** - Attendee information; includes `title` (Title enum), `photo`, `city`, `state`, `zipCode`, `country`, `registrationType`, `dietaryReqs`, `memberId`, `studentId`, and `studentIdExpiry` (DateTime) fields; member/student fields required conditionally based on registration type name
- **Speaker** - Event speakers; includes `title` (Title enum), `photo`, `city`, `state`, `zipCode`, `country`, `specialty`, and `registrationType` fields; `specialty` is set during submitter registration and editable from dashboard; speakers can be added manually, via CSV import, or imported from the event's registrations
- **MediaFile** - Organization media library; `id, organizationId, uploadedById, filename, url, mimeType, size, createdAt`; managed via `/api/media` routes (GET list, POST upload, DELETE); images stored in `/uploads/media/{YYYY}/{MM}/`
- **EventSession** - Schedule sessions; session times validated against event dates; supports session-level roles via `SessionSpeaker` and per-topic speakers via `SessionTopic`/`TopicSpeaker`
- **SessionTopic** - Topics within a session (title, sortOrder, duration, optional abstract link); speakers assigned per topic via `TopicSpeaker`
- **SessionSpeaker** - Session-level roles using `SessionRole` enum (SPEAKER, MODERATOR, CHAIRPERSON, PANELIST)
- **TopicSpeaker** - Join table for speakers per topic within a session
- **Track** - Session tracks
- **Abstract** - Paper submissions; includes `specialty` field; `managementToken` for public token-based access
- **Hotel/RoomType/Accommodation** - Lodging management; `Accommodation` links to either `Registration` (via optional `registrationId @unique`) or `Speaker` (via optional `speakerId @unique`); atomic transactions prevent overbooking (`bookedRooms` counter); status flow: PENDING → CONFIRMED → CHECKED_IN → CHECKED_OUT (or CANCELLED at any point); price auto-calculated from nights × `pricePerNight`
- **Contact** - Contact store for organization; includes `title` (Title enum), `photo`, `city`, `state`, `zipCode`, `country`, `registrationType`, `memberId`, `studentId`, `studentIdExpiry`, and `associationName` fields; auto-synced from registrants/speakers via `syncToContact()` in `src/lib/contact-sync.ts`
- **Payment** - Stripe payment records linked to Registration; stores amount, currency, stripePaymentId (unique), stripeCustomerId, status, receiptUrl, metadata (JSON)
- **ZoomMeeting** - 1:1 with `EventSession`; `meetingType` enum (MEETING/WEBINAR/WEBINAR_SERIES), `joinUrl`, `startUrl`, `passcode`, `duration`. Live streaming fields: `liveStreamEnabled`, `streamKey`, `streamStatus`. **Recording** (Phase 4): `recordingUrl`, `recordingPassword`, `recordingDownloadUrl`, `recordingDuration`, `recordingFetchedAt`, `recordingStatus` (enum: NOT_REQUESTED/PENDING/AVAILABLE/FAILED/EXPIRED) + index. **Attendance** (Phase 5): `lastAttendanceSyncAt` + index for cron eligibility
- **ZoomAttendance** - Per-segment webinar attendance records pulled from Zoom's participant report; `zoomMeetingId`, `eventId`, `sessionId`, `registrationId?` (best-effort email match), `zoomParticipantId?`, `name`, `email?`, `joinTime`, `leaveTime?`, `durationSeconds`, `attentivenessScore?`. Unique key `(zoomMeetingId, zoomParticipantId, joinTime)` — a single attendee who leaves and rejoins shows up as multiple segments; upserts safe on re-sync
- **WebinarPoll** / **WebinarPollResponse** - Polls pulled from Zoom's `/report/webinars/{id}/polls`. Collapsed to **one logical poll per webinar** — Zoom's report returns a flat list of (participant, question, answer) tuples with no poll-id field, so we can't distinguish multiple polls. `WebinarPoll` has nullable `zoomPollId` + title + JSON question list; `WebinarPollResponse` has one row per participant submission with JSON answers map. Responses use replace-all strategy (deleteMany + createMany in a transaction) since Zoom doesn't give stable submission ids
- **WebinarQuestion** - Q&A entries pulled from `/report/webinars/{id}/qa`. `zoomMeetingId`, `askerName`, `askerEmail?`, `question`, `answer?`, `answeredByName?`, `askedAt`. Unique key `(zoomMeetingId, askerName, askedAt)` — rows with missing `create_time` are skipped and logged to avoid collisions
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
NEXTAUTH_URL="http://localhost:3000"  # App URL
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
npm run dev          # Start dev server
npm run build        # Build for production
npm run lint         # Run ESLint
npx prisma generate  # Generate Prisma client
npx prisma db push   # Push schema to database
npx prisma studio    # Open Prisma Studio
npx tsc --noEmit     # Type check
```

## Role-Based Access Control (RBAC)

### Roles
- **SUPER_ADMIN / ADMIN** - Full access to all features (org-bound)
- **ORGANIZER** - Full access to assigned events (org-bound)
- **REVIEWER** - Abstracts-only access to assigned events (org-independent, scoped by `event.settings.reviewerUserIds`)
- **SUBMITTER** - Abstracts-only access to own submissions (org-independent, scoped by `Speaker.userId`)
- **REGISTRANT** - Self-service access to own registrations only (org-independent, scoped by `Registration.userId`); can edit personal details, view payment status, make payments via Stripe; no dashboard/events access

### Architecture: Org-bound vs. Org-independent Users
- **Team members** (ADMIN, ORGANIZER) have a required `organizationId` and are scoped to their organization
- **Reviewers**, **Submitters**, and **Registrants** have `organizationId: null` — they are independent entities scoped only by event assignment
- This allows one reviewer to review events across multiple organizations; submitters self-register per event; registrants create accounts during public registration
- `User.organizationId` is nullable in the schema; non-null assertion (`!`) is used in admin-only code paths

### Restricted Role Enforcement (3-layer, applies to REVIEWER, SUBMITTER, and REGISTRANT)
1. **API Layer:** `denyReviewer(session)` guard on all POST/PUT/DELETE handlers (except abstract operations and `/api/registrant/registrations` self-edit) returns 403 for REVIEWER, SUBMITTER, and REGISTRANT
2. **Middleware Layer:** `src/middleware.ts` redirects REVIEWER/SUBMITTER from non-abstract event routes; REGISTRANT is redirected to `/my-registration` from all dashboard routes
3. **UI Layer:** Write-action buttons hidden; sidebar hidden for REGISTRANT; header shows "Reviewer Portal", "Submitter Portal", or "Registration Portal"

### Event Scoping
- `buildEventAccessWhere(session.user)` from `src/lib/event-access.ts` scopes event queries by role
- Admins/Organizers see all org events
- Reviewers see only events where their userId is in `event.settings.reviewerUserIds` (no org filter)
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

**Middleware** (`src/middleware.ts`):
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

- **Abstracts flow audit fixes (April 2026)** — End-to-end audit surfaced and fixed four issues. **(1)** Regression from the prior public-registration tightening: a second public form at `/e/[slug]/submitAbstract` (distinct from the canonical `/e/[slug]/abstract/register`) still used the old permissive schema and broke every submission with 400 after the server schema was tightened. Brought it to parity — added `TitleSelect`/`RoleSelect`/`customSpecialty`, flipped org/jobTitle/phone/city/country to required, added the `customSpecialty`-when-"Others" `.refine()`, updated `STEP_FIELDS.details`, wired up the POST payload. **(2)** IDOR: `GET /api/events/[eventId]/abstracts/[abstractId]` did not enforce the SUBMITTER ownership check the PUT handler already had. A submitter with a speaker record in an event could fetch any abstract ID in that event including reviewNotes/reviewScore. GET now returns 404 (not 403 — avoids existence leak) when `session.user.role === "SUBMITTER"` and `abstract.speaker?.userId !== session.user.id`. **(3)** Agent tool gap: `update_abstract_status` in `src/lib/agent/event-tools.ts` updated status + reviewedAt but never sent the `abstract-status-update` email, never wrote an audit log, and never called `notifyEventAdmins()` — so organizers using the agent ("accept all abstracts from track X") were invisible to speakers. **(4)** XSS/phishing risk: `reviewNotes` was interpolated into the speaker email HTML without escaping; a reviewer could inject `<a href="https://evil">click</a>`. Extracted the dashboard PUT handler's ~45-line notification block into a new shared helper `src/lib/abstract-notifications.ts` (`notifyAbstractStatusChange({ eventId, eventName, eventSlug, abstractId, abstractTitle, previousStatus, newStatus, reviewNotes, reviewScore, speaker, feedbackOnly? })`) that owns: branded speaker email with `escapeHtml()`-sanitized reviewNotes, admin notification via `notifyEventAdmins`, `feedbackOnly` branch for the "notes/score changed without status transition" case. Both the dashboard PUT route and the agent tool call the helper — identical side effects from both entry points. Agent tool also now writes an audit log row with `changes.source: "agent"` so agent-initiated reviews show up in the audit trail. No schema changes. Files: `src/lib/abstract-notifications.ts` (new), `src/app/api/events/[eventId]/abstracts/[abstractId]/route.ts`, `src/lib/agent/event-tools.ts`, `src/app/e/[slug]/submitAbstract/page.tsx`. Deferred to a future pass: pagination cap on `GET /api/events/[eventId]/abstracts` list (AI agent's `list_abstracts` already caps at 200; dashboard-facing API doesn't).
- **Public registration required fields (April 2026)** — Tightened client + server Zod schemas on the three public entry points (`/e/[slug]/register/[category]`, `/e/[slug]/abstract/register`, `/e/[slug]/complete-registration`) so public registrants must supply `jobTitle`, `organization`, `city`, and `phone` in addition to the already-required `title`/`firstName`/`lastName`/`email`/`country`/`specialty`/`role`. Added a `.refine()` on all three schemas making `customSpecialty` required when `specialty === "Others"`. The admin `createRegistrationSchema`, CSV import (no Zod), and registrant self-service PUT intentionally keep their permissive rules — public forms use separate schemas so the change has zero blast radius on admin/bulk flows. The completion form also gained editable `RoleSelect` + `SpecialtySelect` fields (previously only read-only-if-pre-filled, leaving no way to supply them when CSV lacked them). Fixed pre-existing bugs in the submitter route where `customSpecialty` was validated but never persisted to `Speaker` / `Contact`, and in the completion route where `sendRegistrationConfirmation` and `syncToContact` used stale `attendee.*` snapshots instead of the newly-submitted values. All labels got red `*` asterisks. Files touched: `src/app/e/[slug]/register/[category]/page.tsx`, `src/app/api/public/events/[slug]/register/route.ts`, `src/app/e/[slug]/abstract/register/page.tsx`, `src/app/api/public/events/[slug]/submitter/route.ts`, `src/app/e/[slug]/complete-registration/page.tsx`, `src/app/api/public/events/[slug]/complete-registration/route.ts`. No schema migration.
- **Webinar Console UX refresh (April 2026)** — Console at `/events/[eventId]/webinar` reorganized from a 10-card vertical stack (~3000px scroll) into a workflow-aware layout: (1) **Sticky status bar** (`WebinarStatusBar`) always visible above the fold — color-coded by status (blue/red-pulsing/gray), inline join URL + copy + passcode badge, context-aware primary action (`Start as Host` when Scheduled/Live, `Watch Replay` when Ended with recording ready, `Refetch recording` when Ended without recording); collapses to "Configure Zoom" banner when `!hasZoom`. (2) **Tabs: Setup / Analytics / Settings** — default tab is status-driven (Scheduled/Live → Setup, Ended → Analytics); Setup groups Overview + Panelists + Email Sequence, Analytics groups Recording + Attendance + Polls + Q&A, Settings holds the config form. (3) **`OverviewCard`** merges the old Anchor Session + Zoom Meeting cards into one. (4) **`GlobalRefreshButton`** next to Re-run provisioner — parallel-fires recording + attendance + engagement syncs via `Promise.allSettled` with a single summary toast; disabled until session ends. (5) **`CardLoading` + `CardEmpty`** primitives replace ad-hoc loading/empty markup across all 6+ cards for consistent scanning. **Import from Speakers** (new `POST /api/events/[eventId]/webinar/panelists/sync-speakers`): one-click pulls all anchor-session speakers with emails, parallel-fetches existing Zoom panelists, dedups by lowercased email (no 409 Conflict on re-import), batches via `addWebinarPanelists`. Response surfaces `skippedAlreadyPanelist` + `skippedNoEmail` counts. Shared 30/hr rate limit bucket with single-add. Panelists route now `export`s `resolveAnchorZoomMeeting()` so the sibling sync-speakers route reuses the 4-step precondition lookup (event access → anchor session → zoom meeting → webinar meetingType). **Optimistic UI** on panelist add/remove: `useAddWebinarPanelist.onMutate` inserts a row with id prefixed `optimistic:` (exported `OPTIMISTIC_PANELIST_PREFIX`), `onError` rolls back to previous query data, `onSettled` invalidates for the canonical refetch. PanelistsCard detects the prefix and renders rows greyed out + italic + spinner + disabled remove. The add form clears immediately on submit but restores its values on error so the user doesn't retype. No schema changes. Hook: `useSyncSpeakersToPanelists`.

- **Webinar events as first-class (April 2026, Phases 1–6)** — `eventType === 'WEBINAR'` now auto-provisions a ready-to-join webinar end-to-end. Creating a WEBINAR event triggers `provisionWebinar()` (fire-and-forget from `POST /api/events`) which creates an anchor `EventSession`, calls `createZoomWebinar()` if the org has Zoom configured, persists a `settings.webinar` JSON block, and enqueues a 5-phase email sequence (`webinar-confirmation` immediate + `reminder-24h`, `reminder-1h`, `live-now`, `thank-you` via existing `ScheduledEmail` cron). Sidebar is filtered via `webinarModuleFilter()` in `src/lib/webinar.ts` to hide Accommodation/Check-In/Promo Codes/Abstracts/Reviewers for webinar events and surface a new **Webinar Console** at `/events/[eventId]/webinar` with stacked cards: Overview (anchor session + Zoom join URL), Recording, Attendance, Panelists, Polls, Q&A, Email Sequence, Webinar Settings — now wrapped in Setup/Analytics/Settings tabs (see "Webinar Console UX refresh" bullet above). Public register route branches on `eventType` — webinar registrations get `sendWebinarConfirmationForRegistration()` (immediate direct send, no cron latency) instead of the generic `sendRegistrationConfirmation`. After the webinar ends, two cron workers poll Zoom: **`/api/cron/webinar-recordings`** (every 5 min) fetches cloud recording via `GET /meetings/{id}/recordings` and persists `recordingUrl`/`recordingPassword`/`recordingStatus` on `ZoomMeeting` (states: `NOT_REQUESTED`→`PENDING`→`AVAILABLE`, flips to `EXPIRED` after 7 days); **`/api/cron/webinar-attendance`** (every 10 min) fetches the participant report via `GET /report/webinars/{id}/participants` with `next_page_token` pagination and upserts per-segment rows into new `ZoomAttendance` table (unique key `(zoomMeetingId, zoomParticipantId, joinTime)` preserves rejoin history; registrationId best-effort matched via case-insensitive email lookup); attendance tick also chains `syncWebinarEngagement()` for polls + Q&A from `/report/webinars/{id}/polls` and `/report/webinars/{id}/qa` into new `WebinarPoll` + `WebinarPollResponse` + `WebinarQuestion` tables. Attendance re-sync is restricted to 24h post-end to avoid wasting Zoom API calls on old webinars. Public session page shows emerald "Watch Replay" card (replacing Join CTA) when recording is `AVAILABLE`, amber "Recording processing" spinner when `PENDING`. Thank-you email's `{{recordingBlock}}` renders real Watch Replay button when available. Webinar Console `AttendanceCard` shows KPIs (registered/attended/rate/avg watch time/peak concurrent computed via edge-event sweep) + attendee table with CSV export (`?export=csv`). Polls card renders per-poll horizontal bar-chart distributions; Q&A card is a searchable list with answer blocks. Polls sync uses a DB transaction (nullable composite unique on `WebinarPoll.zoomPollId` doesn't enforce NULL in Postgres, so two concurrent syncs could otherwise create duplicate logical polls); Q&A rows with missing `create_time` are skipped and logged to avoid uniqueness collisions from `Date.now()` fallback. Panelist management is accessible from the Webinar Console (see UX refresh bullet above); the existing session-level `/sessions/[sessionId]/zoom/panelists` route is reused in places. All cron workers: Bearer `CRON_SECRET`, serial processing with 500ms delay between rows (batches >3) to respect Zoom's 30 req/s rate limit, per-row try/catch so one bad row can't kill the tick, structured logging with `durationMs` on every state transition. Bulk-email also gained a sender-branding fix: `executeBulkEmail` now fetches `emailFromAddress`/`emailFromName`/`emailHeaderImage`/`emailFooterHtml` so `brandingFrom()` resolves to the per-event sender instead of provider defaults. Migration files: `20260413000000_add_webinar_recording_fields`, `20260413010000_add_zoom_attendance`, `20260414000000_add_webinar_engagement`. EC2 crontab additions: `*/5 * * * *` for webinar-recordings, `*/10 * * * *` for webinar-attendance (chains engagement). Decouplability: all code lives under `src/lib/webinar*`, `src/app/api/events/[eventId]/webinar/*`, `src/app/(dashboard)/events/[eventId]/webinar/*`, `src/app/api/cron/webinar-*`, `src/lib/zoom/{recordings,reports,polls-qa}.ts` — one-way imports from core. Full docs at `docs/WEBINAR_EVENTS.md` / `.html`.
- **Scheduled communications** — Organizers can queue bulk emails for future delivery from `/events/[eventId]/communications`. `BulkEmailDialog` has a "Send now / Schedule for later" toggle with a datetime picker (min lead time = 5 minutes); scheduled rows are stored in the new `ScheduledEmail` model with `recipientType + filters` (recipients are re-evaluated dynamically when the cron fires, so a "remind unpaid" send naturally excludes anyone who paid in the meantime). Cron worker at `/api/cron/scheduled-emails` (Bearer `CRON_SECRET`, accepts GET/POST) processes up to 10 due rows per tick using an atomic `PENDING → PROCESSING` claim to prevent double-send. Shared `executeBulkEmail()` helper in `src/lib/bulk-email.ts` is reused by both the immediate-send route (`/api/events/[eventId]/emails/bulk`) and the cron worker. Management UI: `ScheduledEmailsList` table at the bottom of the Communications page lets organizers list/edit/cancel pending rows and retry failed rows; status badges (PENDING/PROCESSING/SENT/FAILED/CANCELLED) with success/failure counts shown via tooltip. Schedule create/edit/cancel/retry routes all use `denyReviewer()`; schedule create shares the existing 20/hr/event rate limit bucket so users can't bypass it. EC2 crontab entry: `* * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://events.meetingmindsgroup.com/api/cron/scheduled-emails`. Migration: `20260410000000_add_scheduled_emails`.
- **Email template WYSIWYG editor and branding** - Replaced raw HTML textarea with Tiptap v2 WYSIWYG editor (`src/components/ui/tiptap-editor.tsx`) with toolbar (bold, italic, underline, headings, lists, alignment, link, image, color, undo/redo) and source toggle; email preview opens in popup dialog (`src/components/email-preview-dialog.tsx`) with desktop (600px) / mobile (375px) toggle; added `emailHeaderImage` and `emailFooterHtml` fields to Event model for consistent email branding; `wrapWithBranding()` in `src/lib/email.ts` wraps all outgoing emails with table-based header image + footer layout; `inlineCss()` uses `juice` for email-client-safe inline styles; `renderAndWrap()` combines variable substitution + branding + CSS inlining; `stripDocumentWrapper()` in `src/lib/email-utils.ts` (client-safe) extracts body from legacy full-document templates; all 6+ email send routes updated to use `renderAndWrap()`; templates now stored as body fragments (no DOCTYPE/html/body), branding applied at render time; email template list inlined directly in Settings → Email Templates tab (no extra "Manage" click); Tiptap lazy-loaded with `next/dynamic` to avoid bloating other pages; **note:** Tiptap v2 is used (not v3) because v3 ships source-only without compiled dist
- **Database-backed logging for Vercel** - `SystemLog` Prisma model stores log entries in PostgreSQL; Pino writes to a custom `Writable` stream that buffers and batch-inserts; `/api/logs` route supports `source=database` (default on Vercel); log viewer UI at `/logs` with database/file/docker source selector; comprehensive logging coverage across all API routes, middleware, auth, uploads, and server pages
- **EventsAir import error handling** - Import dialog now shows error state UI with actual error message, Retry button, and Settings link; `listEvents()` throws on null API response; `useEventsAirEvents` hook uses `retry: false`; events API route returns actual error details in 500 response
- **Title and Registration Type fields** - Added `Title` enum (MR, MS, MRS, DR, PROF, OTHER) and `registrationType String?` to Attendee, Speaker, and Contact models; `TitleSelect` dropdown component; `RegistrationTypeSelect` component (fetches TicketType names with event context, falls back to text input); shared `titleEnum` Zod schema in `src/lib/schemas.ts`; `formatPersonName()` and `getTitleLabel()` helpers in utils; updated all 9+ API routes, all person forms, and all display views to show title prefix with names; CSV export includes title and registrationType columns
- **Sentry client instrumentation** - Replaced root-level `sentry.client.config.ts` with `src/instrumentation-client.ts` (Next.js 15+ convention); DSN from `NEXT_PUBLIC_SENTRY_DSN` env var with replay integration (10% session sample, 100% on error)
- **Uploaded photo serving** - Next.js `output: "standalone"` does not serve `public/` directory files automatically; added `src/app/uploads/[...path]/route.ts` catch-all handler that reads from `public/uploads/` and streams files with correct `Content-Type` and long-lived `Cache-Control` headers; includes path-traversal protection
- **Docker deploy fix** - Replaced `docker compose up -d --no-deps` with `docker compose down --remove-orphans && docker compose up -d` in `.github/workflows/deploy.yml` to prevent container naming conflicts from prior failed deployments
- **Specialty field on Abstract** - Added `specialty` to abstract create/edit Zod schemas, DB writes, and UI (SpecialtySelect in submit and edit dialogs); SUBMITTER role can set specialty on own abstracts
- **Tag input component** - `TagInput` chip-based multi-tag input replacing comma-string inputs; Enter or comma adds a tag, × removes individual chips, Backspace on empty removes last tag; used in registration forms, registration detail edit panel, and contacts form; contacts form state changed from string to string[]
- **Photo upload system** - File upload functionality for attendee/speaker/contact photos with validation (max 500KB, JPEG/PNG/WebP formats); `PhotoUpload` component with preview and progress indicator; stored in `/public/uploads/photos/YYYY/MM/` with UUID-based filenames; replaces URL-based photo fields across all forms; **note:** photo Zod schemas use `z.string().optional()` (not `.url()`) since upload returns relative paths like `/uploads/photos/...`
- **City and country fields** - Added to Attendee, Speaker, and Contact models; `CountrySelect` component with searchable dropdown (ISO 3166-1 standard, 249 countries); integrated into registration, speaker, and contact forms with display in list views and detail sheets
- **Event classification fields** - Added `eventType` (enum: CONFERENCE/WEBINAR/HYBRID), `tag`, and `specialty` fields to Event model; integrated into event creation and settings forms for better event categorization
- **Authenticated abstract submission (SUBMITTER role)** - Speakers create an account at `/e/[slug]/register`, then log in to submit/edit abstracts via dashboard; SUBMITTER role mirrors REVIEWER pattern (org-independent, abstracts-only access, scoped by `Speaker.userId`)
- **Submitter registration** - Public form at `/e/[slug]/register` creates User (role=SUBMITTER) + Speaker record linked to event (including specialty field); redirects to login on success; `/e/[slug]` server-redirects to `/e/[slug]/register`
- **Abstract submission URL widget** - Abstracts page shows a copyable URL card (visible to organizers/admins only) with the public submission link (`/e/[slug]/register`) and a short description to share with speakers
- **Abstract status notification emails** - Automatic email to speaker on status change (UNDER_REVIEW, ACCEPTED, REJECTED, REVISION_REQUESTED) with status-specific messaging, reviewer notes, and login link
- **Org-independent reviewers** - Reviewers decoupled from organizations (`User.organizationId = null`); one reviewer can review across multiple orgs; scoped only by `event.settings.reviewerUserIds`
- **Reviewers module** - Per-event reviewer management page with dual add mode (from speakers or by email); auto-invitation; API routes for add/remove; React Query hooks
- **Restricted role access hardening** - 3-layer RBAC enforcement (API guards on 29+ handlers, middleware redirects, UI write-action hiding) restricting REVIEWER and SUBMITTER to abstracts-only
- **Event scoping for reviewers** - `buildEventAccessWhere` removes org filter for reviewers; reviewers see only assigned events across all orgs
- **Server page query optimization** - Parallelized `params`/`auth()`/DB queries on speakers and event detail pages; switched to Prisma `select` for minimal data transfer
- **Composite database indexes** - Added `[eventId, status]` and `[eventId, ticketTypeId]` on Registration for faster filtered queries
- **Middleware scope narrowing** - Matcher targets only dashboard routes; reviewers redirected from non-abstract event routes
- **Barcode import system** - CSV import route (`/api/events/[eventId]/import/barcodes`) maps DTCM barcodes to registrations by ID or email; `barcode` field on Registration (`@unique`); import dialog UI with results summary
- **Badge PDF generation** - Server-side PDF generation with `pdfkit` + `bwip-js` (Code128 barcodes); one badge per A4 page, horizontally centered; badge layout: name, country, barcode, badge type (large), registration number (italic); all black text, no branding; `badgeVerticalOffset` on Event for print positioning; prints via `window.print()` (not download)
- **Check-in scanner page** - Mobile-optimized page at `/events/[eventId]/check-in`; camera mode via `html5-qrcode`; manual/hardware scanner mode with auto-focused input; check-in API searches both `qrCode` and `barcode` fields; live attendance counter, recent scans log, Web Audio API sound feedback, 2s debounce
- **API query optimization (March 2026)** - `select: { id: true }` on event existence checks across 25+ route files; parallelized independent queries in speaker/abstract detail routes; reduced over-fetching in registration list
- **WYSIWYG footer editor** - Event footer HTML now edited via TiptapEditor in settings (replaced textarea)
- **Registration detail edit** - Slide-out panel with full CRUD for registration details; registration type editable via dropdown
- **Import speakers from registrations** - Replaced "Import from Contacts" on the speakers page with "Import from Registrations"; dialog (`src/components/speakers/import-registrations-dialog.tsx`) lists the event's own registrations (excluding cancelled) with search, multi-select, name/email/org/type/status columns; API route (`src/app/api/events/[eventId]/speakers/import-registrations/route.ts`) maps attendee data to speaker records, deduplicates by email, skips existing speakers; React Query hook `useImportRegistrationsToSpeakers` in `use-api.ts`
- **Stripe payment integration** - Stripe Checkout for paid event registrations; checkout route at `/api/public/events/[slug]/checkout` creates Stripe sessions with rate limiting (3/60s per IP); webhook at `/api/webhooks/stripe` handles `checkout.session.completed` with signature verification, idempotent processing (interactive transaction to prevent duplicate Payment records), receipt URL fetching, and payment confirmation email; payment status polling endpoint at `/api/public/events/[slug]/payment-status/[registrationId]`; confirmation page (`/e/[slug]/confirmation`) shows Pay Now button for paid tickets, polls for webhook completion, displays payment status from server (not URL params); `src/lib/stripe.ts` provides lazy-init Stripe SDK singleton and zero-decimal currency helpers (`isZeroDecimalCurrency`, `toStripeAmount`, `fromStripeAmount`) for correct handling of JPY, KRW, etc.; `Payment` model stores amount, currency, stripePaymentId, receiptUrl; env vars: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- **React Query caching** for instant page navigation (registration types, registrations, schedule, abstracts, reviewers)
- Public event registration at `/e/[slug]` (no auth required)
- User invitation system with email tokens
- Cerulean Blue theme with gradients
- Bulk email sending via Brevo
- Session calendar view
- File-based logging (`logs/app.log`, `logs/error.log`)
- **REGISTRANT role and self-service portal** - New org-independent role for event attendees with account creation during public registration (email + password); `/my-registration` dashboard page shows all user's registrations with event headers, payment status (confirmed/complimentary/pay now), inline edit of attendee fields; self-edit API at `/api/registrant/registrations` with ownership verification; REGISTRANT redirected to portal from all dashboard routes (middleware); sidebar hidden, header shows "Registration Portal"
- **2-step public registration form** - Step 1: email + password (account creation) with organizer-customizable welcome HTML content; Step 2: personal details + category selection + terms & conditions; `registrationWelcomeHtml` and `registrationTermsHtml` fields on Event model, both editable via TiptapEditor on registration types settings page; default terms auto-seeded on event creation. All public entry points (main register, abstract submitter register, token-based complete-registration) enforce a strict required-field set: `title`, `firstName`, `lastName`, `jobTitle`, `organization`, `city`, `phone`, `country`, `email`, `role`, `specialty`, and `customSpecialty` when `specialty === "Others"`. Admin dashboard, CSV import, and registrant self-service schemas are **not** affected — they use separate Zod schemas and remain permissive.
- **Bulk registration type update** - PATCH at `/api/events/[eventId]/registrations/bulk-type`; bulk select registrations → change type via dialog; atomically adjusts soldCounts (decrement old types, increment new) and syncs `attendee.registrationType`; "Change Type" button in bulk selection toolbar on registrations page
- **Single source of truth for registration type** - `ticketTypeId` is the canonical reference for registration type; `attendee.registrationType` text field auto-synced from `ticketType.name` on create and type change; removed `registrationType` from registration edit forms and Zod schemas; CSV export uses `ticketType.name`; speakers/contacts retain `registrationType` as independent field (no `ticketTypeId` on those models)
- **Event-scoped login** - `/e/[slug]/login` page with event branding (banner, name, dates); `redirect` param routes to registration portal or abstracts after login; "Don't have an account?" links to register/abstract forms; reviewer invitation emails link to event-scoped login after accepting invitation
- **Event-scoped my-registration** - `/e/[slug]/my-registration` shows registration for specific event with event branding; global `/my-registration` shows all events; registration form sign-in links to event-scoped portal
- **PresentationType on abstracts** - `PresentationType` enum (ORAL/POSTER) added to Abstract model; dropdown in submit/edit dialogs and full-page forms; badge displayed on abstract cards
- **Full-page abstract submission** - Submitters use `/events/[eventId]/abstracts/new` (2-column layout: content + sidebar) instead of dialog; edit at `/events/[eventId]/abstracts/[id]/edit` with reviewer feedback display, draft/submit actions; plain Textarea for content (not WYSIWYG — cleaner for academic text)
- **Abstract register page** - `/e/[slug]/abstract/register` with 2-step flow (account → details), separate `abstractWelcomeHtml` field; REGISTRANT→SUBMITTER role upgrade supported
- **Reviewer portal improvements** - Reviewers can now review, score (0-100), accept/reject abstracts; review dialog and buttons enabled for REVIEWER role; header permissions corrected; event list links go directly to `/abstracts`
- **PDF quote/proforma** - Generated with pdfkit; includes event details, line items, tax calculation (taxRate + taxLabel), bank transfer details, branded layout; attached to confirmation email for paid registrations; downloadable from registrant portal and admin detail sheet
- **Tax & payment** - `taxRate` (Decimal), `taxLabel`, `bankDetails` on Event model; tax config in Settings → Registration tab; registration form shows price + VAT breakdown; checkout sends base + tax as separate Stripe line items; Stripe `automatic_tax` removed; PDF quote, confirmation page, and registrant portals all show tax breakdown
- **Abstract notification improvements** - Email sent when reviewer adds notes/score without status change (not just on status change); login link in notification uses event-scoped URL
- **Bulk email for abstract submitters** - Select abstracts → send email; email types: Abstract Accepted, Rejected, Revision Requested, Submission Reminder, Custom; `abstract-reminder` template added to defaults; deduplicates by speaker email
- **Smart /e/[slug]/register redirect** - Auto-redirects to first active tier (Early Bird → Standard → Onsite); skips Presenter (shared separately by organizer); shows "Registration Closed" if no active tiers
- **Settings: branding split** - Branding (banner + footer) and Email Branding (header image + footer) separated into distinct tabs
- **UI polish** - Public form widths increased to `max-w-5xl`; font sizes increased to 16px base; all select dropdowns use `w-full`; Tiptap source mode formats HTML with indentation; Tailwind safelist for DB-stored HTML classes; footer/welcome/terms rendered with `prose` + `[&>*]:mb-4`; sheet width fix (removed hardcoded 540px)
- **SendGrid integration** - Added `@sendgrid/mail` as alternative email provider to Brevo; auto-selected via `SENDGRID_API_KEY` env var; both providers coexist in `src/lib/email.ts` with a unified `sendEmail()` interface; set `EMAIL_PROVIDER` to force a specific provider or omit to auto-detect from available API keys
- **Attendee cleanup on registration delete** - Deleting a registration now also deletes its attendee record; public registration route reuses orphaned attendees (same email, no active registrations) instead of creating duplicates; P2002 unique constraint error handled gracefully
- **COMPLIMENTARY payment status** - Added `COMPLIMENTARY` to `PaymentStatus` enum; admins can set any registration as complimentary from the detail sheet; complimentary registrations can check in without payment, are included in badge generation, and show "no payment required" in registrant portal; cyan badge color
- **Detail sheet redesign (registration, contact, speaker)** - Gradient header with photo (112px, editable on hover with pencil overlay and "Remove" link below), 2-column info grid in view mode, status badges, action buttons in header; `SheetDescription` uses `asChild` + `<span>` to avoid `<p>` > `<div>` hydration errors; 700px sheet width, 32px right padding
- **Speaker detail page** - Full page (not sheet) with gradient header, photo upload, 2-column info grid, inline edit, sessions/abstracts lists, social links, email dialog (invitation/agreement/custom); speakers list uses table layout (matching registrations)
- **Session topics system** - `SessionTopic` model for topics within sessions (title, sortOrder, duration, optional abstract); `TopicSpeaker` join table for per-topic speakers; `SessionRole` enum (SPEAKER, MODERATOR, CHAIRPERSON, PANELIST) replaces free-text role on `SessionSpeaker`; session form has "Session Roles" section (role + speaker dropdowns) and "Topics" section (repeatable sub-form with title, duration, speaker checkboxes); topics are optional — sessions work with just session-level roles; legacy `speakerIds` array still supported
- **Session date validation** - Session start/end times must fall within event dates; validated in both POST and PUT; datetime-local inputs have `min`/`max` set to event dates; "Add Session" pre-fills with current calendar date (9:00–10:00)
- **Badge print (not download)** - Badge button opens PDF in new browser tab and triggers `window.print()` instead of downloading; one badge per page, horizontally centered; `badgeVerticalOffset` field on Event model for organizer-adjustable vertical positioning (Settings → Registration tab); badge layout: name, country, barcode, badge type, registration number — all black text, no branding/colors
- **pdfkit Turbopack fix** - Added `pdfkit` to `serverExternalPackages` in next.config.ts to preserve `__dirname` for Helvetica.afm font resolution; `bwip-js` barcode rendering uses async `toBuffer()` with pre-rendered buffers (not `toBufferSync`)
- **Email template cleanup** - Removed gradient header divs from default email templates; `wrapWithBranding()` body cell has `padding: 24px 30px`; registration confirmation template uses clean text header; `titleEnum` accepts empty string `""` and transforms to `undefined`
- **Tiptap layout blocks** - Layout dropdown in editor toolbar: 2-column (50/50), 3-column, sidebar+main (30/70), content box (gray), info box (blue), highlight box (amber), CTA button, divider, spacer; all use inline styles (email-safe)
- **Photo delete fix** - Photo Zod schemas accept `.nullable()` on speaker and registration update routes; `photo: editData.photo ?? null` in save logic (not `|| undefined`); validation failure logging added (`apiLogger.warn`) on speaker and registration update routes
- **Signup notifications** - `SIGNUP` notification type; admins notified when: new registrant account created, new submitter account created, team member accepts invitation
- **Log viewer enhancements** - "Download All" button exports all logs; "Clear Logs" button (database source only) deletes logs by timeframe with confirmation; DELETE endpoint on `/api/logs`
- **Global settings redesign** - Gradient header banner; stats cards with colored left borders and icon badges; section cards with colored icon badges (cerulean, violet, emerald, sky, amber)
- **Organization primary color** - `primaryColor` field on Organization model; dynamic theme provider applies org color via CSS variables; auth session includes primaryColor
- **Title enum sorted alphabetically** - DR, MR, MRS, MS, PROF in schema, Zod, UI dropdown, and display labels
- **State and zip code fields** - Added `state` and `zipCode` to Attendee, Speaker, and Contact models; `billingState` and `billingZipCode` on Registration for invoice purposes; integrated into all person forms, CSV import/export, and contact sync
- **Terms accepted timestamp** - `termsAcceptedAt` (DateTime) on Registration records the moment a registrant accepted T&C; set on both public registration submit and completion form submit
- **Conditional member/student fields** - Registration types containing "member" in the name require `memberId`; types containing "student" require `studentId` and `studentIdExpiry`; enforced client-side and server-side in the completion form and public registration API; info box shown to registrant explaining ID verification at event
- **CSV import → registration completion flow** - Admins upload a CSV (required: email, firstName, lastName; optional: state, zipCode, registrationType, memberId, studentId, etc.) at `/events/[eventId]/registrations` → CSV import dialog; records are created, then "Send Registration Forms" triggers bulk completion emails; completion email contains a 7-day token link to `/e/[slug]/complete-registration?token=...`; public page pre-fills read-only fields (name, email) and collects editable details + optional account creation; API at `GET/POST /api/public/events/[slug]/complete-registration`; rate limited (20 GET / 15 min per IP, 5 POST / 15 min per IP); send-emails route limited to 5 sends / 1 hour per org; one-time-use token deleted after successful submission; `contact-sync.ts` fires after completion
- **Media library** - Organization-level media management; JPEG/PNG/WebP files up to 2MB with magic byte validation; stored in `/uploads/media/{YYYY}/{MM}/`; `MediaFile` Prisma model; API routes at `/api/media` (GET paginated list, POST upload, DELETE by id); usable in TiptapEditor for email template images; `STORAGE_PROVIDER` env var switches between local filesystem and Supabase Storage
- **Contact auto-sync** - `syncToContact()` in `src/lib/contact-sync.ts` upserts attendee/speaker data to Contact store after CSV import, speaker import, and registration completion; appends eventId to contact.eventIds (no duplicates); non-blocking (failures logged, never thrown)
- **Centralized Communications page** - `/events/[eventId]/communications` page consolidates all event email sending in one place (replaces scattered send-email buttons on individual pages)
- **Standalone Content page** - `/events/[eventId]/content` provides dedicated TiptapEditor panels for registration welcome HTML and abstract welcome HTML, outside of settings tabs
- **AI Agent** - `/events/[eventId]/agent` page lets organizers type natural language commands to autonomously manage their event; powered by `@anthropic-ai/sdk` with Anthropic tool-use API in an agentic loop; tools: `list_event_info`, `list_tracks`, `create_track`, `list_speakers`, `create_speaker`, `list_registrations`, `list_sessions`, `create_session`, `list_ticket_types`, `send_bulk_email`; streams progress to browser via SSE (`Content-Type: text/event-stream`); tool executors in `src/lib/agent/event-tools.ts`, system prompt builder in `src/lib/agent/system-prompt.ts`, SSE route at `src/app/api/events/[eventId]/agent/execute/route.ts`; rate limited (20 req/hr per user, 10 bulk emails/hr per event); read-only + create only (no deletes); restricted to ADMIN/ORGANIZER roles; `X-Accel-Buffering: no` header disables nginx buffering for EC2 production
- **Event-scoped media library** - Each event has its own media page at `/events/[eventId]/media`; `MediaFile.eventId` (optional FK) scopes uploads per event; API routes at `/api/events/[eventId]/media` (GET paginated list, POST upload with magic byte validation and 20/hr rate limit, DELETE by id); React Query hooks `useEventMedia`, `useUploadEventMedia`, `useDeleteEventMedia`; drag-and-drop upload zone, image grid with copy URL and delete; sidebar "Media" link under event Tools section
- **Accommodation assignment UI** - "Assign Room" button on Bookings tab of accommodation page opens `AssignAccommodationDialog` (`src/components/accommodation/assign-accommodation-dialog.tsx`); dialog has Registration/Speaker tab toggle, searchable person picker (filters to those without existing accommodation), room type `Select` grouped by hotel with availability counts, date pickers, guest count, special requests; POSTs to existing `/api/events/[eventId]/accommodations`
- **Speaker accommodation support** - `Accommodation.speakerId` (optional `@unique` FK to Speaker) added alongside `registrationId` (now optional); API POST accepts either `registrationId` or `speakerId` (Zod refine ensures at least one); GET/PUT responses include `speaker` select; speakers API (`/api/events/[eventId]/speakers`) now returns `accommodation: { id }` for filtering; booking cards show "Speaker" badge for speaker-linked bookings
- **Accommodation status management** - Booking cards on Bookings tab now have inline status action buttons: PENDING → Confirm/Cancel, CONFIRMED → Check In/Cancel, CHECKED_IN → Check Out, CANCELLED → Reinstate (→ PENDING); calls PUT `/api/events/[eventId]/accommodations/[id]` with `{ status }` and refreshes both bookings and hotel room counts
- **Accommodation API optimization** - GET list uses `select` instead of `include` for attendee (only firstName/lastName/email) and roomType (only name + hotel.name); detail route parallelizes `params + auth()` and `event + accommodation` lookups via `Promise.all`; PUT parallelizes `event + accommodation + body` parsing; audit logs changed from blocking `await` to fire-and-forget `.catch()`; added `apiLogger.warn` on Zod validation failures; added missing `nights <= 0` check on room type change path
- **MCP Server (Model Context Protocol)** - Exposes EA-SYS as an MCP server for external AI agents and automation platforms; `src/mcp/server.ts` defines 30+ tools across 6 domains: events, registrations, speakers, sessions/tracks, abstracts/reviews, and accommodations/hotels; tools include `list_events`, `get_event_info`, `list_registrations`, `create_speaker`, `create_session`, `add_topic_to_session`, `create_registration`, `create_ticket_type`, `list_abstracts`, `update_abstract_status`, `send_bulk_email`, `check_in_registration`, `get_event_stats`, `list_invoices`, `list_media`, and more; two transports: **stdio** (local CLI use) and **Streamable HTTP** at `/api/mcp` (remote clients like n8n); SSE compat endpoint at `/api/mcp/sse` redirects legacy clients; auth via `x-api-key` header or `Authorization: Bearer` — keys stored as SHA-256 hashes in `ApiKey` model, validated by `src/lib/api-key.ts`; rate limited at 100 req/hr per key; sessions tracked in-memory with `Mcp-Session-Id` header and 30-min TTL; n8n connects via its MCP node using the Streamable HTTP endpoint + API key to automate event workflows (e.g., syncing registrations, triggering emails, creating sessions from external data)

## Current Mode

**Single Organization Mode** (multi-org support planned for later):
- User account registration is disabled (`/register` redirects to `/login`)
- Team members (Admin/Organizer) must be invited by an admin via Settings → Users
- Reviewers are org-independent (`User.organizationId = null`) — invited per-event via the Reviewers page
- Submitters are org-independent (`User.organizationId = null`) — self-register per event via `/e/[slug]/register`
- Registrants are org-independent (`User.organizationId = null`) — create accounts during public event registration, see only `/my-registration` portal
- Public event registration is open to all at `/e/[event-slug]`

- **Zoom integration** — Fully decoupled, optional Zoom module for live meetings, webinars, and webinar series linked to event sessions; `ZoomMeeting` Prisma model with 1:1 relation to `EventSession`; `src/lib/zoom/` server module (OAuth client with in-memory token cache + debug-level cache hit logging, meetings/webinars CRUD with per-operation logging, org-aware JWT signature generation with dev/prod SDK mode); all credentials stored AES-256-GCM encrypted per-org in `Organization.settings.zoom` — Server-to-Server OAuth (accountId, clientId, clientSecret) + General App SDK with separate Dev and Prod keys (sdkKeyDev/sdkSecretDev, sdkKeyProd/sdkSecretProd, sdkMode toggle) — no env vars needed; secrets optional on update (existing encrypted values preserved if left blank); per-event toggle via `Event.settings.zoom.enabled`; 7 API routes (credentials CRUD with dev/prod SDK, test connection, event settings, session meeting CRUD with startUrl/passcode, panelist sync with rate limit, public join with org-aware signature, public session detail with event branding + speakers); branded public session landing page at `/e/[slug]/session/[sessionId]` with event banner, session details, speaker photos/bios sidebar, Live/Upcoming/Ended badges, prominent "Join Meeting" CTA opening Zoom web client, meeting details card; DRAFT events allowed for testing; session edit dialog shows "Start as Host" (opens Zoom as host), "Attendee Join Link", "Copy Link", "Open Embed Page", meeting ID + passcode; `ZoomSessionBadge` on session cards in calendar tooltip + session list; rate limiting on all Zoom endpoints (create 30/hr, join 60/hr, credentials 10/hr, panelists 30/hr) with `apiLogger.warn` on every rejection; full logging coverage: `zoom:creating-meeting`, `zoom:api-call` (with durationMs), `zoom:api-error` (with zoomErrorCode), `zoom:token-cache-hit`, `zoom:oauth-token-refreshed`, `zoom:join-via-sdk`/`zoom:join-via-url`, `zoom:panelists-synced`, `zoom:credentials-saved`; performance: OAuth token cache with 5-min pre-expiry, Promise.all on all parallel queries, Prisma select everywhere, no N+1 patterns; `@zoom/meetingsdk@^6.0.0` in `serverExternalPackages`; **Component View (in-page embed) works under React 19** via `src/components/zoom/zoom-web-embed.tsx` which dynamic-imports `@zoom/meetingsdk/embedded` at runtime — the SDK's bundled React 18 lives inside its own UMD closure and never collides with the app's React 19. The iframe fallback `src/components/zoom/zoom-embed.tsx` (pointing at `zoom.us/wc/join/`) is still preserved as a belt-and-braces escape hatch but not imported by default; Client View (`@zoom/meetingsdk` top-level entry, non-embedded) remains blocked because it mounts into the host fiber tree; supports Meeting (interactive, 1K), Webinar (broadcast, 10K), Webinar Series (recurring, type 9); migration `20260408000000_add_speaker_accommodation_and_zoom`; docs at `docs/ZOOM_INTEGRATION.html`

## Logging

Pino-based structured JSON logging with three output modes:

- **Development**: Pretty-print to console + JSON to `logs/app.log` and `logs/error.log`
- **Vercel (production)**: stdout (Vercel's built-in logs) + database (`SystemLog` table) for the `/logs` web viewer
- **EC2/Docker (production)**: stdout + `logs/app.log` + `logs/error.log`

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

- `docs/DEVELOPMENT_STATUS.md` - Feature status and roadmap
- `docs/ZOOM_INTEGRATION.html` - Zoom SDK integration guide (architecture, setup, file list)
- `.env.example` - Environment variable template
