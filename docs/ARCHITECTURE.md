# EA-SYS Architecture

## Overview

EA-SYS is a **monolithic full-stack application** built on Next.js 16 (App Router). It follows the standard Next.js pattern: server components for reads, API routes for writes, Prisma as the ORM, and React Query for client-side caching.

This document covers the current architecture, its strengths, known gaps, and future considerations.

---

## Current Architecture

### Pattern: Monolithic Full-Stack (Next.js App Router)

```
┌─────────────────────────────────────────────────────┐
│                    Client (Browser)                  │
│  ┌───────────────┐  ┌────────────┐  ┌────────────┐  │
│  │ Server Comps   │  │ Client Comps│  │ React Query│  │
│  │ (SSR pages)    │  │ (forms, UI) │  │ (cache)    │  │
│  └───────┬───────┘  └─────┬──────┘  └─────┬──────┘  │
└──────────┼────────────────┼────────────────┼─────────┘
           │                │                │
    Direct DB query    fetch('/api/...')  fetch('/api/...')
           │                │                │
┌──────────┼────────────────┼────────────────┼─────────┐
│          │           Next.js Server                   │
│  ┌───────▼───────┐  ┌─────▼──────────────▼────────┐  │
│  │ Server Pages   │  │       API Routes             │  │
│  │ (page.tsx)     │  │  (route.ts handlers)         │  │
│  │                │  │  Auth → Validate → Query →   │  │
│  │  auth()        │  │  Respond                     │  │
│  │  db.query()    │  │                              │  │
│  └───────┬───────┘  └──────────────┬───────────────┘  │
│          │                         │                   │
│  ┌───────▼─────────────────────────▼───────────────┐  │
│  │              Prisma ORM                          │  │
│  └──────────────────────┬──────────────────────────┘  │
│                         │                              │
│  ┌──────────────────────▼──────────────────────────┐  │
│  │           PostgreSQL Database                    │  │
│  └─────────────────────────────────────────────────┘  │
│                                                        │
│  ┌─────────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ NextAuth.js  │  │  Brevo   │  │  Pino Logger     │  │
│  │ (JWT auth)   │  │ (email)  │  │ (stdout + files) │  │
│  └─────────────┘  └──────────┘  └──────────────────┘  │
└────────────────────────────────────────────────────────┘
```

### Layer Breakdown

| Layer | Technology | Role |
|---|---|---|
| **Presentation** | React Server/Client Components, TailwindCSS, Shadcn/ui | Renders UI; server components for static content, client components for interactivity |
| **Client State** | React Query (TanStack Query) | Caches API responses, handles mutations, provides optimistic updates |
| **API** | Next.js Route Handlers (`route.ts`) | REST endpoints — auth, validation (Zod), business logic, DB queries all in one handler |
| **Auth** | NextAuth.js v5 (JWT strategy) | Session management, 5-role RBAC, 3-layer enforcement (API guards, middleware, UI) |
| **Data Access** | Prisma ORM | Direct queries in route handlers and server components — no repository abstraction |
| **Validation** | Zod | Request validation in route handlers; shared schemas (e.g., `titleEnum`) in `src/lib/schemas.ts` |
| **Database** | PostgreSQL | Single database, single schema, org-scoped queries; enums for Title, UserRole, EventType |
| **Email** | Brevo (Sendinblue) API + Tiptap v2 + juice | DB-backed templates with WYSIWYG editor, consistent branding (header/footer), CSS inlining |
| **Logging** | Pino | Structured JSON logs to stdout + file (EC2/Docker) with redaction |
| **Deployment** | Docker on AWS EC2 (t3.large) | Single container, `output: "standalone"`, GitHub Actions CI/CD |

### Request Flow

**Server Component (read-only page load):**
```
Browser → Next.js Server → auth() → Prisma query → Render HTML → Browser
```

**Client Mutation (form submit):**
```
Browser → React Query mutation → fetch('/api/...') → Route Handler
  → auth() → denyReviewer() → Zod validate → Prisma write → JSON response
  → React Query cache invalidation → UI update
```

### RBAC Architecture

Three-layer enforcement for role-based access:

```
Layer 1: API Guards
  └─ denyReviewer(session) on all POST/PUT/DELETE (except abstracts)
  └─ Returns 403 for REVIEWER and SUBMITTER roles

Layer 2: Middleware
  └─ Redirects restricted roles from non-abstract routes
  └─ REVIEWER/SUBMITTER → /events/[eventId]/abstracts

Layer 3: UI
  └─ Write-action buttons hidden for restricted roles
  └─ Sidebar shows only permitted navigation items
  └─ Header shows "Reviewer Portal" or "Submitter Portal"
```

**Role scoping:**

| Role | Org-bound | Event Access | Write Access |
|---|---|---|---|
| SUPER_ADMIN / ADMIN | Yes | All org events | Full |
| ORGANIZER | Yes | All org events | Full |
| REVIEWER | No (`organizationId: null`) | Events in `settings.reviewerUserIds` | Abstracts only (review) |
| SUBMITTER | No (`organizationId: null`) | Events with linked Speaker record | Abstracts only (own) |

---

## Strengths

### Right-Sized for the Problem
EA-SYS is an internal event management tool for a single organization. The monolithic Next.js approach is appropriate — there's no need for microservices, message queues, or distributed systems at this scale.

### Colocation
Route handlers, page components, and API endpoints live close to each other in the file tree. This makes it easy to trace a feature from UI to database without jumping across projects.

### React Query as a Service Layer
The custom hooks in `use-api.ts` provide a clean abstraction between UI and API. Pages don't know about fetch URLs or cache keys — they just call `useSpeakers(eventId)` and get data.

### Solid Auth Model
The 3-layer RBAC (API + middleware + UI) with org-independent reviewers/submitters is well-designed. The `denyReviewer()` guard pattern is consistent across 29+ handlers.

### Performance-Conscious
- `Promise.all()` for parallel DB queries
- Prisma `select` instead of full object fetches
- React Query with 5-minute stale time for instant navigation
- Composite database indexes on hot query patterns

---

## Known Gaps

### 1. No Tests
**Risk: High | Effort to fix: Medium**

There are zero automated tests. This is the single biggest gap. The current architecture is perfectly testable — route handlers are plain async functions, Prisma can be mocked, and React Query hooks can be tested with `renderHook`.

**Recommended approach:**
- Start with API route integration tests (most value per test)
- Add unit tests for auth guards and access control logic
- Use Prisma's mock client for isolated testing

### 2. No Service Layer Extraction
**Risk: Low | Effort to fix: Low (when needed)**

Business logic lives directly in route handlers. This is fine for simple CRUD but some handlers (e.g., submitter registration) have grown to ~150+ lines with branching logic. As complexity grows, extract business logic into plain functions in `src/lib/services/`.

This is not urgent — only do it when a specific handler becomes hard to follow.

### 3. Synchronous Email Sends
**Risk: Low-Medium | Effort to fix: Medium**

Email sends (`await sendEmail(...)`) happen synchronously in request handlers. If Brevo is slow or down, the user's request hangs. Currently not causing issues, but would benefit from a simple queue if email volume or reliability becomes a concern.

### 4. No Rate Limiting
**Risk: Medium | Effort to fix: Low**

Public endpoints (`/api/public/events/[slug]/register`, `/api/auth/forgot-password`) have no rate limiting. These are abuse vectors for registration spam and password reset flooding.

### 5. No Input Sanitization Layer
**Risk: Low | Effort to fix: Low**

`isomorphic-dompurify` is used for HTML output sanitization on footer content, but there's no consistent input sanitization pattern. Prisma's parameterized queries prevent SQL injection, but XSS vectors in stored data are handled ad-hoc.

---

## Recommendations (Prioritized)

### Priority 1: Add Tests
The highest ROI investment. Without tests, every refactor and feature addition carries risk.

**Start here:**
```
src/
├── __tests__/
│   ├── api/           # Route handler tests
│   │   ├── auth.test.ts
│   │   ├── speakers.test.ts
│   │   └── abstracts.test.ts
│   ├── lib/           # Unit tests
│   │   ├── auth-guards.test.ts
│   │   └── event-access.test.ts
│   └── hooks/         # React Query hook tests
│       └── use-api.test.ts
```

### Priority 2: Rate Limiting on Public Endpoints
Add basic rate limiting to prevent abuse on:
- `/api/public/events/[slug]/register`
- `/api/public/events/[slug]/submitter`
- `/api/auth/forgot-password`
- `/api/auth/reset-password`

### Priority 3: Error Monitoring Coverage
Sentry is connected. Ensure all API route `catch` blocks send errors to Sentry, not just to Pino logs.

### Priority 4: Extract Heavy Route Handlers
When any route handler exceeds ~100 lines of business logic, extract the core logic into `src/lib/services/`. Keep the route handler as a thin wrapper: auth, validate, delegate, respond.

---

## Future: Multi-Organization Support

Multi-org is the most significant architectural change on the horizon. It should only be undertaken when there is a concrete second organization ready to use the platform.

### What Changes

**Schema:**
```prisma
model UserOrganization {
  id             String       @id @default(cuid())
  userId         String
  organizationId String
  role           Role
  user           User         @relation(fields: [userId], references: [id])
  organization   Organization @relation(fields: [organizationId], references: [id])

  @@unique([userId, organizationId])
}
```

`User.role` and `User.organizationId` move to the join table. A user can have different roles in different organizations.

**URL Structure:**
```
Current:  /events/[eventId]/speakers
Multi-org: /org/[orgSlug]/events/[eventId]/speakers
```

URL-based org context is recommended over session-based switching. It eliminates bugs where a user performs actions "in the wrong org" and makes URLs bookmarkable and shareable.

**Session/Auth:**
```typescript
// Current
session.user.organizationId  // string | null
session.user.role             // single Role

// Multi-org
session.user.currentOrganizationId  // derived from URL slug
session.user.currentRole            // derived from UserOrganization lookup
```

**Impact Scope:**

| Area | Files Affected | Effort |
|---|---|---|
| Prisma schema | 1 file (new model, User changes) | Low |
| Auth/Session | 2-3 files (auth.ts, middleware, callbacks) | Medium |
| API routes | 30+ files (every `organizationId` reference) | High |
| Event access helpers | 2 files (event-access.ts, auth-guards.ts) | Medium |
| UI (org switcher) | 3-4 files (header, sidebar, layout) | Medium |
| URL structure | All page.tsx files under `(dashboard)` | High |
| Data isolation audit | All routes | High |

**Estimated effort:** 2-3 weeks

**Prerequisites before starting:**
1. Comprehensive test coverage on auth guards and critical API routes
2. A concrete second organization with defined requirements
3. Answers to design questions:
   - Can users belong to unlimited organizations?
   - Should contacts be shared across orgs or isolated?
   - Can an admin of Org A see that Org B exists?
   - How are cross-org reviewers handled (they're already org-independent)?

### What Doesn't Change
- React Query hooks and client-side caching
- Component library (Shadcn/ui) and styling
- Email service integration
- Logging infrastructure
- Docker/EC2 deployment pipeline
- Public event registration flow (already org-scoped via event slug)

---

## Technology Decisions Log

| Decision | Choice | Rationale |
|---|---|---|
| Framework | Next.js 16 (App Router) | Full-stack in one project, SSR + API routes, React ecosystem |
| ORM | Prisma | Type-safe queries, schema-as-code, migration support |
| Auth | NextAuth.js v5 (JWT) | Standard Next.js auth, JWT avoids DB session lookups |
| Styling | TailwindCSS + Shadcn/ui | Utility-first CSS, copy-paste components (no vendor lock-in) |
| Client State | React Query | Server state caching with zero boilerplate vs. Redux |
| Email | Brevo API + Tiptap v2 + juice | Transactional email with DB-backed WYSIWYG templates, consistent branding, CSS inlining for email-client compat |
| Logging | Pino | Fastest Node.js logger, structured JSON, multi-stream support |
| Database | PostgreSQL | Reliable, Prisma-native, handles relational data well |
| Deployment | Docker on EC2 | Writable filesystem (needed for photo uploads), full control |

---

## General Guidance: Package Dependencies

> **Important for maintainers:** Before upgrading major versions of any dependency, review changelog and test thoroughly. Key constraints:
>
> - **Tiptap** — Pinned to v2. Tiptap v3 ships source-only packages (no compiled `dist/`), breaking standard npm installs. Do not upgrade until v3 ships pre-compiled artifacts.
> - **Next.js** — Major version upgrades (e.g. 16→17) can change App Router behavior, middleware APIs, and build output. Test the full build + deploy pipeline after upgrading.
> - **Prisma** — Major version changes may affect schema syntax, migration behavior, or client API. Always test against the shared Supabase database (both AWS and Vercel targets).
> - **juice** — CSS inlining library, very stable. Minor/patch updates are safe.
> - **@getbrevo/brevo** — Follows Brevo API versioning. Safe to update within the same API version.
> - **TanStack Query (React Query)** — Stable within major version (v5). Avoid major version jumps without migration guide review.
> - **Shadcn/ui** — Not a package (copy-paste components), so no version conflicts. Update individual components via `npx shadcn@latest add [component]`.
>
> General rule: stay on current major versions, apply minor/patch updates regularly. Major version bumps should be planned with a test cycle.

---

*Last updated: March 2026*
