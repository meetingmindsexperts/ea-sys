# EA-SYS Project Handover Document

This document explains the EA-SYS codebase for someone taking it over. It covers what everything does, where it lives, and why decisions were made.

---

## Table of Contents

1. [Project Overview & Quick Start](#1-project-overview--quick-start)
2. [Architecture Overview](#2-architecture-overview)
3. [Database Schema & Models](#3-database-schema--models)
4. [Authentication & Authorization (RBAC)](#4-authentication--authorization-rbac)
5. [API Route Patterns](#5-api-route-patterns)
6. [Frontend Architecture](#6-frontend-architecture)
7. [Feature Modules](#7-feature-modules)
8. [External Integrations](#8-external-integrations)
9. [Import System](#9-import-system)
10. [Logging & Monitoring](#10-logging--monitoring)
11. [Security](#11-security)
12. [Deployment & Infrastructure](#12-deployment--infrastructure)
13. [Testing](#13-testing)
14. [Known Gaps & Future Work](#14-known-gaps--future-work)
15. [Key Files Reference](#15-key-files-reference)

---

## 1. Project Overview & Quick Start

### What Is EA-SYS?

EA-SYS (Event Administration System) is a full-stack event management platform. Organizations use it to run conferences, webinars, and hybrid events. It handles the full lifecycle: creating events, managing registrations, coordinating speakers, reviewing abstract submissions, scheduling sessions, managing accommodation, and sending emails.

The primary production deployment is at **events.meetingmindsgroup.com** on AWS EC2.

### Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Framework | Next.js 16 (App Router) | Server components, API routes, middleware in one framework |
| Language | TypeScript | Type safety across the entire stack |
| Database | PostgreSQL (Supabase-hosted) | Relational data with complex joins; Supabase provides managed hosting |
| ORM | Prisma 6 | Type-safe queries, migrations, schema-as-code |
| Auth | NextAuth.js v5 (JWT) | Stateless sessions work on both EC2 and Vercel serverless |
| Styling | TailwindCSS 4 + Shadcn/ui | Utility-first CSS with pre-built accessible components |
| State | React Query (TanStack Query) | Caches API responses, instant navigation, background refresh |
| Email | Brevo (Sendinblue) | Transactional emails with templates |
| Logging | Pino | Structured JSON logging with multiple output targets |
| Deployment | Docker + Vercel | EC2 primary (Docker), Vercel as serverless fallback |
| Error Tracking | Sentry | Client + server error reporting |

### Quick Start (Local Development)

```bash
# 1. Clone and install
git clone <repo-url>
cd ea-sys
npm install

# 2. Environment setup
cp .env.example .env
# Edit .env with your database URL, NEXTAUTH_SECRET, etc.

# 3. Generate Prisma client
npx prisma generate

# 4. Push schema to database (or run migrations)
npx prisma db push        # For initial setup
# OR
npx prisma migrate deploy # If migrations exist

# 5. Start development server
npm run dev
# App runs at http://localhost:3000
```

### Common Commands

```bash
npm run dev              # Start dev server (port 3000)
npm run build            # Production build
npm run lint             # ESLint
npx tsc --noEmit         # TypeScript type check
npm run test             # Run tests (Vitest)
npm run test:watch       # Tests in watch mode
npx prisma studio        # Visual database browser
npx prisma db push       # Sync schema to DB (no migration file)
npx prisma migrate deploy # Run migration files
```

**After every code change, always run:**
```bash
npm run lint && npx tsc --noEmit && npm run build
```

---

## 2. Architecture Overview

### Directory Structure

```
src/
├── app/
│   ├── (auth)/              # Login, forgot-password, reset-password pages
│   ├── (dashboard)/         # Protected pages (requires authentication)
│   │   ├── dashboard/       # Home page with stats
│   │   ├── events/          # Event list + per-event modules
│   │   │   └── [eventId]/   # Registrations, speakers, schedule, abstracts, etc.
│   │   ├── contacts/        # Organization-wide contact CRM
│   │   ├── settings/        # Organization settings, team, API keys
│   │   ├── logs/            # Log viewer (SUPER_ADMIN only)
│   │   └── profile/         # User profile
│   ├── e/                   # Public pages (no auth required)
│   │   └── [slug]/          # Event registration, abstract submission
│   ├── api/                 # API routes (30+ files)
│   │   ├── events/[eventId]/ # Event-scoped endpoints
│   │   ├── contacts/        # Contact CRUD + import/export
│   │   ├── organization/    # Org settings, API keys, EventsAir
│   │   ├── upload/photo/    # Photo upload
│   │   └── public/          # Public API (no auth)
│   └── uploads/[...path]/   # Serves uploaded photos from filesystem
├── components/
│   ├── layout/              # Header, Sidebar
│   ├── ui/                  # Shadcn/ui + custom components
│   ├── forms/               # Shared form field components
│   ├── import/              # CSV and EventsAir import dialogs
│   └── providers.tsx        # QueryClient + SessionProvider
├── hooks/
│   └── use-api.ts           # All React Query hooks (40+ hooks)
├── lib/                     # Core utilities
│   ├── auth.ts              # NextAuth configuration
│   ├── auth-guards.ts       # denyReviewer() RBAC guard
│   ├── event-access.ts      # buildEventAccessWhere() role-scoped queries
│   ├── db.ts                # Prisma client singleton
│   ├── email.ts             # Brevo email service + templates
│   ├── eventsair-client.ts  # EventsAir GraphQL API client
│   ├── logger.ts            # Pino logging (3 output modes)
│   ├── storage.ts           # Photo storage (local or Supabase)
│   ├── csv-parser.ts        # Shared CSV parsing utilities
│   └── utils.ts             # Date formatting, helpers
├── contexts/
│   └── sidebar-context.tsx  # Sidebar collapsed state
├── types/                   # TypeScript interfaces
└── middleware.ts            # Route protection, CSRF, size limits
```

### Server Components vs Client Components

**Server components** (default in App Router) are used for pages that fetch data at request time:
- Dashboard page, event detail page, contact detail page
- These do `const data = await db.model.findMany(...)` directly
- No `"use client"` directive — they render on the server

**Client components** (`"use client"`) are used for interactive UI:
- Forms, modals, tables with sorting/filtering
- Components that need React hooks (`useState`, `useEffect`)
- Components that use React Query for data fetching

**Why this split?** Server components reduce JavaScript sent to the browser. Data fetching on the server avoids extra API round-trips. Client components are used only where interactivity is needed.

### Data Flow

**Server pages** (e.g., dashboard, contact detail):
```
Browser request → Server component → Prisma query → PostgreSQL → HTML response
```

**Client pages** (e.g., registrations list, speakers list):
```
Browser → React Query hook → fetch('/api/...') → API route → Prisma → PostgreSQL
                                                                      ↓
Browser ← React component ← React Query cache ← JSON response ←──────┘
```

React Query caches API responses for 5 minutes. When you navigate away and come back, the cached data shows instantly while a background refresh happens.

---

## 3. Database Schema & Models

The schema lives in `prisma/schema.prisma`. Here are the models and why they exist:

### Core Models

**Organization** — The company/institution using EA-SYS. Currently single-org mode (one org per deployment). The `settings` JSON field stores org-level config including EventsAir credentials.

**User** — People who log into the system. Has a `role` field (see RBAC section). Key design decision: `organizationId` is **nullable** because REVIEWER and SUBMITTER users are org-independent (explained in RBAC section).

**Event** — Conferences, webinars, or hybrid events. The `settings` JSON field stores per-event config including `reviewerUserIds` (array of User IDs assigned as reviewers). The `slug` field enables public URLs like `/e/my-conference/register`. Classification fields: `eventType` (CONFERENCE/WEBINAR/HYBRID), `tag`, and `specialty` for categorization.

### Registration Models

**Attendee** — A person who registers for an event. Identified by unique `email`. Contains personal info (title, name, org, job title, phone, photo, city, country) plus event-specific fields (specialty, registrationType, tags, dietaryReqs, bio). The `customFields` JSON supports arbitrary per-event data. The `externalId` field tracks the original ID when imported from EventsAir.

**Registration** — Links an Attendee to an Event via a TicketType. Tracks status (PENDING/CONFIRMED/CANCELLED/WAITLISTED/CHECKED_IN) and payment status (UNPAID/PENDING/PAID/REFUNDED/FAILED). Each registration gets a unique `qrCode` for check-in. Composite indexes on `[eventId, status]` and `[eventId, ticketTypeId]` speed up filtered queries (e.g., "show all confirmed registrations").

**TicketType** — Displayed as "Registration Types" in the UI. Defines what kinds of registrations an event offers (e.g., "Speaker", "Delegate", "VIP"). Has price, quantity limits, sales dates, and an `isActive` toggle. The `soldCount` is updated transactionally when registrations are created/cancelled to prevent overselling.

**Payment** — Payment records for registrations. Scaffolded for Stripe integration but not actively processing payments yet.

### Speaker & Abstract Models

**Speaker** — Event speakers. Like Attendee, identified by unique `email` per event (`@@unique([eventId, email])`). The nullable `userId` field is crucial: it links a speaker to a User account, enabling the SUBMITTER role (speakers who log in to submit abstracts). Includes all person fields plus `socialLinks` JSON.

**Abstract** — Paper/presentation submissions. Linked to a Speaker and optionally to a Track. Follows a lifecycle: DRAFT → SUBMITTED → UNDER_REVIEW → ACCEPTED/REJECTED/REVISION_REQUESTED. The `managementToken` (unique random string) enables public token-based access to abstracts without authentication. Reviewers add `reviewNotes` and `reviewScore`. When accepted, an abstract can be linked to an EventSession.

**Track** — Categories for organizing sessions and abstracts (e.g., "Cardiology", "Oncology"). Has a `color` field for UI display and `sortOrder` for custom ordering.

### Schedule Models

**EventSession** — A scheduled talk/workshop/break. Has time, location, capacity, and status. The unique `abstractId` field creates a 1:1 link with accepted abstracts (a session is created from an accepted abstract).

**SessionSpeaker** — Many-to-many join table between sessions and speakers. A session can have multiple speakers, and a speaker can present at multiple sessions. The `role` field defaults to "speaker" but could be "moderator", "panelist", etc.

### Accommodation Models

**Hotel** — Venues for lodging. Has contact info, star rating, images (JSON array).

**RoomType** — Room categories within a hotel (e.g., "Standard", "Deluxe"). Tracks inventory (`totalRooms`, `bookedRooms`) with pricing.

**Accommodation** — Booking record linking a Registration to a RoomType. 1:1 with Registration (`@@unique([registrationId])`).

### Organization Models

**Contact** — Org-level CRM. Contacts are people the organization has interacted with across events. Can be reused when creating registrations or speakers (imported into events). Has all person fields plus `notes` and `tags` for categorization. Unique per org+email.

**ApiKey** — External API authentication. For tools like n8n or webhooks that need to call EA-SYS APIs. Keys are stored as hashed values (`keyHash`), with a `prefix` shown to the user for identification.

### Audit & Logging Models

**AuditLog** — Records actions taken in the system (CREATE, UPDATE, DELETE on any entity). Stores the `changes` JSON with before/after state. Used for compliance and debugging.

**SystemLog** — Stores Pino log entries in PostgreSQL. Exists because Vercel serverless has no writable filesystem for log files. A custom Pino transport buffers entries and batch-inserts them. Queried by the `/logs` viewer UI.

### Enums

```
UserRole:           SUPER_ADMIN, ADMIN, ORGANIZER, REVIEWER, SUBMITTER
Title:              MR, MS, MRS, DR, PROF, OTHER
EventStatus:        DRAFT, PUBLISHED, LIVE, COMPLETED, CANCELLED
EventType:          CONFERENCE, WEBINAR, HYBRID
RegistrationStatus: PENDING, CONFIRMED, CANCELLED, WAITLISTED, CHECKED_IN
PaymentStatus:      UNPAID, PENDING, PAID, REFUNDED, FAILED
SpeakerStatus:      INVITED, CONFIRMED, DECLINED, CANCELLED
AbstractStatus:     DRAFT, SUBMITTED, UNDER_REVIEW, ACCEPTED, REJECTED, REVISION_REQUESTED
SessionStatus:      DRAFT, SCHEDULED, LIVE, COMPLETED, CANCELLED
AccommodationStatus: PENDING, CONFIRMED, CANCELLED, CHECKED_IN, CHECKED_OUT
```

---

## 4. Authentication & Authorization (RBAC)

### Authentication Setup

**File:** `src/lib/auth.ts`

NextAuth.js v5 with Credentials provider (email + password). JWT session strategy (not database sessions).

**Why JWT?** Stateless tokens work identically on EC2 (Docker) and Vercel (serverless). Database sessions would require a connection on every request, which is expensive on serverless.

**Session lifetime:** 24 hours. After that, users must log in again.

**JWT role re-validation:** Every 5 minutes, the JWT callback queries the database to check if the user's role has changed. This prevents a scenario where an admin changes someone's role but their old JWT still grants elevated access. The DB query is non-blocking — if it fails, the existing role is kept.

### The 5 Roles

| Role | Scope | Can Do | Cannot Do |
|------|-------|--------|-----------|
| **SUPER_ADMIN** | Entire organization | Everything + view logs | — |
| **ADMIN** | Entire organization | Everything except logs | View system logs |
| **ORGANIZER** | Entire organization | Manage events, registrations, speakers, etc. | Manage team members, org settings |
| **REVIEWER** | Assigned events only | Review abstracts, add scores/notes | Create/edit events, registrations, speakers |
| **SUBMITTER** | Own events only | Submit/edit own abstracts | Everything else |

### Org-Bound vs Org-Independent Users

This is a critical design decision:

- **ADMIN and ORGANIZER** have `organizationId` set. They belong to one organization and can only see that org's data.
- **REVIEWER and SUBMITTER** have `organizationId: null`. They are independent entities.

**Why?** A reviewer might review abstracts for events across multiple organizations. A submitter registers per-event and shouldn't be tied to any org. Making them org-independent allows one reviewer account to be assigned to events from different organizations.

**Consequence:** In admin-only code paths, `session.user.organizationId!` (non-null assertion) is used because we know admins always have an org. But this would crash for reviewers — so reviewer code paths never assume `organizationId` exists.

### 3-Layer RBAC Enforcement

RBAC is enforced at three layers. If any one layer is bypassed (e.g., a client-side bug), the others still protect the system.

**Layer 1: API Guards** (`src/lib/auth-guards.ts`)

Every POST/PUT/DELETE API handler (except abstract operations) calls:
```typescript
const denied = denyReviewer(session);
if (denied) return denied; // Returns 403 Forbidden
```
This blocks both REVIEWER and SUBMITTER from write operations. It's a simple null check — if the function returns a response, the handler returns it immediately.

**Layer 2: Middleware** (`src/middleware.ts`)

The middleware runs on every dashboard request and redirects restricted roles:
- `/dashboard`, `/settings`, `/logs` → redirected to `/events`
- `/events/new` → redirected to `/events`
- `/events/[id]/registrations` (or speakers, schedule, etc.) → redirected to `/events/[id]/abstracts`

This means even if a reviewer manually types a URL, they get redirected to the only page they're allowed to see.

**Layer 3: UI Hiding**

The sidebar hides navigation items based on role. Write-action buttons (Create, Edit, Delete) are hidden for restricted roles. The header shows "Reviewer Portal" or "Submitter Portal" to make the restricted context clear.

### Event Scoping

**File:** `src/lib/event-access.ts`

Different roles see different events. The `buildEventAccessWhere()` function generates the Prisma `where` clause:

- **ADMIN/ORGANIZER:** `{ organizationId: user.organizationId }` — all org events
- **REVIEWER:** `{ settings.reviewerUserIds contains user.id }` — only events they're assigned to
- **SUBMITTER:** `{ speakers.some.userId = user.id }` — only events where they have a Speaker record

This function is used in every event listing query and event detail page.

---

## 5. API Route Patterns

### Standard Pattern

Every API route follows this structure:

```typescript
export async function POST(req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    // 1. Parallelize auth + params + body parsing
    const [{ eventId }, session, body] = await Promise.all([
      params,
      auth(),
      req.json(),
    ]);

    // 2. Check authentication
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 3. Block restricted roles on write operations
    const denied = denyReviewer(session);
    if (denied) return denied;

    // 4. Verify the user has access to this event
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // 5. Validate input with Zod
    const validated = schema.safeParse(body);
    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    // 6. Execute business logic
    const result = await db.model.create({ data: validated.data });

    // 7. Return response
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    // 8. Log and return error
    apiLogger.error({ err: error, msg: "Failed to create resource" });
    return NextResponse.json({ error: "Failed to create resource" }, { status: 500 });
  }
}
```

### Why Promise.all() Everywhere?

Fetching `params`, `auth()`, and `req.json()` are all async operations that don't depend on each other. Running them in parallel saves ~50-100ms per request compared to sequential `await`.

Similarly, when a route needs to check an event exists AND fetch related data, both queries run in parallel:
```typescript
const [event, speakers] = await Promise.all([
  db.event.findFirst({ where: { id: eventId, organizationId } }),
  db.speaker.findMany({ where: { eventId } }),
]);
```

### auth() vs getOrgContext()

- **`auth()`** — From NextAuth. Returns the session from the JWT cookie. Used for dashboard routes where only logged-in users access the API.
- **`getOrgContext()`** (`src/lib/api-auth.ts`) — Tries `auth()` first, then falls back to API key authentication (Bearer token). Used for routes that external tools (n8n, webhooks) might call.

### Cache Headers

GET endpoints set cache headers for React Query:
```typescript
response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
```
This means: don't cache on CDNs (private), always revalidate (max-age=0), but serve stale data for up to 30s while revalidating in the background.

---

## 6. Frontend Architecture

### React Query

**File:** `src/hooks/use-api.ts` (all hooks), `src/components/providers.tsx` (config)

React Query (TanStack Query) manages all client-side data fetching. It provides:

- **Caching:** API responses are cached for 5 minutes (`staleTime`). Navigating between pages is instant because cached data displays immediately.
- **Background refresh:** When data is stale, React Query refetches in the background and updates the UI silently.
- **Window focus refresh:** When a user switches back to the tab, data refreshes automatically.
- **Mutation invalidation:** After creating/updating/deleting, the relevant cache is invalidated so lists refresh.

**Configuration:**
```typescript
staleTime: 5 * 60 * 1000,    // 5 minutes — data considered fresh
gcTime: 30 * 60 * 1000,      // 30 minutes — unused cache kept
retry: 1,                     // Retry failed requests once
refetchOnWindowFocus: true,   // Refresh on tab focus
```

**Query keys** follow a hierarchical pattern:
```typescript
queryKeys = {
  events: ["events"],
  event: (id) => ["events", id],
  tickets: (eventId) => ["events", eventId, "tickets"],
  registrations: (eventId) => ["events", eventId, "registrations"],
  // ...
};
```

When a ticket is created, `queryClient.invalidateQueries({ queryKey: queryKeys.tickets(eventId) })` runs, causing the tickets list to refetch.

### Sidebar State

**File:** `src/contexts/sidebar-context.tsx`

The sidebar collapsed/expanded state is stored in `localStorage`. It uses `useSyncExternalStore` instead of `useState + useEffect`.

**Why?** Server-rendered HTML doesn't know the localStorage value. With `useState + useEffect`, the server renders one state, then the client hydrates with a different state, causing a visible flash. `useSyncExternalStore` handles this by providing a server snapshot (default state) that matches what the client will use until hydration completes. It also avoids the ESLint `react-hooks/set-state-in-effect` warning.

### Shared Components

**PersonFormFields** (`src/components/forms/person-form-fields.tsx`) — Reusable form fields for any "person" entity (attendee, speaker, contact). Controlled via props: `showBio`, `showDietaryReqs`, `showWebsite`, etc. Includes TitleSelect, CountrySelect, SpecialtySelect, RegistrationTypeSelect, PhotoUpload, TagInput.

**PhotoUpload** (`src/components/ui/photo-upload.tsx`) — File upload with client-side validation (500KB max, JPEG/PNG/WebP). Shows preview, progress, and remove button. Uploads to `/api/upload/photo` and returns a path like `/uploads/photos/2024/01/uuid.jpg`.

**TagInput** (`src/components/ui/tag-input.tsx`) — Multi-tag chip input. Enter or comma adds a tag, × removes it, Backspace on empty removes the last tag. Tags are normalized (trimmed, lowercased via `normalizeTag()`).

**CountrySelect** (`src/components/ui/country-select.tsx`) — Searchable dropdown with 249 countries (ISO 3166-1 standard from `src/lib/countries.ts`).

**SpecialtySelect** (`src/components/ui/specialty-select.tsx`) — Dropdown with 45 medical specialties plus "Others". Searchable.

**TitleSelect** (`src/components/ui/title-select.tsx`) — Dropdown for name prefixes: Mr, Ms, Mrs, Dr, Prof, Other. Maps to the `Title` enum.

**RegistrationTypeSelect** (`src/components/ui/registration-type-select.tsx`) — Context-aware dropdown. With an `eventId`, fetches ticket types for that event. Without one, fetches all unique ticket type names across the organization via `/api/registration-types`. Used in contacts, registrations, and speakers.

### Styling

- **Primary color:** Cerulean Blue `#00aade` (oklch format in CSS variables)
- **Accent color:** Amber/Yellow
- **Gradients:** `bg-gradient-primary` and `btn-gradient` utilities
- **Components:** Shadcn/ui (Radix-based, accessible, customizable)
- **Component radius:** 10px base with utility scales
- **Status colors:** Consistent color coding — green for confirmed/active, yellow for pending, red for cancelled, blue for waitlisted, purple for checked-in

---

## 7. Feature Modules

### Events

**Pages:** `src/app/(dashboard)/events/page.tsx`, `src/app/(dashboard)/events/[eventId]/page.tsx`
**API:** `src/app/api/events/route.ts`, `src/app/api/events/[eventId]/route.ts`

CRUD for events. Each event has a slug for public URLs. Events can be imported from EventsAir (bulk import by year). The event detail page shows stats (registration count, speaker count, session count) and quick links to sub-modules.

Event settings include: name, dates, timezone, venue, banner image, event type, specialty, tags, abstract submission toggle/deadline, footer HTML (sanitized with DOMPurify).

### Registrations

**Page:** `src/app/(dashboard)/events/[eventId]/registrations/page.tsx`
**API:** `src/app/api/events/[eventId]/registrations/route.ts`, `.../[registrationId]/route.ts`

Lists attendee registrations with filtering by status, payment status, and ticket type. Search by name/email. Each registration opens a detail slide-out panel for editing attendee info, status, payment status, and notes.

Supports CSV export (all columns) and CSV import. Contacts from the org CRM can be imported as registrations. QR codes are auto-generated for each registration.

**Key implementation detail:** Ticket `soldCount` is updated inside a `$transaction` to prevent overselling race conditions. Cancelling a registration decrements `soldCount`; un-cancelling increments it.

### Speakers

**Page:** `src/app/(dashboard)/events/[eventId]/speakers/page.tsx`
**API:** `src/app/api/events/[eventId]/speakers/route.ts`

Manage event speakers. Speakers can be added manually, imported from CSV, or imported from org contacts. Each speaker can be linked to sessions and abstracts. The detail view shows their abstract submissions and session assignments.

Speakers with a linked `userId` are SUBMITTER-role users who can log in to submit abstracts.

### Abstracts

**Page:** `src/app/(dashboard)/events/[eventId]/abstracts/page.tsx`
**API:** `src/app/api/events/[eventId]/abstracts/route.ts`

Paper submission and review system. The workflow:

1. **Submission:** Speakers submit abstracts via the public form (`/e/[slug]/register` → login → abstracts page) or admins create them
2. **Review:** Reviewers see assigned abstracts and add scores + notes
3. **Decision:** Admins change status to ACCEPTED/REJECTED/REVISION_REQUESTED
4. **Notification:** Status changes trigger email notifications to the speaker

Abstracts page shows a "Submission URL" widget — a copyable link (`/e/[slug]/register`) that organizers share with speakers to invite submissions.

**Role-based views:**
- Admins: Full CRUD, all abstracts, review management
- Reviewers: Read-only view of assigned abstracts, can add review scores
- Submitters: See only own abstracts, can edit DRAFT/REVISION_REQUESTED ones

### Schedule

**Page:** `src/app/(dashboard)/events/[eventId]/schedule/page.tsx`, `schedule/calendar/page.tsx`
**API:** `src/app/api/events/[eventId]/sessions/route.ts`, `.../tracks/route.ts`

Manage sessions (talks, workshops, breaks). Sessions are organized by tracks (categories with colors). Each session can be linked to an accepted abstract and assigned speakers.

The calendar view provides a visual timeline of the schedule.

### Accommodation

**Page:** `src/app/(dashboard)/events/[eventId]/accommodation/page.tsx`
**API:** `src/app/api/events/[eventId]/hotels/route.ts`, `.../accommodations/route.ts`

Hotel and room management. Hotels have room types with pricing and inventory tracking. Accommodation bookings link registrations to room types with check-in/out dates and special requests.

### Contacts

**Pages:** `src/app/(dashboard)/contacts/page.tsx`, `contacts/new/page.tsx`, `contacts/[contactId]/page.tsx`, `contacts/[contactId]/edit/page.tsx`
**API:** `src/app/api/contacts/route.ts`, `contacts/[contactId]/route.ts`, `contacts/export/route.ts`, `contacts/import/route.ts`

Organization-level CRM. Contacts persist across events — when you add someone as a registration or speaker, they can be imported from the contact store. Contacts can be tagged, and bulk tag operations (add, remove, replace) are supported.

CSV import and export are available. The detail page shows event history — all events where this contact appeared as a speaker or attendee.

### Settings

**Page:** `src/app/(dashboard)/settings/page.tsx`
**API:** `src/app/api/organization/route.ts`, various sub-routes

Organization configuration:
- **Team management:** Invite users by email, assign roles, remove members
- **API keys:** Create/revoke keys for external integrations
- **EventsAir integration:** Enter OAuth credentials, test connection
- **Organization info:** Name, logo

---

## 8. External Integrations

### EventsAir

**File:** `src/lib/eventsair-client.ts`

EventsAir is an external event management platform. EA-SYS can import events and contacts from EventsAir via its GraphQL API.

**Authentication:** OAuth 2.0 client credentials flow.
- Token endpoint: `login.microsoftonline.com/dff76352-.../oauth2/v2.0/token`
- Scope: `eventsairprod.onmicrosoft.com/85d8f626-.../.default`
- Tokens are cached in memory with a 60-second expiry buffer

**Credential storage:** Client ID is stored in plain text in `Organization.settings`. Client Secret is encrypted with AES-256-GCM before storage. The encryption key is derived from `NEXTAUTH_SECRET` via SHA-256.

**GraphQL API:**
- Endpoint: `https://api.eventsair.com/graphql`
- Uses custom scalar types: `ID!` (not `String!`), `NonNegativeInt!` (not `Int!`), `PaginationLimit!` (not `Int!`)
- Pagination: Fetch in batches of 500 contacts or 2000 events

**Contact field mapping (EventsAir → EA-SYS):**
| EventsAir Field | EA-SYS Field |
|-----------------|--------------|
| `firstName` | `firstName` |
| `lastName` | `lastName` |
| `primaryEmail` | `email` |
| `organizationName` | `organization` |
| `jobTitle` | `jobTitle` |
| `primaryAddress.city` | `city` |
| `primaryAddress.country` | `country` |
| `primaryAddress.phone` / `workPhone` | `phone` |
| `biography` | `bio` |
| `photo.url` | `photo` |
| `id` | `externalId` |

**Settings UI:** Located in the Settings page. Users enter Client ID and Client Secret, test the connection, then use the EventsAir import dialog to browse and import events.

### Brevo Email

**File:** `src/lib/email.ts`

Brevo (formerly Sendinblue) handles transactional emails. The SDK is lazily initialized on first use to avoid module load overhead.

**Email templates include:**
- User invitation with token link
- Abstract status notifications (ACCEPTED, REJECTED, REVISION_REQUESTED, UNDER_REVIEW)
- Registration confirmations
- Bulk email with unsubscribe support
- Password reset links

**Security:** All dynamic content in email templates is HTML-escaped via `escapeHtml()` to prevent injection.

**Configuration:**
- `BREVO_API_KEY` — API key from Brevo dashboard
- `EMAIL_FROM` — Sender email (must be verified in Brevo)
- `EMAIL_FROM_NAME` — Sender display name

### Sentry

**Files:** `sentry.server.config.ts`, `sentry.edge.config.ts`, `src/instrumentation-client.ts`

Error tracking for both server and client. Client-side uses Replay integration (10% session sample, 100% on error). Source maps are uploaded during build via `SENTRY_AUTH_TOKEN`.

### Supabase Storage

**File:** `src/lib/storage.ts`

Photo uploads use a provider pattern controlled by `STORAGE_PROVIDER` env var:
- **`"local"` (default, EC2):** Files stored in `public/uploads/photos/YYYY/MM/UUID.ext`. Served by the catch-all handler at `src/app/uploads/[...path]/route.ts`.
- **`"supabase"` (Vercel):** Files stored in Supabase Storage bucket. Returns CDN URLs directly. Required because Vercel serverless has no writable filesystem.

---

## 9. Import System

### CSV Imports

**Parser:** `src/lib/csv-parser.ts` — Shared utilities: `parseCSV()`, `parseCSVLine()`, `getField()`, `parseTags()`. Handles quoted fields, commas within quotes, and different line endings.

**Import routes** (all at `src/app/api/events/[eventId]/import/`):
- `registrations/route.ts` — Import attendees and create registrations
- `speakers/route.ts` — Import speakers
- `sessions/route.ts` — Import schedule sessions (auto-creates tracks)
- `abstracts/route.ts` — Import abstract submissions

**UI:** `src/components/import/csv-import-dialog.tsx` — Reusable dialog for all 4 entity types. Shows file upload, preview (first 5 rows), template download link, and import results.

**Pattern:** Each import route:
1. Parses the CSV file
2. Validates required columns exist
3. Iterates rows, upserts records (creates if new, updates if existing by email)
4. Returns `{ created, skipped, errors }` counts

### EventsAir Imports

**UI:** `src/components/import/eventsair-import-dialog.tsx`

**Event import flow:**
1. Fetch all events from EventsAir API (paginated)
2. User filters by year
3. Multi-select events with checkboxes
4. Import sequentially (not parallel, to respect rate limits)
5. Each imported event creates an Event record with `externalId` and `externalSource: "eventsair"`

**Contact import flow:**
1. After an event is imported, user triggers contact import
2. Fetches contacts from EventsAir in batches of 500
3. For each contact: upserts Attendee, creates Registration
4. Maps EventsAir fields to EA-SYS fields (see table in EventsAir section)

### Contact Imports

**Route:** `src/app/api/contacts/import/route.ts`
**UI:** `src/components/contacts/import-contacts-dialog.tsx`

Contacts can be imported from CSV into the org-level CRM. They can then be reused across events — imported as registrations or speakers via dedicated import buttons on those pages.

---

## 10. Logging & Monitoring

### Pino Logger

**File:** `src/lib/logger.ts`

Structured JSON logging with Pino. Three output modes based on environment:

**Development:**
- Pretty-printed console output (readable)
- JSON to `logs/app.log` (all levels)
- JSON to `logs/error.log` (error level only)

**Vercel (production):**
- stdout (Vercel's built-in log viewer)
- Database: Custom `Writable` stream buffers entries and batch-inserts into `SystemLog` table every 2 seconds or 20 entries (whichever comes first)
- Debug-level logs are skipped in DB to reduce load

**EC2/Docker (production):**
- stdout
- `logs/app.log` and `logs/error.log`

**Why database logging?** Vercel serverless functions can't write to the filesystem. The `SystemLog` table provides persistent, queryable logs for the web viewer.

**Lazy Prisma import:** The logger uses `require("@/lib/db")` instead of `import` to avoid circular dependencies (`db.ts` imports logger for error logging → logger imports db for log storage).

### Logger Modules

```typescript
import { apiLogger, authLogger, dbLogger, eventLogger } from "@/lib/logger";
```

Each module adds a `module` field to log entries for filtering:
- `apiLogger` — API route operations
- `authLogger` — Authentication events (login, JWT refresh)
- `dbLogger` — Database operations and errors
- `eventLogger` — Event-related operations

### Log Coverage

Every error path in the codebase logs before returning an error response:
- All API route `catch` blocks log via `apiLogger.error()`
- Middleware logs CSRF rejections and body size violations (uses `console.warn` with structured JSON — Edge runtime can't use Pino)
- Auth JWT callback logs DB lookup failures
- Server pages log DB query failures before re-throwing
- File upload handler logs path-traversal attempts
- CSV import logs validation errors

### Log Viewer

**UI:** `src/app/(dashboard)/logs/page.tsx` (SUPER_ADMIN only)
**API:** `src/app/api/logs/route.ts`

A retro terminal-themed log viewer with:
- **Source selector:** Database (default on Vercel), File (EC2), Docker
- **Filters:** Level (error, warn, info), time range (10min to all), text search
- **Auto-refresh:** Every 5 seconds
- **Export:** Download logs as text file

---

## 11. Security

### CSRF Protection

**File:** `src/middleware.ts`

On all mutation requests (POST/PUT/DELETE) to `/api/*`, the middleware checks that the `Origin` header matches the `Host` header. This prevents cross-site request forgery from malicious sites.

Exceptions: API key/Bearer token requests (used by external tools), auth endpoints, public endpoints.

### Request Size Limits

- **1MB** for all JSON API requests (enforced in middleware)
- **500KB** for photo uploads (enforced in upload route)

### Photo Upload Security

**File:** `src/app/api/upload/photo/route.ts`

Multi-layer validation:
1. **MIME type whitelist:** Only `image/jpeg`, `image/png`, `image/webp`
2. **Magic byte verification:** Reads the first 8 bytes and validates file signatures (e.g., JPEG starts with `0xFF 0xD8 0xFF`). Prevents uploading a PHP file renamed to `.jpg`.
3. **UUID filenames:** Files are stored as `{uuid}.{ext}` — never using the original filename. This prevents path traversal via filenames.
4. **Size limit:** 500KB max at the application level

### Path Traversal Protection

**File:** `src/app/uploads/[...path]/route.ts`

The photo serving route:
1. Rejects paths containing `..` or null bytes
2. Resolves symlinks and verifies the real path is within the uploads directory
3. Adds security headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, restrictive CSP

### Rate Limiting

**File:** `src/lib/security.ts`

In-memory rate limiting using a `Map` with periodic cleanup. Used for photo uploads (20/hour per user) and other sensitive operations.

**Known gap:** In-memory state resets on Vercel serverless cold starts. For Vercel, Redis (Vercel KV / Upstash) would be needed for persistent rate limiting. Documented in `docs/VERCEL_COMPATIBILITY.md`.

### Password Security

Passwords are hashed with `bcryptjs` (async comparison). Minimum 6 characters.

### Credential Encryption

**File:** `src/lib/eventsair-client.ts`

EventsAir OAuth client secrets are encrypted with AES-256-GCM before storage. The encryption key is derived from `NEXTAUTH_SECRET` via SHA-256. Format: `iv:authTag:ciphertext` (hex-encoded).

### Log Redaction

Pino automatically redacts sensitive fields from log output: `password`, `passwordHash`, `token`, `authorization`, `cookie`.

### HTML Escaping

**File:** `src/lib/email.ts`

All dynamic content in email templates passes through `escapeHtml()` to prevent stored XSS if someone enters malicious content in their name, organization, etc.

---

## 12. Deployment & Infrastructure

### Dual Deployment Strategy

EA-SYS runs on two platforms sharing the same database:

| Aspect | AWS EC2 (Primary) | Vercel (Secondary) |
|--------|-------------------|-------------------|
| URL | events.meetingmindsgroup.com | ea-sys.vercel.app |
| Runtime | Docker container | Serverless functions |
| Photo storage | Local filesystem | Supabase Storage |
| Logging | File-based (logs/app.log) | Database (SystemLog table) |
| Rate limiting | In-memory (works) | In-memory (resets on cold start) |
| Deploy | Blue-green via SSH | Git push to main |

Both connect to the same **Supabase PostgreSQL** database. This means migrations run once and affect both deployments.

### AWS EC2 Setup

**Instance:** t3.large
**OS:** Ubuntu
**Stack:** Docker + Nginx reverse proxy

**Blue-Green Deployment** (`scripts/deploy.sh`):
1. Two Docker containers: `ea-sys-blue` (port 3000) and `ea-sys-green` (port 3001)
2. The active container serves traffic via Nginx
3. To deploy: build the inactive container, run migrations, health-check it, then switch Nginx to point at it
4. If health check fails, the old container keeps serving — zero downtime

**Nginx:** Reverse proxy with upstream switching. Config at `/etc/nginx/conf.d/ea-sys-upstream.conf`. Graceful reload (`nginx -s reload`) ensures in-flight requests complete on the old container.

**Docker volumes:**
- `./public/uploads` — Shared photo storage between blue/green
- `./logs` — Shared log files
- `/var/run/docker.sock` — Read-only, for the log viewer to read Docker logs

### Docker Configuration

**Dockerfile** (multi-stage build):
1. **Builder:** `node:22-slim` + openssl, npm ci, prisma generate, next build
2. **Runner:** `node:22-slim` + openssl + curl + Docker CLI, copies standalone output, runs as non-root user (UID 1001)

**Why standalone output?** Next.js `output: "standalone"` creates a minimal production build (~200MB) that includes only needed dependencies. Much smaller than a full `node_modules` (~500MB+).

**Why Docker CLI in runner?** The log viewer API can read Docker container logs via `docker logs` command. The Docker socket is mounted read-only.

### Vercel Setup

**File:** `vercel.json`

```json
{
  "buildCommand": "prisma generate && prisma migrate deploy && next build",
  "functions": { "src/app/api/**/*.ts": { "maxDuration": 30 } }
}
```

Migrations run during the build step using `DIRECT_URL` (non-pooled connection, required for DDL). API functions have a 30-second timeout.

### CI/CD Pipeline

**File:** `.github/workflows/deploy.yml`

On push to `main`:
1. Install dependencies (`npm ci`)
2. Type check (`npm run type-check`)
3. Lint (`npm run lint`)
4. Build with Sentry source maps
5. SSH into EC2 and run `scripts/deploy.sh`

**Concurrency:** Only one deployment at a time. New pushes wait for the current deployment to finish.

### Database Connection Pattern

Two connection URLs:
- **`DATABASE_URL`** — Pooled connection via pgbouncer (port 6543). Used for all app queries. Connection pooling prevents overwhelming PostgreSQL with many connections from serverless functions.
- **`DIRECT_URL`** — Direct connection (port 5432). Used only for migrations, which need DDL operations that don't work through pgbouncer.

### Migration Safety

**Critical rule:** All migrations must be **idempotent** (safe to run multiple times).

Both AWS and Vercel run migrations against the same database. If a migration runs on one and then the other tries to run it again, it must not fail.

Pattern:
```sql
-- Good: won't fail if column already exists
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "bio" TEXT;

-- Good: won't fail if index already exists
CREATE UNIQUE INDEX IF NOT EXISTS "Event_slug_idx" ON "Event"("slug");

-- Bad: will fail if column already exists
ALTER TABLE "Attendee" ADD COLUMN "bio" TEXT;
```

**Additional gotcha:** `CREATE TABLE IF NOT EXISTS` is all-or-nothing. If the table exists (even missing columns), it's a complete no-op. Always follow with `ALTER TABLE ADD COLUMN IF NOT EXISTS` for each column.

**Another gotcha:** `prisma db push` creates INDEXES, not CONSTRAINTS. Use `CREATE UNIQUE INDEX IF NOT EXISTS`, not `ADD CONSTRAINT ... UNIQUE` (fails with error 42P07).

---

## 13. Testing

### Setup

**Framework:** Vitest
**Config:** `vitest.config.ts`
**Test directory:** `__tests__/lib/`

```bash
npm run test             # Run all tests once
npm run test:watch       # Watch mode
npm run test:coverage    # With coverage report
```

### Test Files (17 total)

| Test File | What It Tests |
|-----------|--------------|
| `utils.test.ts` | Date formatting, QR code generation, tag normalization |
| `auth-guards.test.ts` | `denyReviewer()` blocks REVIEWER/SUBMITTER, allows others |
| `event-access.test.ts` | `buildEventAccessWhere()` generates correct Prisma filters per role |
| `security.test.ts` | IP detection, rate limiting, token hashing |
| `api-key.test.ts` | API key validation and hashing |
| `schemas.test.ts` | Zod schema validation (titleEnum, etc.) |
| `sanitize.test.ts` | HTML/string sanitization |
| `registration-flow.test.ts` | Registration creation, status changes, ticket count updates |
| `speaker-flow.test.ts` | Speaker onboarding, abstract linking |
| `reviewer-access.test.ts` | Reviewer assignment, event scoping |
| `submitter-registration.test.ts` | SUBMITTER role creation, abstract submission |
| `abstract-lifecycle.test.ts` | Abstract: DRAFT → SUBMITTED → UNDER_REVIEW → ACCEPTED |
| `rbac.test.ts` | Full RBAC enforcement across all roles |
| `csv-parser.test.ts` | CSV parsing: quoted fields, commas, edge cases |
| `eventsair-client.test.ts` | Credential encryption/decryption |
| `csv-import-validation.test.ts` | CSV column validation for all entity types |
| `eventsair-api.test.ts` | EventsAir GraphQL query construction |

Tests are unit tests that mock Prisma and external services. They don't require a running database.

---

## 14. Known Gaps & Future Work

### Current Gaps

1. **Rate limiting on Vercel** — In-memory rate limiter resets on serverless cold starts. Needs Redis (Vercel KV / Upstash) for persistent rate limiting.

2. **Docker socket in production** — The Docker socket is mounted (read-only) in production containers for the log viewer to read Docker logs. This is a security consideration — if the container is compromised, the attacker could read other container info.

3. **Single-org mode** — Currently one organization per deployment. Multi-org support is planned but not implemented. The `organizationId` foreign key exists on all relevant models, so the schema is ready.

4. **No external cache** — No Redis/Memcached. Caching is done via React Query (client-side) and HTTP cache headers. For high-traffic scenarios, adding Redis would help.

5. **Payment processing** — Stripe integration is scaffolded (Payment model exists, env vars defined) but not actively processing payments. Ticket prices are stored but no checkout flow exists yet.

6. **No automated E2E tests** — Only unit tests exist. Playwright or Cypress E2E tests would improve confidence for deployment.

### Potential Improvements

- Add Redis for rate limiting, session storage, and caching
- Implement Stripe checkout flow for paid registrations
- Add Playwright E2E tests for critical flows (login, registration, abstract submission)
- Multi-org support (allow multiple organizations per deployment)
- WebSocket notifications for real-time updates
- Abstract file attachments (PDF uploads)

---

## 15. Key Files Reference

### Core Configuration

| File | Purpose |
|------|---------|
| `prisma/schema.prisma` | Database schema — all models, relationships, indexes, enums |
| `next.config.ts` | Next.js config — standalone output, package optimization, Sentry |
| `src/middleware.ts` | Route protection, CSRF, size limits, role redirects |
| `.env.example` | All environment variables with descriptions |
| `vercel.json` | Vercel build command and function config |
| `Dockerfile` | Multi-stage production Docker build |
| `docker-compose.prod.yml` | Blue-green production containers |
| `scripts/deploy.sh` | Zero-downtime blue-green deploy script |
| `.github/workflows/deploy.yml` | CI/CD pipeline (type-check → lint → build → deploy) |

### Authentication & Authorization

| File | Purpose |
|------|---------|
| `src/lib/auth.ts` | NextAuth config — credentials provider, JWT callbacks, role re-validation |
| `src/lib/auth.config.ts` | Edge-compatible auth config — route authorization rules |
| `src/lib/auth-guards.ts` | `denyReviewer()` — blocks REVIEWER/SUBMITTER on write operations |
| `src/lib/event-access.ts` | `buildEventAccessWhere()` — role-scoped event queries |
| `src/lib/api-auth.ts` | `getOrgContext()` — auth with session or API key fallback |
| `src/lib/api-key.ts` | API key validation for external tool access |

### Data & Business Logic

| File | Purpose |
|------|---------|
| `src/lib/db.ts` | Prisma client singleton (dev: global cache, prod: new instance) |
| `src/lib/email.ts` | Brevo email service — templates, sending, lazy init |
| `src/lib/eventsair-client.ts` | EventsAir GraphQL API — OAuth, queries, encryption |
| `src/lib/storage.ts` | Photo storage — local filesystem or Supabase Storage |
| `src/lib/csv-parser.ts` | CSV parsing — shared across all import routes |
| `src/lib/logger.ts` | Pino logging — 3 modes (dev/Vercel/EC2), DB stream |
| `src/lib/security.ts` | Rate limiting, IP detection, token hashing |
| `src/lib/utils.ts` | Date formatting (Dubai timezone), QR codes, helpers |
| `src/lib/schemas.ts` | Shared Zod schemas (titleEnum) |
| `src/lib/countries.ts` | ISO 3166-1 country list (249 countries) |
| `src/lib/sanitize.ts` | HTML sanitization (DOMPurify) |

### Frontend

| File | Purpose |
|------|---------|
| `src/hooks/use-api.ts` | All React Query hooks — 40+ data fetching operations |
| `src/components/providers.tsx` | QueryClient + SessionProvider setup |
| `src/contexts/sidebar-context.tsx` | Sidebar state with useSyncExternalStore |
| `src/components/layout/sidebar.tsx` | Navigation sidebar — role-based menu items |
| `src/components/layout/header.tsx` | Top header — event selector, profile dropdown |
| `src/components/forms/person-form-fields.tsx` | Reusable person form (10+ field types) |
| `src/components/ui/photo-upload.tsx` | Image upload with validation and preview |
| `src/components/ui/tag-input.tsx` | Multi-tag chip input |
| `src/components/ui/country-select.tsx` | Searchable country dropdown |
| `src/components/ui/specialty-select.tsx` | Medical specialty dropdown |
| `src/components/ui/title-select.tsx` | Title prefix dropdown (Mr/Ms/Dr/Prof) |
| `src/components/ui/registration-type-select.tsx` | Context-aware registration type dropdown |
| `src/components/import/eventsair-import-dialog.tsx` | EventsAir bulk import UI |
| `src/components/import/csv-import-dialog.tsx` | CSV import with preview and templates |
| `src/app/globals.css` | Theme colors (oklch), gradients, CSS variables |

### API Routes (Key Examples)

| File | Purpose |
|------|---------|
| `src/app/api/events/route.ts` | Event CRUD (list, create) |
| `src/app/api/events/[eventId]/registrations/route.ts` | Registration CRUD |
| `src/app/api/events/[eventId]/speakers/route.ts` | Speaker CRUD |
| `src/app/api/events/[eventId]/abstracts/route.ts` | Abstract CRUD |
| `src/app/api/events/[eventId]/import/eventsair/route.ts` | EventsAir contact import |
| `src/app/api/contacts/route.ts` | Contact CRUD |
| `src/app/api/contacts/export/route.ts` | Contact CSV export |
| `src/app/api/upload/photo/route.ts` | Photo upload with validation |
| `src/app/api/logs/route.ts` | Log viewer API (database/file/docker) |
| `src/app/api/registration-types/route.ts` | All unique registration type names |
| `src/app/uploads/[...path]/route.ts` | Serves uploaded photos from filesystem |

### Documentation

| File | Purpose |
|------|---------|
| `CLAUDE.md` | AI assistant project instructions |
| `docs/DEVELOPMENT_STATUS.md` | Feature status and roadmap |
| `docs/ARCHITECTURE.md` | System design and request flow |
| `docs/VERCEL_COMPATIBILITY.md` | EC2 vs Vercel differences and gaps |
| `docs/SECURITY_AUDIT_FIXES.md` | Security vulnerabilities found and fixed |
| `docs/EVENTSAIR_IMPORT.md` | EventsAir integration setup guide |
| `docs/LOGGING_AND_DEBUGGING.md` | Log configuration and viewing |
| `docs/DOCKER_LOGGING_GUIDE.md` | Docker log access and rotation |

---

## Appendix: Environment Variable Quick Reference

```env
# Database (required)
DATABASE_URL="postgresql://user:pass@host:6543/db?pgbouncer=true"
DIRECT_URL="postgresql://user:pass@host:5432/db"

# Auth (required)
NEXTAUTH_SECRET="generate-with-openssl-rand-base64-32"
NEXTAUTH_URL="https://your-domain.com"
NEXT_PUBLIC_APP_URL="https://your-domain.com"

# Email (required for notifications)
BREVO_API_KEY="xkeysib-..."
EMAIL_FROM="noreply@your-domain.com"
EMAIL_FROM_NAME="Event System"

# Storage (EC2 = local, Vercel = supabase)
STORAGE_PROVIDER="local"
NEXT_PUBLIC_SUPABASE_URL="https://xxx.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="eyJ..."
SUPABASE_STORAGE_BUCKET="photos"

# Logging
LOG_LEVEL="info"

# Error Tracking (optional)
NEXT_PUBLIC_SENTRY_DSN="https://xxx@xxx.ingest.sentry.io/xxx"
SENTRY_AUTH_TOKEN="sntrys_..."
SENTRY_ORG="your-org"
SENTRY_PROJECT="ea-sys"
```
