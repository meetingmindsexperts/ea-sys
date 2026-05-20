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
| **API** | Next.js Route Handlers (`route.ts`) | REST endpoints — auth, validation (Zod), HTTP response shaping. Business logic lives in `src/services/` for extracted domains, inline in the handler for everything else (migrating progressively; see "Services Layer" below) |
| **Services** | `src/services/*-service.ts` | Domain logic shared by REST routes, MCP agent tools, and cron workers. Pure functions returning errors-as-values; no HTTP awareness. Four services currently extracted: accommodation, abstract (`changeAbstractStatus`), speaker (`createSpeaker`), registration (`createRegistration`), billing-account (`createBillingAccount` / `updateBillingAccount`). See `src/services/README.md` for the convention. |
| **Auth** | NextAuth.js v5 (JWT strategy) | Session management, 7-role RBAC, 3-layer enforcement (API guards, middleware, UI) |
| **Data Access** | Prisma ORM | Direct queries in services + route handlers + server components — no repository abstraction |
| **Validation** | Zod | Request validation in route handlers; shared schemas (e.g., `titleEnum`) in `src/lib/schemas.ts` |
| **Database** | PostgreSQL | Single database, single schema, org-scoped queries; enums for Title, UserRole, EventType |
| **Email** | Brevo + SendGrid (auto-detected via env) + Tiptap v2 + juice | Dual providers; DB-backed templates with WYSIWYG editor, consistent branding, CSS inlining |
| **Payments** | Stripe (Checkout, Webhooks, Refunds) | Online payments with tax, invoices, refund processing |
| **AI** | Anthropic Claude API | Natural language event management via agentic tool-use loop |
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
  → auth() → denyReviewer() → Zod validate → service call (or inline logic)
  → JSON response → React Query cache invalidation → UI update
```

**MCP tool invocation (agent-driven write):**
```
MCP client (Claude.ai / Desktop / n8n) → /api/mcp
  → OAuth or x-api-key auth → tool executor
  → service call (shared with REST) → MCP tool response
```

Services in `src/services/` are the convergence point: REST route handlers
and MCP tool executors both call the same function, so side effects (email,
audit log, contact sync, admin notifications) can't silently drift between
the two entry points.

### RBAC Architecture

Three-layer enforcement for role-based access:

```
Layer 1: API Guards
  └─ denyReviewer(session) on all POST/PUT/DELETE (except abstracts, registrant self-edit)
  └─ Returns 403 for REVIEWER, SUBMITTER, and REGISTRANT roles

Layer 2: Middleware
  └─ Redirects restricted roles from non-abstract routes
  └─ REVIEWER/SUBMITTER → /events/[eventId]/abstracts
  └─ REGISTRANT → /my-registration (from all dashboard routes)

Layer 3: UI
  └─ Write-action buttons hidden for restricted roles and MEMBER
  └─ Sidebar hidden for REGISTRANT; shows only permitted items per role
  └─ Header shows "Reviewer Portal", "Submitter Portal", or "Registration Portal"
```

**Role scoping:**

| Role | Org-bound | Event Access | Write Access |
|---|---|---|---|
| SUPER_ADMIN / ADMIN | Yes | All org events | Full |
| ORGANIZER | Yes | All org events | Full |
| MEMBER | Yes | All org events | Read-only (no writes) |
| REVIEWER | No (`organizationId: null`) | Events in `settings.reviewerUserIds` | Abstracts only (review/score) |
| SUBMITTER | No (`organizationId: null`) | Events with linked Speaker record | Abstracts only (own) |
| REGISTRANT | No (`organizationId: null`) | Events with linked Registration | Self-service portal only (`/my-registration`) |

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

### 1. Tests — Resolved
**Status: Done**

**Unit (Vitest, 60+ files, 1237+ tests).** Auth guards (`denyReviewer`, `denyFinance`), event access scoping, RBAC enforcement across 7 roles, registration / abstract / speaker / accommodation service contracts (every error code pinned), CSV parsing, API key + OAuth validation, security / rate limiting, Zod schemas, EventsAir credential encryption, finance-visibility redaction (MEMBER boundary), payer-triplet atomicity in the registration edit mapper, `ApiError` status+code preservation, junction-table attach/detach RBAC + IDOR. Run: `npm run test` / `npm run test:coverage`.

**E2E (Playwright, 62-spec suite — added April 28, 2026).** Specs:
`manual-registration`, `concurrent-write` (optimistic-lock STALE_WRITE
on Registration + Speaker), `admin-smoke`, `bulk-email-payment-filter`,
`abstract-submitter`, `public-registration`, `rbac-redirects`, plus the
12-chapter `screenshots/*.spec.ts` set that drives `npm run docs:screenshots`
into [docs/screenshots/](screenshots/). The suite runs serial against a
seeded test DB (`prisma/seed-e2e-core.ts` shared between regression and
docs paths). Run: `PORT=3113 npm run test:e2e` (port override is required
because `npm run dev` binds 3113 while `playwright.config.ts` defaults
baseURL to 3000).

### 2. Services Layer — Opportunistic Refactor (Phase 2 complete)
**Status: Phase 0 + 1 + 2a + 2b + 2c shipped. Phase 3 pending external API spec.**

Historically business logic lived directly in route handlers — the idiomatic Next.js App Router pattern and correct for a solo-developer, single-caller codebase. The services layer became valuable specifically when MCP arrived as a second caller and real drift showed up (the April 2026 audit found paid MCP registrations silently skipping the confirmation email + quote PDF).

The refactor is **opportunistic**: extract when pain signals you, not on a schedule. Four services shipped; Phase 3 expands the pattern to the external public API when its spec is concrete.

- **Phase 0 — Bug fixes (shipped).** Patched confirmed drift in MCP `create_registration`, `create_registrations_bulk`, `create_speaker`, `create_speakers_bulk` to match the REST admin-create behavior. No architectural change — fixes ship before refactor.
- **Phase 1 — Foundation (shipped).** Extracted [src/services/accommodation-service.ts](../src/services/accommodation-service.ts). Locked in the conventions every subsequent service follows: errors-as-values result type, typed-Date inputs, caller-identity via `source`, service-owned side effects. Full convention reference in [src/services/README.md](../src/services/README.md).
- **Phase 2a — Abstract (shipped).** Extracted [src/services/abstract-service.ts](../src/services/abstract-service.ts) with `changeAbstractStatus()`. Centralizes the `requiredReviewCount` gate, WITHDRAWN terminal-state guard (REST tightening), reviewer notification fan-out with isolated failure handling.
- **Phase 2b — Speaker (shipped).** Extracted [src/services/speaker-service.ts](../src/services/speaker-service.ts) with `createSpeaker()`. Covers REST admin POST + MCP `create_speaker`. Bulk paths intentionally left out — different mechanics.
- **Phase 2c — Registration (shipped).** Extracted [src/services/registration-service.ts](../src/services/registration-service.ts) with `createRegistration()`. Covers REST admin POST + MCP `create_registration`. Centralizes the 9-error-code domain contract, the atomic soldCount guard with typed `RegistrationServiceSentinel`, and the Phase 0 confirmation-email gate (paid + outstanding), now structurally guaranteed. Public register + MCP bulk intentionally left inline — different concerns.
- **Phase 3 — External API-driven (pending).** A public REST API is on the near-term roadmap. When it lands, its endpoints back onto the existing services: any new domain operation the API exposes gets its own extraction at that point. No speculative work ahead of the concrete surface.
- **Phase 4 — Opportunistic (ongoing).** For single-caller routes, extract only when touching for a feature reason. No proactive refactor.

**Guardrail:** services never import from `next/server`, never read sessions — they receive already-typed, already-authenticated inputs. Callers own auth, Zod parsing, rate limiting, and response shaping.

### 3. Synchronous Email Sends
**Risk: Low-Medium | Effort to fix: Medium**

Email sends (`await sendEmail(...)`) happen synchronously in request handlers. If Brevo is slow or down, the user's request hangs. Currently not causing issues, but would benefit from a simple queue if email volume or reliability becomes a concern.

### 4. Rate Limiting — Partially Resolved
**Status: Done on public endpoints**

In-memory rate limiting (`src/lib/security.ts`) is applied to: `/api/public/events/[slug]/register` (10 req/min), `/api/public/events/[slug]/checkout` (3/60s per IP), `/api/public/events/[slug]/complete-registration` (20 GET / 5 POST per 15min), bulk email send (5/hr per org), and the AI agent (20 req/hr per user).

**Remaining gap:** In-memory rate limit state resets on serverless cold starts (Vercel). Needs Redis (Vercel KV / Upstash) for persistent cross-instance rate limiting.

### 5. No Input Sanitization Layer
**Risk: Low | Effort to fix: Low**

`isomorphic-dompurify` is used for HTML output sanitization on footer content, but there's no consistent input sanitization pattern. Prisma's parameterized queries prevent SQL injection, but XSS vectors in stored data are handled ad-hoc.

---

## Recommendations (Prioritized)

### Priority 1: Redis for Persistent Rate Limiting
In-memory rate limiting (`src/lib/security.ts`) resets on serverless cold starts. For Vercel production, add Upstash Redis for cross-instance rate limit state. The `checkRateLimit` interface is store-agnostic — only the backing store changes.

### Priority 2: Error Monitoring Coverage
Sentry is connected. Ensure all API route `catch` blocks send errors to Sentry, not just to Pino logs. The "every failure path must log" rule (per CLAUDE.md) handles the Pino side; Sentry needs the same coverage for production triage.

### Priority 3: Services Layer — Driven by External API
Phases 0 / 1 / 2a / 2b / 2c / billing-account shipped five services. Phase 3 expands the pattern when the external public REST API spec lands — each new endpoint backs onto an existing or new service. Until then, the opportunistic policy applies — extract only when touching a route for a feature reason.

### Priority 4: Resilience helper (`src/lib/resilience.ts`)
Stripe / Zoom / Anthropic SDK calls lean on default timeouts, no bounded retry, no circuit breaker. Per the May 2026 audit + design discussion: ship `withTimeout` + `withRetry` (jittered backoff, opt-in, idempotent-writes only) + `CircuitBreaker` as a shared helper, then wrap call sites in Phase 2. Full design in `docs/ROADMAP.md`.

---

## Architectural Patterns (formalized)

A small set of cross-cutting patterns recur across the codebase. They're
documented here so future contributors recognize them and stay
consistent.

### Client-side primitives

- **`ApiError` + method helpers** ([src/lib/api-fetch.ts](../src/lib/api-fetch.ts)).
  `apiFetch<T>(url, init)` throws a typed `ApiError` carrying
  `status`, `code`, and the raw error `data`. Mutations that need to
  branch on the server error (STALE_WRITE refetch, BILLING_ACCOUNT_INACTIVE,
  CAPACITY_EXCEEDED, …) use `error instanceof ApiError` in `onError`
  instead of string-matching messages or hand-attaching `code`/`status`
  to a plain `Error`. Convenience wrappers: `apiPostJson`, `apiPutJson`,
  `apiDelete`. `apiPostJson` omits Content-Type when body is undefined
  so empty-body action routes (`/check-in`, `/refund`) don't send a
  meaningless header.

  The older `fetchApi` in `src/hooks/use-api.ts` (throws plain
  `Error(message)`) stays in place for read queries that don't need
  the `code`/`status`.

- **Pure mapping helpers for edit forms**
  ([src/app/(dashboard)/events/[eventId]/registrations/registration-edit-mapping.ts](../src/app/%28dashboard%29/events/%5BeventId%5D/registrations/registration-edit-mapping.ts)).
  The pattern: `toEditData(reg)` populates form state from a DB row;
  `toServerPayload(editData, expectedUpdatedAt)` assembles the PUT
  body. Both are pure functions in a separate module, unit-tested in
  isolation. Replaces the "same field list inlined three times in the
  component" anti-pattern (initial defaults / startEditing populate /
  saveEdits assembly). Critically, the mapper is where the
  null-vs-undefined-vs-trim normalization decisions live — encoded
  once and pinned by unit tests so a future refactor can't silently
  change the wire format.

- **React 19 prop sync — "Storing information from previous renders".**
  When a component holds local state derived from a prop and needs to
  re-sync when the prop changes, compare the prop to a **previous-prop
  snapshot in state** — NOT to the derived state. Both
  `setPrevProp(prop)` and the derived-state updates fire in the same
  render pass (React 19's supported setState-during-render shape).
  Comparing against derived state is the banned anti-pattern that
  trips StrictMode warnings AND can silently revert local state when
  a mutation updates it. Example in
  [registration-detail-sheet.tsx](../src/app/%28dashboard%29/events/%5BeventId%5D/registrations/registration-detail-sheet.tsx)
  around the `prevRegistration` block.

- **`useEffect + setState` for prop-derived state is banned**
  (`react-hooks/set-state-in-effect`). Use the previous-render
  pattern above, or a `key=` prop to force a remount.

### Data model patterns

- **Many-to-many via junction table with shared identity.**
  When the same logical row needs to appear under multiple parents
  without being duplicated — e.g. one `BillingAccount` ("Cleveland
  Clinic") attached to many `Event`s — model it as an explicit
  associative table (`EventBillingAccount` with
  `@@unique([eventId, billingAccountId])`), not as a copy per parent.
  FKs Cascade from both ends (deleting either entity unlinks but
  doesn't delete the other). The picker UI filters by junction
  membership (`?eventId=…` query param).

- **Org-scoped reusable entity vs event-scoped per-event entity.**
  `BillingAccount`, `Contact`, `MediaFile` are org-scoped (one
  catalog org-wide, reused per event via junction or selector).
  `EventSession`, `TicketType`, `Abstract` are event-scoped (created
  fresh per event). Choosing the right side depends on whether the
  entity has identity that crosses event boundaries.

- **Soft-delete via `isActive` for entities that registrations
  reference.** Hard-deleting a `BillingAccount` with linked
  registrations would either fail (FK `Restrict`) or silently orphan
  the registrations. The convention: soft-delete via `isActive=false`
  + hide from pickers; FK is `Restrict` so hard-delete is impossible
  by construction. The settings UI exposes a "Deactivate"
  toggle, not a "Delete" button.

- **Optimistic-lock token (`expectedUpdatedAt` / W2-F8).** Edit
  forms read a row's `updatedAt` when opened, send it back as
  `expectedUpdatedAt` on save; the route does an `updateMany` with
  the timestamp in the where-clause, returns 409 `STALE_WRITE` if
  zero rows match. Prevents lost-update on concurrent admin edits.
  Pattern implemented for Registration + Speaker so far; future
  edit-heavy entities should adopt it. Server-side rejection flows
  through `ApiError(status=409, code="STALE_WRITE")` so the client
  can branch on `instanceof ApiError` to refetch + re-prompt.

- **Per-entity audit log writes are fire-and-forget.** Every service
  that mutates writes to `AuditLog` via `db.auditLog.create(...).catch(...)`
  outside the main transaction. Audit failure must never roll back
  the domain write. Convention: `changes.source: "rest" | "mcp" | "api"`
  identifies the caller; REST adds `ip`.

- **Atomic counter via dedicated table** (`InvoiceCounter`,
  `RegistrationSerialCounter`). For per-event monotonically-increasing
  ids, `aggregate(_max) + 1` is race-prone under Read Committed even
  inside a transaction. Use a counter row with `upsert` +
  `{ increment: 1 }` — Postgres compiles this to
  `INSERT ... ON CONFLICT DO UPDATE SET col = col + 1`, taking a row
  lock that serializes concurrent callers. Backfill from
  `MAX(existing)` on migration deploy so blue-green stays safe.

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
| Email | Brevo / SendGrid + Tiptap v2 + juice | Dual transactional email providers (auto-detected via env var); DB-backed WYSIWYG templates, branding, CSS inlining |
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

*Last updated: April 2026*
