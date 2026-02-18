# Event Management System - Development Status

**Last Updated:** February 18, 2026 (Schema & API cleanup, n8n / API key support)
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
| Check-in (QR Code) | ✅ | ❌ | API Complete |
| QR Code Generation | ✅ | ✅ | Complete |
| Delete Registration | ✅ | ❌ | API Complete |
| Search/Filter Registrations | ✅ | ✅ | Complete |
| Export to CSV | N/A | ✅ | Complete |
| Import from Contact Store | ✅ | ✅ | Complete |

**API Endpoints:**
- `GET /api/events/[eventId]/registrations` - List registrations (with filters)
- `POST /api/events/[eventId]/registrations` - Create registration
- `GET /api/events/[eventId]/registrations/[id]` - Get registration details
- `PUT /api/events/[eventId]/registrations/[id]` - Update registration
- `DELETE /api/events/[eventId]/registrations/[id]` - Delete registration
- `POST /api/events/[eventId]/registrations/[id]/check-in` - Check-in by ID
- `PUT /api/events/[eventId]/registrations/[id]/check-in` - Check-in by QR code

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
| List Abstracts | ✅ | ✅ | Complete |
| View Abstract | ✅ | ✅ | Complete |
| Edit Own Abstract (Submitter) | ✅ | ✅ | Complete |
| Review Abstract | ✅ | ✅ | Complete |
| Score Abstract | ✅ | ✅ | Complete |
| Accept/Reject Abstract | ✅ | ✅ | Complete |
| Status Notification Emails | ✅ | N/A | Complete |
| Link Abstract to Session | ✅ | ❌ | API Complete |

**API Endpoints:**
- `GET /api/events/[eventId]/abstracts` - List abstracts (filtered to own for SUBMITTER)
- `POST /api/events/[eventId]/abstracts` - Submit abstract
- `GET /api/events/[eventId]/abstracts/[id]` - Get abstract details
- `PUT /api/events/[eventId]/abstracts/[id]` - Update/Review abstract (SUBMITTER: content only)
- `DELETE /api/events/[eventId]/abstracts/[id]` - Delete abstract (admin only)
- `POST /api/public/events/[slug]/submitter` - Create submitter account (no auth)

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

## Recent Updates (January 29, 2026)

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
| Import contacts → Event Speakers | ✅ | ✅ | Complete |
| Import contacts → Event Registrations | ✅ | ✅ | Complete |
| "Import from Contacts" button on Speakers page | N/A | ✅ | Complete |
| "Import from Contacts" button on Registrations page | N/A | ✅ | Complete |

**API Endpoints:**
- `GET /api/contacts` — Paginated list with `search`, `tags`, `page`, `limit`
- `POST /api/contacts` — Create single contact (409 on duplicate email per org)
- `GET /api/contacts/[contactId]` — Single contact + event history (speaker/attendee appearances)
- `PUT /api/contacts/[contactId]` — Update contact
- `DELETE /api/contacts/[contactId]` — Delete contact
- `POST /api/contacts/import` — CSV bulk import via multipart/form-data; returns `{ created, skipped, errors[] }`
- `GET /api/contacts/export` — Downloads CSV attachment with all org contacts
- `POST /api/events/[eventId]/speakers/import-contacts` — `{ contactIds }` → creates speakers skipping duplicates
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
- `src/app/(dashboard)/events/[eventId]/speakers/page.tsx` — Import from Contacts button
- `src/app/(dashboard)/events/[eventId]/registrations/page.tsx` — Import from Contacts button

---

### EC2 Production Deployment (February 18, 2026)
- [x] Docker multi-stage build (builder + runner stages, `node:22-slim`)
- [x] `docker-compose.prod.yml` — production compose file with `ea-sys` service on port 3000
- [x] nginx reverse proxy with HTTP→HTTPS redirect, gzip, security headers, long-cache for `/_next/static/`
- [x] SSL via Let's Encrypt — automated renewal with `certbot-dns-godaddy` plugin (no manual renewal needed)
- [x] GitHub Actions workflow (`.github/workflows/deploy.yml`) — triggers on push to `main`, SSHes into EC2, `git fetch/reset --hard`, docker compose build + up, image prune
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

**API Endpoints:**
- `POST /api/events/[eventId]/speakers/[speakerId]/email` - Send email to speaker
- `POST /api/events/[eventId]/registrations/[registrationId]/email` - Send email to registration
- `POST /api/events/[eventId]/emails/bulk` - Send bulk emails

**Required Environment Variables:**
- `BREVO_API_KEY` - Get from https://app.brevo.com/settings/keys/api
- `EMAIL_FROM` - Verified sender email address
- `EMAIL_FROM_NAME` - Sender display name

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

### Phase 6: Email Notifications (IN PROGRESS)

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
| Check-in Confirmation | Low | Pending |
| Email Preferences Management | Low | Pending |

**Completed Tasks:**
1. ✅ Set up Brevo email service
2. ✅ Create professional HTML email templates
3. ✅ Speaker email APIs (invitation, agreement, custom)
4. ✅ Registration email APIs (confirmation, reminder, custom)
5. ✅ Bulk email API endpoint

**Remaining Tasks:**
1. Add email preferences management
2. Payment receipt email
3. Abstract status notification
4. Check-in confirmation email

### Phase 7: Public Registration Portal (NOT STARTED)

| Feature | Priority | Estimated Effort |
|---------|----------|------------------|
| Public Event Landing Page | High | Medium |
| Ticket Selection UI | High | Medium |
| Registration Form | High | Medium |
| Payment Checkout Flow | High | High |
| Registration Confirmation Page | High | Low |
| Email Verification | Medium | Medium |
| Attendee Profile Portal | Low | Medium |

**Required Tasks:**
1. Create public event routes `/e/[eventSlug]`
2. Build responsive registration form
3. Integrate payment flow
4. Implement reCAPTCHA or similar protection

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
| QR Code Scanner (Mobile Web) | High | Medium |
| Badge Printing Integration | Medium | High |
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
- [ ] Add Redis caching for frequently accessed data
- [ ] Optimize bundle size (add missing Radix packages + date-fns to `optimizePackageImports`)
- [ ] Remove unused tRPC dependencies (~200KB in node_modules)
- [ ] Add image optimization for uploads
- [ ] Implement pagination for large lists
- [x] Split registrations page (1,246 → 393 lines) into 4 focused sub-components
- [ ] Add granular React Query stale times per data type

### Security
- [ ] Add CSRF protection
- [x] Implement API key authentication for external access (`GET /api/events`, `/speakers`, `/registrations` support `x-api-key` header)
- [ ] Add input sanitization
- [ ] Security audit for OWASP top 10
- [ ] Add rate limiting per user/IP

### DevOps
- [x] Vercel deployment configured
- [x] Create deployment documentation
- [x] CI/CD pipeline via GitHub Actions (auto-deploy to EC2 on push to `main`)
- [x] EC2 production deployment (Docker + nginx + SSL)
- [ ] Configure staging environment
- [ ] Set up database backups
- [ ] Configure monitoring (error tracking)
- [ ] Add performance monitoring

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
| Registrations | 7 | ✅ Complete |
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
| **Total** | **71** | |

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

*Document maintained by the development team. Update as features are completed.*
