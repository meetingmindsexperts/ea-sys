# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

_Nothing pending._

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