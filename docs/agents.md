# agents.md - AI Agent Context for EA-SYS

This file provides a condensed reference for AI agents (Claude, Codex, Copilot, etc.) working on the EA-SYS codebase. It is derived from `CLAUDE.md` and `docs/DEVELOPMENT_STATUS.md`.

---

## Project Summary

**EA-SYS** is a full-stack event management platform. Single-organization mode. Invite-only users. Public event registration at `/e/[slug]`.

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript (strict) |
| Database | PostgreSQL + Prisma ORM |
| Auth | NextAuth.js v5, JWT strategy, Edge-compatible middleware |
| Styling | TailwindCSS 4 + Shadcn/ui |
| State | TanStack Query (React Query) for client cache |
| Email | Brevo (Sendinblue) transactional API |
| Hosting | AWS EC2 via Docker (primary); Vercel also connected (photo uploads disabled on Vercel) |

---

## Key Directories

```
prisma/schema.prisma                   # Database schema (source of truth for models)
src/app/(auth)/                        # Login, accept-invitation pages
src/app/(dashboard)/                   # Protected dashboard (events, contacts, settings)
src/app/e/[slug]/                      # Redirects to /e/[slug]/register
src/app/e/[slug]/register/             # Public submitter registration form
src/app/e/[slug]/submitAbstract/       # Public abstract submission form
src/app/uploads/[...path]/route.ts     # Streams uploaded files from public/uploads/
src/app/api/                           # API routes (events, organization, public, upload)
src/app/api/upload/photo/route.ts      # Photo upload endpoint (auth required)
src/components/ui/                     # Shadcn/ui primitives
src/components/ui/photo-upload.tsx     # Photo upload with preview (max 500KB)
src/components/ui/country-select.tsx   # Searchable ISO 3166-1 country dropdown
src/components/ui/specialty-select.tsx # Specialty field dropdown
src/components/ui/tag-input.tsx        # Multi-tag chip input (Enter/comma to add)
src/components/forms/person-form-fields.tsx  # Shared fields for attendees/speakers/contacts
src/components/layout/                 # Header, Sidebar
src/hooks/use-api.ts                   # React Query hooks for all API calls
src/lib/auth.ts                        # NextAuth config (Node.js runtime)
src/lib/auth.config.ts                 # NextAuth config (Edge runtime, for middleware)
src/lib/auth-guards.ts                 # denyReviewer() — blocks REVIEWER + SUBMITTER on writes
src/lib/event-access.ts                # buildEventAccessWhere() — role-scoped event queries
src/lib/db.ts                          # Prisma client singleton
src/lib/email.ts                       # Brevo email service + templates
src/lib/countries.ts                   # ISO 3166-1 country list (249 countries)
src/lib/logger.ts                      # Pino logger (file + console)
src/lib/utils.ts                       # Formatting helpers
```

---

## Database Models

| Model | Purpose | Key Indexes |
|-------|---------|-------------|
| Organization | Tenant entity | `slug` (unique) |
| User | Team members | `email` (unique), `organizationId` |
| Event | Conference/meeting | `[organizationId, slug]` (unique), `status`, `startDate` |
| TicketType | Registration types | `eventId`, `isActive` |
| Registration | Event sign-ups | `eventId`, `[eventId, status]`, `[eventId, ticketTypeId]`, `attendeeId`, `qrCode` |
| Attendee | Attendee PII | `email` |
| Speaker | Event speakers | `[eventId, email]` (unique), `status` |
| Abstract | Paper submissions | `eventId`, `speakerId`, `status` |
| EventSession | Schedule items | `eventId`, `startTime`, `trackId` |
| Track | Session categories | `eventId` |
| Hotel / RoomType / Accommodation | Lodging | various |
| AuditLog | Action history | `[entityType, entityId]`, `createdAt` |
| Payment | Financial records | `registrationId`, `stripePaymentId` |

**Roles:** `SUPER_ADMIN`, `ADMIN`, `ORGANIZER` — org-bound (have `organizationId`). `REVIEWER`, `SUBMITTER` — org-independent (`organizationId: null`), abstracts-only access. REVIEWERs are assigned per-event via `event.settings.reviewerUserIds`. SUBMITTERs are linked via `Speaker.userId`.

---

## Conventions & Patterns

### API Routes

```typescript
// Standard pattern for all protected API routes
export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const [session, { eventId }] = await Promise.all([auth(), params]);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const event = await db.event.findFirst({
    where: { id: eventId, organizationId: session.user.organizationId },
    select: { id: true },  // Always use select, not include
  });
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // ...
}
```

Rules:
- `Promise.all()` for parallel queries (params + auth, then independent DB calls)
- Prisma `select` over `include` — fetch only what the response needs
- Validate with Zod, log errors with `apiLogger`
- All POST/PUT/DELETE handlers must call `denyReviewer(session)` from `@/lib/auth-guards` (blocks both REVIEWER and SUBMITTER)
- Photo fields use `z.string().optional()` — NOT `z.string().url()` (upload returns relative paths like `/uploads/photos/...`)
- Audit logs are fire-and-forget (`.catch()` — non-blocking)
- Cache headers: `Cache-Control: private, max-age=0, stale-while-revalidate=30`

### Server Pages

```typescript
// Always parallelize params + auth
const [{ eventId }, session] = await Promise.all([params, auth()]);

// Then parallelize independent DB queries
const [event, speakers] = await Promise.all([
  db.event.findFirst({ where: {...}, select: { id: true, name: true } }),
  db.speaker.findMany({ where: { eventId } }),
]);
```

### Client Pages

- Use React Query hooks from `src/hooks/use-api.ts` (never raw `useEffect` + `fetch`)
- Mutations invalidate relevant query keys on success
- Forms use `react-hook-form` + Zod
- Toasts via `sonner`

### Component Splitting

Large client pages should be split into focused sub-components:
- Types/constants in a co-located `types.ts`
- Dialogs as separate `*-dialog.tsx` files
- Sheets/panels as separate `*-sheet.tsx` files
- Main page imports and composes them

Example: `registrations/` directory:
```
page.tsx                       # Main page (~390 lines) - table, filters, stats
types.ts                       # Shared interfaces and color maps
add-registration-dialog.tsx    # Create registration form dialog
registration-detail-sheet.tsx  # Slide-out detail/edit panel
```

---

## React Query Configuration

- `staleTime: 5 min` — data considered fresh
- `gcTime: 30 min` — unused cache retention
- `refetchOnWindowFocus: true`
- `retry: 1`

Available hooks: `useEvents`, `useEvent`, `useTickets`, `useRegistrations`, `useSpeakers`, `useSessions`, `useTracks`, `useAbstracts`, `useHotels`, `useAccommodations`, `useContacts`, `useReviewers` — plus `useCreate*`, `useUpdate*`, `useDelete*` mutations for tickets, and `useAddReviewer`, `useRemoveReviewer`.

---

## Middleware

- Only runs on `/events/*`, `/dashboard/*`, `/settings/*`
- Redirects REVIEWER and SUBMITTER from `/events/new` to `/events`
- Redirects REVIEWER and SUBMITTER to `/events/[eventId]/abstracts` for any non-abstract event route
- Uses Edge-compatible auth config (no bcrypt, no Prisma)
- Public routes (`/e/*`), API routes (`/api/*`), auth pages, `/uploads/*`, and static assets are excluded

---

## Prisma Client

- Singleton via `globalThis` — cached in **development only** (prevents HMR connection pool leaks)
- In production (Vercel serverless), each function gets its own instance
- Logs only errors and warnings (no query logging)

---

## Email (Brevo)

- Lazy-initialized API client (no module-level overhead)
- Named imports for tree-shaking
- Templates: `speakerAgreement`, `speakerInvitation`, `registrationConfirmation`, `eventReminder`, `userInvitation`, `passwordReset`, `customNotification`

---

## Build Optimizations

| Optimization | Location |
|-------------|----------|
| `optimizePackageImports` | `next.config.ts` — tree-shakes lucide-react, Radix UI |
| `transpilePackages` | `next.config.ts` — better tree-shaking for `@getbrevo/brevo` |
| Turbopack | Default bundler in Next.js 16 |
| Standalone output | `next.config.ts` — `output: "standalone"` for Vercel |
| Lazy Brevo init | `src/lib/email.ts` — API client created on first use |

---

## Feature Completion Status

### Completed
- Event CRUD, settings, deletion; `eventType`/`tag`/`specialty` classification fields
- Registration types (tickets), registration management with detail sheet
- Speaker management with `photo`, `city`, `country`, `specialty` fields; abstract review workflow
- Abstract `specialty` field; submission URL widget on abstracts page for organizers
- SUBMITTER role — self-registers at `/e/[slug]/register`, submits/edits own abstracts
- Session/schedule management with calendar view
- Accommodation (hotels, room types, bookings)
- Contact Store (CRUD, CSV import/export, tag filtering, event history, import to speakers/registrations)
- Email system (Brevo): speaker, registration, invitation, reminder, custom, bulk, abstract status notifications
- User invitation system (token-based, 7-day expiry)
- Reviewer + Submitter access hardening (3-layer: API guards, middleware redirects, UI hiding)
- Reviewers module (per-event reviewer management, dual add mode)
- Photo upload system (`PhotoUpload` component, `/api/upload/photo`, served via `/uploads/[...path]/route.ts`)
- City/country fields on Attendee, Speaker, Contact; `CountrySelect` component
- TagInput chip component (replaces comma-string inputs for tags)
- SpecialtySelect dropdown component
- Public submitter registration at `/e/[slug]/register`; `/e/[slug]` redirects there
- React Query caching for all dashboard pages
- API performance (parallel queries, select, cache headers)
- EC2 Docker deployment with GitHub Actions CI/CD; nginx reverse proxy; SSL (Let's Encrypt)
- Logging (Pino, file-based, web log viewer)

### Not Started
- Payment integration (Stripe)
- Reporting & analytics dashboard
- QR code scanner (mobile web)
- Badge printing
- Multi-language support
- Redis caching
- E2E tests

---

## Common Commands

```bash
npm run dev              # Dev server
npm run build            # Production build (runs prisma generate first)
npm run lint             # ESLint
npx tsc --noEmit         # Type-check
npx prisma generate      # Generate Prisma client
npx prisma db push       # Push schema changes to DB
npx prisma studio        # Visual DB browser
tail -f logs/app.log     # Watch application logs
```

---

## Environment Variables

```env
DATABASE_URL             # Pooled PostgreSQL connection
DIRECT_URL               # Direct PostgreSQL (for migrations)
NEXTAUTH_SECRET          # JWT signing secret
NEXTAUTH_URL             # App base URL
NEXT_PUBLIC_APP_URL      # Public-facing URL
BREVO_API_KEY            # Email service
EMAIL_FROM               # Sender email
EMAIL_FROM_NAME          # Sender display name
LOG_LEVEL                # debug | info | warn | error
```

---

## Known Technical Debt

- `@trpc/client`, `@trpc/react-query`, `@trpc/server` in `package.json` are unused — safe to remove
- Several Radix packages missing from `optimizePackageImports` in `next.config.ts`
- `date-fns` not in `optimizePackageImports`
- React Query stale times are uniform (5 min) — could be granular per data type
- Schedule and abstracts pages are still large single-file client components
- Photo uploads not supported on Vercel (no writable filesystem in serverless functions); EC2 Docker deployment required for photo functionality
- Uploaded photos are not cleaned up when replaced (no deletion of old file on update)
