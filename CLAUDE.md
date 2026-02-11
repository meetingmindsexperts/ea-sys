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
- **Deployment:** Vercel

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
│   │   └── [slug]/          # Event registration page
│   │       └── confirmation/
│   └── api/                 # API routes
│       ├── auth/            # Auth endpoints
│       ├── events/          # Event CRUD (protected)
│       │   └── [eventId]/   # Event-specific endpoints
│       ├── organization/    # Organization endpoints
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
- `src/lib/auth-guards.ts` - `denyReviewer()` guard for API route protection
- `src/lib/event-access.ts` - `buildEventAccessWhere()` for role-scoped event queries
- `src/lib/email.ts` - Email templates and sending
- `src/hooks/use-api.ts` - React Query hooks for data fetching
- `src/components/providers.tsx` - App providers (QueryClient, SessionProvider)
- `src/components/layout/sidebar.tsx` - Sidebar with role-based navigation
- `src/middleware.ts` - Route-level REVIEWER redirects
- `src/app/globals.css` - Global styles and CSS variables

## Database Models

- **Organization** - Organization entity (currently single-org mode)
- **User** - Users with roles (SUPER_ADMIN, ADMIN, ORGANIZER, REVIEWER)
- **Event** - Events with status tracking
- **TicketType** - Registration type configurations (displayed as "Registration Types" in UI)
- **Registration** - Event registrations
- **Attendee** - Attendee information
- **Speaker** - Event speakers
- **EventSession** - Schedule sessions
- **Track** - Session tracks
- **Abstract** - Paper submissions
- **Hotel/RoomType/Accommodation** - Lodging management
- **AuditLog** - Action logging

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

  // Block reviewers from write operations (POST/PUT/DELETE on non-abstract routes)
  const denied = denyReviewer(session);
  if (denied) return denied;

  // Verify event access
  const event = await db.event.findFirst({
    where: { id: eventId, organizationId: session.user.organizationId }
  });

  // ... handle request
}
```

**Important:** All POST/PUT/DELETE handlers (except abstract reviews) must call `denyReviewer(session)` from `@/lib/auth-guards`. This is enforced across 29 handlers in 20 route files.

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
- **REVIEWER** - Abstracts-only access to assigned events (org-independent)

### Architecture: Org-bound vs. Org-independent Users
- **Team members** (ADMIN, ORGANIZER) have a required `organizationId` and are scoped to their organization
- **Reviewers** have `organizationId: null` — they are independent entities scoped only by event assignment
- This allows one reviewer to be invited to review events across multiple organizations
- `User.organizationId` is nullable in the schema; non-null assertion (`!`) is used in admin-only code paths

### Reviewer Restrictions (3-layer enforcement)
1. **API Layer:** `denyReviewer(session)` guard on all POST/PUT/DELETE handlers (except abstract reviews) returns 403
2. **Middleware Layer:** `src/middleware.ts` redirects reviewers from non-abstract event routes to `/events/[eventId]/abstracts`, and `/events/new` to `/events`
3. **UI Layer:** Write-action buttons (Add, Edit, Delete) hidden via `isReviewer` checks in both server components (`session.user.role === "REVIEWER"`) and client components (`useSession()`)

### Event Scoping
- `buildEventAccessWhere(session.user)` from `src/lib/event-access.ts` scopes event queries by role
- Admins/Organizers see all org events; Reviewers see only events where their userId is in `event.settings.reviewerUserIds` (no org filter)

### Reviewer Assignment
- Reviewers are assigned per-event via `Event.settings.reviewerUserIds` (JSON array of User IDs)
- `Speaker.userId` (nullable FK) links speakers to User accounts
- The Reviewers page lets admins add reviewers via two methods: pick from speakers, or invite by email
- New reviewer accounts are created with `organizationId: null` and sent an invitation email

## Code Conventions

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
- `optimizePackageImports` - Tree-shakes large packages like `lucide-react` (44MB) and Radix UI
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
- Public routes (`/e/*`), API routes, auth pages, and static assets skip middleware entirely

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
- `useRegistrations`, `useSpeakers`, `useSessions`, `useTracks`
- `useAbstracts`, `useHotels`, `useAccommodations`
- `useReviewers`, `useAddReviewer`, `useRemoveReviewer`
- `useEvents`, `useEvent`

## Recent Features

- **Org-independent reviewers** - Reviewers decoupled from organizations (`User.organizationId = null`); one reviewer can review across multiple orgs; scoped only by `event.settings.reviewerUserIds`
- **Reviewers module** - Per-event reviewer management page with dual add mode (from speakers or by email); auto-invitation; API routes for add/remove; React Query hooks
- **Reviewer access hardening** - 3-layer RBAC enforcement (API guards on 29 handlers, middleware redirects, UI write-action hiding) restricting reviewers to abstracts-only
- **Event scoping for reviewers** - `buildEventAccessWhere` removes org filter for reviewers; reviewers see only assigned events across all orgs
- **Server page query optimization** - Parallelized `params`/`auth()`/DB queries on speakers and event detail pages; switched to Prisma `select` for minimal data transfer
- **Composite database indexes** - Added `[eventId, status]` and `[eventId, ticketTypeId]` on Registration for faster filtered queries
- **Middleware scope narrowing** - Matcher targets only dashboard routes; reviewers redirected from non-abstract event routes
- **Registration detail edit** - Slide-out panel with full CRUD for registration details
- **React Query caching** for instant page navigation (registration types, registrations, schedule, abstracts, reviewers)
- Public event registration at `/e/[slug]` (no auth required)
- User invitation system with email tokens
- Cerulean Blue theme with gradients
- Bulk email sending via Brevo
- Session calendar view
- File-based logging (`logs/app.log`, `logs/error.log`)

## Current Mode

**Single Organization Mode** (multi-org support planned for later):
- User account registration is disabled (`/register` redirects to `/login`)
- Team members (Admin/Organizer) must be invited by an admin via Settings → Users
- Reviewers are org-independent (`User.organizationId = null`) — invited per-event via the Reviewers page
- Public event registration is open to all at `/e/[event-slug]`

## Logging

Logs are written to files in the `logs/` directory:
- `logs/app.log` - All logs (debug, info, warn, error)
- `logs/error.log` - Errors only

View logs: `tail -f logs/app.log`

## Documentation

- `docs/DEVELOPMENT_STATUS.md` - Feature status and roadmap
- `.env.example` - Environment variable template
