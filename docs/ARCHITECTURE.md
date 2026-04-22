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
| **Services** | `src/services/*-service.ts` | Domain logic shared by REST routes, MCP agent tools, and cron workers. Pure functions returning errors-as-values; no HTTP awareness. Currently populated for accommodation; registration/speaker/abstract scheduled for Phase 2 |
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

17 Vitest test files covering: auth guards (`denyReviewer`), event access (`buildEventAccessWhere`), RBAC enforcement, registration flow, abstract lifecycle, speaker flow, reviewer access, submitter registration, CSV parsing, API key validation, security/rate limiting, Zod schema validation, sanitization, and EventsAir credential encryption.

Run: `npm run test` / `npm run test:coverage`

**Remaining gap:** No E2E tests (Playwright/Cypress). Unit tests mock Prisma — no integration tests against a real database.

### 2. Services Layer — Opportunistic Refactor (Phase 2 mostly shipped)
**Status: Phase 0 + 1 + 2a + 2b shipped. Phase 2c absorbed into Phase 3 (external-API-driven).**

Historically business logic lived directly in route handlers — the idiomatic Next.js App Router pattern and correct for a solo-developer, single-caller codebase. The services layer became valuable specifically when MCP arrived as a second caller and real drift showed up (the April 2026 audit found paid MCP registrations silently skipping the confirmation email + quote PDF).

The refactor is **opportunistic**: extract when pain signals you, not on a schedule. Three services shipped, one deferred on purpose:

- **Phase 0 — Bug fixes (shipped).** Patched confirmed drift in MCP `create_registration`, `create_registrations_bulk`, `create_speaker`, `create_speakers_bulk` to match the REST admin-create behavior. No architectural change — fixes ship before refactor.
- **Phase 1 — Foundation (shipped).** Extracted [src/services/accommodation-service.ts](../src/services/accommodation-service.ts). Locked in the conventions every subsequent service follows: errors-as-values result type, typed-Date inputs, caller-identity via `source`, service-owned side effects. Full convention reference in [src/services/README.md](../src/services/README.md).
- **Phase 2a — Abstract (shipped).** Extracted [src/services/abstract-service.ts](../src/services/abstract-service.ts) with `changeAbstractStatus()`. Centralizes the `requiredReviewCount` gate, WITHDRAWN terminal-state guard (REST tightening), reviewer notification fan-out with isolated failure handling.
- **Phase 2b — Speaker (shipped).** Extracted [src/services/speaker-service.ts](../src/services/speaker-service.ts) with `createSpeaker()`. Covers REST admin POST + MCP `create_speaker`. Bulk paths intentionally left out — different mechanics.
- **Phase 2c — Registration (deferred).** The biggest and Stripe-adjacent extraction. Phase 0's in-place patches already eliminated the confirmed drift bugs, so the remaining value is future-facing. Absorbed into **Phase 3** — the extraction will happen when the external public API spec is concrete and actually needs it.
- **Phase 3 — External API-driven.** A public REST API is on the near-term roadmap. When it lands, whatever endpoints it exposes must back onto services. `registration-service.ts` is the most likely candidate. No speculative extraction ahead of the concrete surface.
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

### Priority 1: E2E Tests (Playwright)
Unit tests exist but only mock Prisma. Adding Playwright E2E tests for the three critical user flows would give the most confidence:
- Public registration → payment → confirmation
- Abstract submission → review → status notification
- Admin: CSV import → send completion emails → registrant completes form

### Priority 2: Redis for Persistent Rate Limiting
In-memory rate limiting resets on serverless cold starts. For Vercel production, add Upstash Redis for cross-instance rate limit state.

### Priority 3: Error Monitoring Coverage
Sentry is connected. Ensure all API route `catch` blocks send errors to Sentry, not just to Pino logs.

### Priority 4: Services Layer — Driven by External API
Phases 0 / 1 / 2a / 2b shipped three services (accommodation, abstract, speaker). The remaining candidate is `registration-service`, deferred intentionally: Phase 0 already patched its confirmed drift bugs in-place, and the next forcing function is the external public API. When that API spec is concrete, extraction happens alongside the new endpoints. Until then, the opportunistic policy applies — extract only when touching the route for a feature reason.

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
