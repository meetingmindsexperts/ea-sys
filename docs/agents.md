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
| Hosting | Vercel (standalone output) |

---

## Key Directories

```
prisma/schema.prisma        # Database schema (source of truth for models)
src/app/(auth)/              # Login, accept-invitation pages
src/app/(dashboard)/         # Protected dashboard (events, settings)
src/app/e/                   # Public event pages (no auth)
src/app/api/                 # API routes (events, organization, public)
src/components/ui/           # Shadcn/ui primitives
src/components/layout/       # Header, Sidebar
src/hooks/use-api.ts         # React Query hooks for all API calls
src/lib/auth.ts              # NextAuth config (Node.js runtime)
src/lib/auth.config.ts       # NextAuth config (Edge runtime, for middleware)
src/lib/db.ts                # Prisma client singleton
src/lib/email.ts             # Brevo email service + templates
src/lib/logger.ts            # Pino logger (file + console)
src/lib/utils.ts             # Formatting helpers
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

**Roles:** `SUPER_ADMIN`, `ADMIN`, `ORGANIZER`, `REVIEWER` (reviewer sees only abstracts, cannot create events).

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

Available hooks: `useEvents`, `useEvent`, `useTickets`, `useRegistrations`, `useSpeakers`, `useSessions`, `useTracks`, `useAbstracts`, `useHotels`, `useAccommodations` — plus `useCreate*`, `useUpdate*`, `useDelete*` mutations for tickets.

---

## Middleware

- Only runs on `/events/*`, `/dashboard/*`, `/settings/*`
- Redirects REVIEWER role users from `/events/new` to `/events`
- Redirects REVIEWER role users to `/events/[eventId]/abstracts` for any non-abstract event route
- Uses Edge-compatible auth config (no bcrypt, no Prisma)
- Public routes (`/e/*`), API routes, auth pages, and static assets are excluded

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
- Event CRUD, settings, deletion
- Registration types (tickets), registration management with detail sheet
- Speaker management, abstract review workflow
- Session/schedule management with calendar view
- Accommodation (hotels, room types, bookings)
- Email system (Brevo): speaker, registration, invitation, reminder, custom, bulk
- User invitation system (token-based, 7-day expiry)
- Reviewer access hardening (abstracts-only)
- Public event registration portal (`/e/[slug]`)
- React Query caching for all dashboard pages
- API performance (parallel queries, select, cache headers)
- Logging (Pino, file-based)

### Not Started
- Payment integration (Stripe)
- Reporting & analytics dashboard
- QR code scanner (mobile web)
- Badge printing
- Multi-language support
- CI/CD pipeline
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
