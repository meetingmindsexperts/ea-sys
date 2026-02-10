# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Changed
- Hardened reviewer event permissions to enforce an abstracts-only event experience.
- Kept reviewer event visibility scoped to explicitly assigned events.
- Updated reviewer sidebar event navigation to display only the **Abstracts** item.
- Added middleware redirects so reviewers visiting any non-abstract event route are sent to `/events/[eventId]/abstracts`.
- Blocked direct URL access for reviewers to non-abstract event subpages (overview, registrations, tickets, schedule, accommodation, speakers, and settings).

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
