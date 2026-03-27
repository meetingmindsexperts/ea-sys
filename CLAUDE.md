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
- **Email:** Brevo (formerly Sendinblue)
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
│   │   │       └── settings/
│   │   └── settings/        # Organization settings
│   ├── e/                   # Public event pages (no auth)
│   │   └── [slug]/          # Redirects to /e/[slug]/register
│   │       ├── register/    # Submitter registration form (public)
│   │       ├── submitAbstract/ # Abstract submission form (public, post-login)
│   │       └── confirmation/
│   ├── uploads/             # Static file serving for uploaded photos
│   │   └── [...path]/       # Catch-all: streams files from public/uploads/
│   └── api/                 # API routes
│       ├── auth/            # Auth endpoints
│       ├── events/          # Event CRUD (protected)
│       │   └── [eventId]/   # Event-specific endpoints
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
- `src/components/ui/title-select.tsx` - Title enum dropdown (Mr, Ms, Mrs, Dr, Prof, Other)
- `src/components/ui/registration-type-select.tsx` - Registration type dropdown (fetches from TicketType or falls back to text input)
- `src/components/ui/tiptap-editor.tsx` - WYSIWYG email editor (Tiptap v2) with toolbar and source toggle
- `src/components/email-preview-dialog.tsx` - Email preview dialog with desktop/mobile toggle
- `src/lib/schemas.ts` - Shared Zod schemas (titleEnum) used across API routes
- `src/components/forms/person-form-fields.tsx` - Shared form fields for attendees/speakers/contacts
- `src/app/api/upload/photo/route.ts` - Photo upload endpoint with validation
- `src/app/uploads/[...path]/route.ts` - Static file handler for uploaded photos (streams from public/uploads/)
- `src/middleware.ts` - Route-level REVIEWER/SUBMITTER redirects
- `src/lib/stripe.ts` - Stripe SDK singleton, zero-decimal currency helpers (`isZeroDecimalCurrency`, `toStripeAmount`, `fromStripeAmount`)
- `src/components/speakers/import-registrations-dialog.tsx` - Dialog to import event registrations as speakers
- `src/components/speakers/import-registrations-button.tsx` - Button trigger for import-registrations dialog
- `src/app/(dashboard)/my-registration/page.tsx` - Registrant self-service portal (view/edit registrations, payment status)
- `src/app/api/registrant/registrations/route.ts` - Registrant self-edit API (GET list, PUT attendee details with ownership check)
- `src/app/api/events/[eventId]/registrations/bulk-type/route.ts` - Bulk update registration type (PATCH, adjusts soldCounts + syncs attendee.registrationType)
- `src/lib/default-terms.ts` - Default registration terms & conditions HTML
- `src/app/globals.css` - Global styles and CSS variables

## Database Models

- **Organization** - Organization entity (currently single-org mode)
- **User** - Users with roles (SUPER_ADMIN, ADMIN, ORGANIZER, REVIEWER, SUBMITTER, REGISTRANT)
- **Event** - Events with status tracking; includes `eventType` (CONFERENCE/WEBINAR/HYBRID), `tag`, and `specialty` fields; `registrationWelcomeHtml` and `registrationTermsHtml` for public registration form content
- **TicketType** - Registration type configurations (displayed as "Registration Types" in UI); `ticketTypeId` is the single source of truth — `attendee.registrationType` is auto-synced
- **Registration** - Event registrations; `userId` (nullable FK) links to User for registrant self-service
- **Attendee** - Attendee information; includes `title` (Title enum), `photo`, `city`, `country`, `registrationType`, and `dietaryReqs` fields
- **Speaker** - Event speakers; includes `title` (Title enum), `photo`, `city`, `country`, `specialty`, and `registrationType` fields; `specialty` is set during submitter registration and editable from dashboard; speakers can be added manually, via CSV import, or imported from the event's registrations
- **EventSession** - Schedule sessions
- **Track** - Session tracks
- **Abstract** - Paper submissions; includes `specialty` field; `managementToken` for public token-based access
- **Hotel/RoomType/Accommodation** - Lodging management
- **Contact** - Contact store for organization; includes `title` (Title enum), `photo`, `city`, `country`, and `registrationType` fields
- **Payment** - Stripe payment records linked to Registration; stores amount, currency, stripePaymentId (unique), stripeCustomerId, status, receiptUrl, metadata (JSON)
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
BREVO_API_KEY="..."                   # Email service
EMAIL_FROM="..."                      # Sender email
EMAIL_FROM_NAME="..."                 # Sender name
LOG_LEVEL="info"                      # debug, info, warn, error
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
- `useReviewers`, `useAddReviewer`, `useRemoveReviewer`
- `useEvents`, `useEvent`

## Recent Features

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
- **Badge PDF generation** - Server-side PDF generation with `pdfkit` + `bwip-js` (Code128 barcodes); A4 layout with 6 badges per page (2×3 grid, 4"×3" each); badge dialog for selected or all registrations
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
- **2-step public registration form** - Step 1: email + password (account creation) with organizer-customizable welcome HTML content; Step 2: personal details + category selection + terms & conditions; `registrationWelcomeHtml` and `registrationTermsHtml` fields on Event model, both editable via TiptapEditor on registration types settings page; default terms auto-seeded on event creation
- **Bulk registration type update** - PATCH at `/api/events/[eventId]/registrations/bulk-type`; bulk select registrations → change type via dialog; atomically adjusts soldCounts (decrement old types, increment new) and syncs `attendee.registrationType`; "Change Type" button in bulk selection toolbar on registrations page
- **Single source of truth for registration type** - `ticketTypeId` is the canonical reference for registration type; `attendee.registrationType` text field auto-synced from `ticketType.name` on create and type change; removed `registrationType` from registration edit forms and Zod schemas; CSV export uses `ticketType.name`; speakers/contacts retain `registrationType` as independent field (no `ticketTypeId` on those models)
- **Event-scoped login** - `/e/[slug]/login` page with event branding (banner, name, dates); `redirect` param routes to registration portal or abstracts after login; "Don't have an account?" links to register/abstract forms; reviewer invitation emails link to event-scoped login after accepting invitation
- **Event-scoped my-registration** - `/e/[slug]/my-registration` shows registration for specific event with event branding; global `/my-registration` shows all events; registration form sign-in links to event-scoped portal
- **PresentationType on abstracts** - `PresentationType` enum (ORAL/POSTER) added to Abstract model; dropdown in submit/edit dialogs and full-page forms; badge displayed on abstract cards
- **Full-page abstract submission** - Submitters use `/events/[eventId]/abstracts/new` (2-column layout: content + sidebar) instead of dialog; edit at `/events/[eventId]/abstracts/[id]/edit` with reviewer feedback display, draft/submit actions; plain Textarea for content (not WYSIWYG — cleaner for academic text)
- **Abstract register page** - `/e/[slug]/abstract/register` with 2-step flow (account → details), separate `abstractWelcomeHtml` field; REGISTRANT→SUBMITTER role upgrade supported
- **Reviewer portal improvements** - Reviewers can now review, score (0-100), accept/reject abstracts; review dialog and buttons enabled for REVIEWER role; header permissions corrected; event list links go directly to `/abstracts`
- **PDF quote/proforma** - Generated with pdfkit; includes event details, line items, tax calculation (taxRate + taxLabel), bank transfer details, branded layout; attached to confirmation email for paid registrations; downloadable from registrant portal and admin detail sheet
- **Tax & payment** - `taxRate` (Decimal), `taxLabel`, `bankDetails` on Event model; tax config in Settings → Registration tab; Stripe `automatic_tax` enabled on checkout sessions
- **Abstract notification improvements** - Email sent when reviewer adds notes/score without status change (not just on status change); login link in notification uses event-scoped URL
- **Bulk email for abstract submitters** - Select abstracts → send email; email types: Abstract Accepted, Rejected, Revision Requested, Submission Reminder, Custom; `abstract-reminder` template added to defaults; deduplicates by speaker email
- **Smart /e/[slug]/register redirect** - Auto-redirects to first active tier (Early Bird → Standard → Onsite); skips Presenter (shared separately by organizer); shows "Registration Closed" if no active tiers
- **Settings: branding split** - Branding (banner + footer) and Email Branding (header image + footer) separated into distinct tabs
- **UI polish** - Public form widths increased to `max-w-5xl`; font sizes increased to 16px base; all select dropdowns use `w-full`; Tiptap source mode formats HTML with indentation; Tailwind safelist for DB-stored HTML classes; footer/welcome/terms rendered with `prose` + `[&>*]:mb-4`; sheet width fix (removed hardcoded 540px)

## Current Mode

**Single Organization Mode** (multi-org support planned for later):
- User account registration is disabled (`/register` redirects to `/login`)
- Team members (Admin/Organizer) must be invited by an admin via Settings → Users
- Reviewers are org-independent (`User.organizationId = null`) — invited per-event via the Reviewers page
- Submitters are org-independent (`User.organizationId = null`) — self-register per event via `/e/[slug]/register`
- Registrants are org-independent (`User.organizationId = null`) — create accounts during public event registration, see only `/my-registration` portal
- Public event registration is open to all at `/e/[event-slug]`

## Logging

Pino-based structured JSON logging with three output modes:

- **Development**: Pretty-print to console + JSON to `logs/app.log` and `logs/error.log`
- **Vercel (production)**: stdout (Vercel's built-in logs) + database (`SystemLog` table) for the `/logs` web viewer
- **EC2/Docker (production)**: stdout + `logs/app.log` + `logs/error.log`

### Log Viewer (`/logs`)
- SUPER_ADMIN-only web UI at `/logs` with retro terminal theme
- Supports three sources: **Database** (default on Vercel), **File**, **Docker**
- Filters: level (error/warn/info), time range (10m to all), search text
- Auto-refresh (5s interval), export to text file

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
- `.env.example` - Environment variable template
