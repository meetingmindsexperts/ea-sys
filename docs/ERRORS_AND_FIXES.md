# EA-SYS — Errors, Issues & Fixes Log

A comprehensive record of every significant error, bug, and issue encountered in the project, organized by category. Each entry includes the root cause, the fix applied, and the files affected.

**Last updated:** 2026-06-10

---

## Table of Contents

1. [Security Vulnerabilities](#1-security-vulnerabilities)
2. [Build & Compilation Errors](#2-build--compilation-errors)
3. [Deployment & CI/CD Errors](#3-deployment--cicd-errors)
4. [Vercel Compatibility Issues](#4-vercel-compatibility-issues)
5. [Database & Schema Issues](#5-database--schema-issues)
6. [Runtime & Infrastructure Errors](#6-runtime--infrastructure-errors)
7. [Email System Issues](#7-email-system-issues)
8. [API & Data Issues](#8-api--data-issues)
9. [UI/UX Bugs](#9-uiux-bugs)
10. [Package & Dependency Issues](#10-package--dependency-issues)
11. [EventsAir Import Bugs](#11-eventsair-import-bugs)

---

## 1. Security Vulnerabilities

Full details in `docs/SECURITY_AUDIT_FIXES.md` and `docs/PRODUCTION_AUDIT.md`.

### CRITICAL

| # | Issue | Root Cause | Fix | Files |
|---|-------|-----------|-----|-------|
| S1 | **Command injection in Logs API** | Query params interpolated directly into `docker logs` shell command via `child_process.exec` | Replaced with `execFile` + argument array; strict allowlist validation for all params | `api/logs/route.ts` |
| S2 | **Stored XSS via `dangerouslySetInnerHTML`** | `event.footerHtml` rendered unsanitized on public pages | Added DOMPurify (`isomorphic-dompurify`) sanitization before rendering | `e/[slug]/register/page.tsx`, `confirmation/page.tsx`, `settings/page.tsx` |
| S3 | **Docker socket mounted in production** | Both blue/green containers had `/var/run/docker.sock` mounted — full daemon access on compromise | Removed socket mount; logs API uses Docker Engine HTTP API instead | `docker-compose.prod.yml` |

### HIGH

| # | Issue | Root Cause | Fix | Files |
|---|-------|-----------|-----|-------|
| S4 | **SUBMITTER role not blocked on event CRUD** | Routes manually checked `role === "REVIEWER"` instead of `denyReviewer()` | Replaced with `denyReviewer(session)` which blocks both roles | `api/events/route.ts`, `api/events/[eventId]/route.ts` |
| S5 | **No error boundaries** | Zero `error.tsx` or `loading.tsx` — unhandled errors showed blank screens | Added root + per-section error boundaries | `app/error.tsx`, `app/loading.tsx`, section-level files |
| S6 | **Race condition: ticket overselling** | Sold-out check and `soldCount` increment were separate non-atomic operations | Wrapped in `$transaction` with conditional `updateMany` | Public registration + admin registration routes |
| S7 | **No magic byte validation on file upload** | Only client-provided MIME type validated — could upload HTML as image | Added file header magic byte validation; extension derived from validated type | `api/upload/photo/route.ts` |
| S8 | **Missing security headers on served files** | No `nosniff`, CSP, or `X-Frame-Options` on uploaded files | Added all three headers to file serving route | `uploads/[...path]/route.ts` |
| S9 | **Email template HTML injection** | String interpolation without HTML-escaping in email templates | Added `escapeHtml()` function applied to all user values | `lib/email.ts` |
| S10 | **Registration creation not transactional** | Registration + soldCount increment were separate operations | Wrapped in `db.$transaction()` | `api/public/events/[slug]/register/route.ts` |

### MEDIUM

| # | Issue | Root Cause | Fix | Files |
|---|-------|-----------|-----|-------|
| S11 | **Rate limiter memory leak** | In-memory store never cleaned expired entries | Added periodic cleanup (60s) + max store size cap (10K) | `lib/security.ts` |
| S12 | **JWT has no expiration** | No `maxAge` on session config (defaulted to 30 days) | Set `maxAge: 24h` forcing daily re-auth | `lib/auth.ts` |
| S13 | **Error responses leak internals** | Routes returned `error.message` with file paths / DB details | Standardized generic messages; internal details via `apiLogger` only | Multiple route files |
| S14 | **CSRF bypass when Origin absent** | Middleware skipped CSRF check if `Origin` header missing | Block mutation requests without Origin for non-API-key sessions | `middleware.ts` |
| S15 | **No input length limits** | Zod schemas validated types but had no `.max()` constraints | Added `.max()` to all string fields across 29 schemas | 29 schema files |
| S16 | **No IP addresses in audit logs** | Audit logs recorded action but not client IP | Added `getClientIp(req)` to all 43 audit log calls | 31 route files |
| S17 | **No request body size limit** | No Content-Length check — multi-GB payloads possible | Added 1MB limit in middleware for API mutations | `middleware.ts` |
| S18 | **Session fixation on role change** | JWT retained old role until token expired (24h) | Added periodic role re-validation (every 5min) in JWT callback | `lib/auth.ts` |

---

## 2. Build & Compilation Errors

### B1 — Tiptap v3 has no compiled `dist/` files

**Error:** `Cannot find module '@tiptap/react'` (and all tiptap modules)

**Root cause:** Tiptap v3 (3.20.3) ships source-only packages without compiled JavaScript. TypeScript `noEmit` and Next.js build both fail because there's nothing to import.

**Fix:** Downgraded to Tiptap v2:
```bash
npm install @tiptap/react@^2 @tiptap/starter-kit@^2 @tiptap/core@^2 ... --legacy-peer-deps
```

**Prevention:** Tiptap is pinned to v2 in `package.json`. Do NOT upgrade until v3 ships pre-compiled artifacts.

---

### B2 — `Module not found: Can't resolve 'fs'` in client component

**Error:** Build failed because a client component imported from `@/lib/email` which pulls in `logger.ts` → `fs`.

**Root cause:** `email-templates/[templateId]/page.tsx` imported `stripDocumentWrapper` from `@/lib/email`. That module transitively imports server-only dependencies (`fs`, `pino`, Brevo SDK).

**Fix:** Created `src/lib/email-utils.ts` with client-safe utilities only. Changed the import to use the new file.

**Files:** `src/lib/email-utils.ts` (new), `email-templates/[templateId]/page.tsx`

---

### B3 — ESLint: React hooks called conditionally

**Error:** `React Hook "useCallback" is called conditionally` in `tiptap-editor.tsx`

**Root cause:** `useCallback` hooks were placed after an early `return null` check for `!editor`.

**Fix:** Moved early return after all hooks; added null guards inside callback bodies.

**File:** `src/components/ui/tiptap-editor.tsx`

---

### B4 — `npm ci` failure: package-lock.json out of sync

**Error:** `npm ci` failed with multiple "missing from lockfile" errors after installing Tiptap v2 with `--legacy-peer-deps`.

**Root cause:** `--legacy-peer-deps` modified `node_modules` but left stale v3 entries in `package-lock.json`.

**Fix:** `npm install --package-lock-only` to regenerate a clean lock file, then committed the updated lock.

---

### B5 — TypeScript: `No value exists in scope for shorthand property 'subject'`

**Error:** TypeScript error in registrations and speakers email routes after refactoring to `renderAndWrap()`.

**Root cause:** Audit log code used `subject` shorthand property, but the standalone `subject` variable no longer existed after switching to `rendered = renderAndWrap(...)`.

**Fix:** Changed `subject` to `subject: rendered.subject` in audit log create calls.

**Files:** `registrations/[registrationId]/email/route.ts`, `speakers/[speakerId]/email/route.ts`

---

### B6 — Migration file: `ADD CONSTRAINT ... UNIQUE` fails with `42P07`

**Error:** `CREATE UNIQUE INDEX` worked on EC2 via `db push`, but Vercel's `prisma migrate deploy` failed with duplicate constraint error.

**Root cause:** `prisma db push` creates **indexes**, not constraints. Using `ADD CONSTRAINT ... UNIQUE` in a manual migration created a conflict with the implicit index.

**Fix:** Changed all migrations to use `CREATE UNIQUE INDEX IF NOT EXISTS` instead of `ADD CONSTRAINT ... UNIQUE`.

**Files:** `prisma/migrations/` files

---

### B7 — Node `crypto` import silently breaks Client Component (survey builder, June 8, 2026)

**Error:** Survey builder buttons ("Add rating", "Add single select", "Add free text") looked dead — clicking produced no UI change, no toast, no console log, no network request, no server log. Build/lint/tests all passed; tests covered the schema but not the click path.

**Root cause:** `src/lib/survey/schema.ts` had `import { randomUUID } from "crypto"` — Node.js's built-in crypto module. This file was imported by the `"use client"` survey builder page. In the browser bundle, `randomUUID` resolved as `undefined`. Click handler chain `addQuestion()` → `defaultQuestion()` → `newQuestionId()` → `randomUUID()` threw `TypeError: randomUUID is not a function`, swallowed by React's error boundary. Same shape as B2 but with `crypto` instead of `fs`, and importantly **the build did not fail** — Next.js silently treats unknown Node modules as empty stubs in the client bundle.

**Why every gate passed:** `@types/node` types made `randomUUID` look type-valid; ESLint has no rule for Node-only imports in client bundles; Vitest runs in Node where `crypto` works fine (so the 9 schema unit tests passed without exercising the bug); `next build` silently stubbed the missing module instead of failing.

**Fix:**
  - `src/lib/survey/schema.ts` — replaced `randomUUID` (Node-only) with `globalThis.crypto.randomUUID()` (Web Crypto API, available in modern browsers + Node 19+). Removed the `import { randomUUID } from "crypto"` line entirely.
  - `src/app/(dashboard)/events/[eventId]/survey/page.tsx` — added defensive `try/catch + console.error + toast.error` around the add-question handler so a similar future bug surfaces in the browser console immediately instead of being silently swallowed. Added full flattened-error console log to the client-side Zod save-validation failure path.

**Pattern to watch for:** any file imported (directly OR transitively) by a `"use client"` component must not import Node-only modules (`crypto`, `fs`, `path`, `os`, `child_process`, `pino`, server-only SDKs). When a click handler "does nothing" with no logs anywhere, suspect this class of failure — the error throws BEFORE the fetch, so server logs don't capture it.

**Detection rule:** for crypto needs in shared modules (schema files, validators, utilities), prefer `globalThis.crypto.*` (Web Crypto API standard) over the Node `crypto` import. Works in both runtimes; no platform-specific code.

**Files:** `src/lib/survey/schema.ts`, `src/app/(dashboard)/events/[eventId]/survey/page.tsx`

---

## 3. Deployment & CI/CD Errors

Full details in `docs/github_action_errors.md`.

### D1 — `P1012: DIRECT_URL not found` in migration container

**Error:** Prisma migration failed — required `DIRECT_URL` env var not passed to Docker container.

**Root cause:** Migration container only received `DATABASE_URL`. Prisma schema requires both for pooled vs direct connections.

**Fix:** Extract and pass both `DATABASE_URL` and `DIRECT_URL` as `-e` args to the migration container.

**File:** `scripts/deploy.sh`

---

### D2 — nginx: `directive "server" has no opening "{"`

**Error:** nginx reload failed after deploy script wrote upstream config.

**Root cause:** Deploy script wrote a bare `server 127.0.0.1:PORT;` line to a `conf.d` file. At the `http {}` level, nginx requires it inside an `upstream {}` block.

**Fix:** Write a complete `upstream ea_sys_app { ... }` block.

**File:** `scripts/deploy.sh`

---

### D3 — nginx: `duplicate upstream "ea_sys_app"`

**Error:** nginx config test failed after fixing D2.

**Root cause:** `sites-available/ea-sys.conf` still contained an inline `upstream ea_sys_app {}` block, duplicating the new `conf.d` file.

**Fix:** Removed inline upstream from `nginx.conf`; upstream now lives exclusively in `conf.d/ea-sys-upstream.conf`.

**Files:** `deploy/nginx.conf`, server config

---

### D4 — Port already allocated (container orphan collision)

**Error:** `Bind for :::3000 failed: port is already allocated` when starting `ea-sys-blue`.

**Root cause:** Old single-slot container `ea-sys` (pre blue-green migration) was still running as a compose orphan on port 3000.

**Fix:** Two-layer guard: (1) explicit port-conflict check that stops any container on the target port, (2) `--remove-orphans` flag on `compose up`.

**File:** `scripts/deploy.sh`

---

### D5 — `docker compose up -d --no-deps` naming conflicts

**Error:** Container naming conflicts from prior failed deployments.

**Root cause:** `--no-deps` didn't clean up orphaned containers from previous runs.

**Fix:** Changed to `docker compose down --remove-orphans && docker compose up -d`.

**File:** `.github/workflows/deploy.yml`

---

## 4. Vercel Compatibility Issues

Full details in `docs/VERCEL_COMPATIBILITY.md`.

### V1 — Database migrations not applied on Vercel

**Severity:** CRITICAL

**Root cause:** Vercel build command was `prisma generate && next build` — never ran `prisma migrate deploy`.

**Fix:** Updated to `prisma generate && prisma migrate deploy && next build`. Added `DIRECT_URL` (non-pooled, port 5432) to Vercel env vars.

---

### V2 — Photo storage defaults to local filesystem

**Severity:** CRITICAL

**Root cause:** `STORAGE_PROVIDER` defaults to `"local"`, which writes to `public/uploads/` — read-only on Vercel.

**Fix:** Set `STORAGE_PROVIDER=supabase` in Vercel env vars. Created Supabase Storage integration.

**File:** `src/lib/storage.ts` (new)

---

### V3 — File-based logging on serverless

**Severity:** CRITICAL

**Root cause:** Logger writes to `logs/app.log` and `logs/error.log` — Vercel has no writable filesystem.

**Fix:** Logger detects `VERCEL` env var and falls back to stdout + database logging (`SystemLog` model with batch insert stream).

**Files:** `src/lib/logger.ts`, Prisma schema (`SystemLog` model)

---

### V4 — In-memory rate limiting ineffective

**Severity:** MAJOR

**Root cause:** `globalThis` Map resets on every Vercel cold start. Rate limiting effectively disabled.

**Status:** Documented. Redis-backed solution needed for strict enforcement.

---

### V5 — Bulk email timeout

**Severity:** MEDIUM

**Root cause:** All emails sent via `Promise.allSettled()` with no batching. Exceeded Vercel's 30s function timeout for 300+ recipients.

**Fix:** Batched into groups of 25 with sequential execution.

**File:** `api/events/[eventId]/emails/bulk/route.ts`

---

### V6 — Large CSV import timeout

**Severity:** LOW-MEDIUM

**Root cause:** Entire CSV processed in one request without chunking or row limit.

**Fix:** Enforced 5,000 row limit.

**File:** `api/contacts/import/route.ts`

---

### V7 — EventsAir import 504 Gateway Timeout

**Severity:** MEDIUM

**Root cause:** EventsAir API call + 500 sequential DB upserts exceeded Vercel's 30s timeout.

**Fix:** Reduced batch size from 500 to 50 contacts per request. Increased `maxDuration` to 60s in `vercel.json`. Client dialog paginates automatically via `hasMore`.

---

### V8 — EventsAir event creation transaction timeout

**Severity:** MEDIUM

**Root cause:** Transaction ran many sequential `await` calls (ticket types, speakers, tracks, hotels, room types, sessions) — exceeded pgbouncer's 5-second transaction timeout on Supabase.

**Fix:** Increased transaction timeout or restructured to smaller transactions.

**File:** `api/import/eventsair/route.ts`

---

## 5. Database & Schema Issues

### DB1 — Attendee has no unique email constraint

**Root cause:** `Attendee.email` had only `@@index`, not `@unique`. Concurrent registrations with same email created duplicates.

**Fix:** Added `@unique` to `Attendee.email`; use `upsert` instead of `findFirst` + conditional `create`.

**File:** `prisma/schema.prisma`

---

### DB2 — `soldCount` race condition on cancel/delete

**Root cause:** `soldCount` decrement and registration update/delete were separate non-transactional operations. Concurrent cancellations caused permanent count drift.

**Fix:** Wrapped in `$transaction()` (same pattern as the CREATE handler).

**File:** `api/events/[eventId]/registrations/[registrationId]/route.ts`

---

### DB3 — Accommodation `bookedRooms` not atomic

**Root cause:** Room availability check, accommodation create, and `bookedRooms` increment were 3 separate operations. Concurrent bookings could overbook.

**Fix:** All create/update/delete operations wrapped in `$transaction()` with fresh capacity checks inside.

**File:** `api/events/[eventId]/accommodations/route.ts`

---

### DB4 — Event create silently dropped `eventType`, `tag`, `specialty`

**Root cause:** Fields were validated by Zod but never destructured or included in `db.event.create` data.

**Fix:** Added all three fields to the destructured variables and create call.

**File:** `api/events/route.ts`

---

### DB5 — `customFields` accepted arbitrary JSON (`z.any()`)

**Root cause:** `z.record(z.string(), z.any())` allowed deeply nested objects, executable content, or multi-MB payloads.

**Fix:** Replaced with `z.record(z.string().max(100), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]))`.

**Files:** `registrations/route.ts`, `registrations/[registrationId]/route.ts`

---

### DB6 — `Event.settings` could overwrite `reviewerUserIds`

**Root cause:** `z.record(z.string(), z.unknown())` with shallow merge — a settings update payload containing `{ reviewerUserIds: [] }` wiped all reviewer assignments.

**Fix:** Event update route strips `reviewerUserIds` from incoming settings before merging. This key is managed exclusively by the reviewers API.

**File:** `api/events/[eventId]/route.ts`

---

### DB7 — Idempotent migration failures on dual deployment

**Root cause:** AWS uses `prisma db push` (direct schema sync) while Vercel uses `prisma migrate deploy`. Migrations that weren't idempotent would fail on one platform.

**Fix:** All migrations use `IF NOT EXISTS`, `EXCEPTION WHEN duplicate_object`, conditional renames. `CREATE TABLE IF NOT EXISTS` followed by `ALTER TABLE ADD COLUMN IF NOT EXISTS` for every column.

---

### DB8 — Prisma error event handler recursive loop

**Root cause:** When the DB log stream's `flush()` failed (e.g., Supabase pooler unreachable), Prisma's `$on("error")` event fired, which logged via `dbLogger` → Pino → DB stream → another failed flush → infinite recursion.

**Fix:** Added guard in `db.ts` to skip `systemLog` targets in the Prisma error event handler.

**File:** `src/lib/db.ts`

---

## 6. Runtime & Infrastructure Errors

### R1 — Docker group permissions for log access

**Error:** Logs API couldn't access Docker socket inside the container.

**Root cause:** The `nextjs` user inside the container wasn't in the Docker group (GID 999).

**Fix:** Added `nextjs` user to Docker group inside the container.

**File:** `Dockerfile`

---

### R2 — Contact sync not completing on Vercel

**Root cause:** All 10 `syncToContact` calls across 9 API routes used fire-and-forget (no `await`). On Vercel serverless, the function terminated before the sync completed.

**Fix:** Added `await` to all `syncToContact` calls.

**Files:** 9 API route files

---

### R3 — EventsAir API calls hanging indefinitely

**Root cause:** No timeout on fetch calls to EventsAir OAuth token and GraphQL endpoints. Slow or unresponsive API caused requests to hang.

**Fix:** Added `fetchWithTimeout()` wrapper with 30s `AbortController` timeout. Both OAuth and GraphQL calls use it.

**File:** `src/lib/eventsair-client.ts`

---

### R4 — No startup validation of required env vars

**Root cause:** Missing `DATABASE_URL` caused opaque crash on first query. Missing `NEXTAUTH_SECRET` silently weakened token hashing.

**Fix:** Added startup validation module that checks all required env vars and fails immediately with clear messages.

---

### R5 — `pino-pretty` in production dependencies

**Root cause:** Listed in `dependencies` instead of `devDependencies`, increasing production bundle size.

**Fix:** Moved to `devDependencies`.

**File:** `package.json`

---

### R6 — Middleware uses Pino (Edge runtime incompatible)

**Root cause:** Edge runtime (used by Next.js middleware) can't use Pino which requires Node.js APIs.

**Fix:** Middleware uses `console.warn` with structured JSON format instead of Pino.

**File:** `src/middleware.ts`

---

### R7 — Worker tick pages on transient Prisma connection errors (advisory-lock acquire)

**Root cause:** The worker's `withJobLock` runs `pg_try_advisory_lock` via `$queryRaw` **outside** the job's own try/catch, so a transient DB-connection error on that acquire escaped to the scheduler's last-resort catch and fired a `worker:tick-wrapper-uncaught` alert — paging a human for a self-healing blip. Two variants hit this, neither recognized by `classifyPrismaError`, so both logged at `error` (alert) instead of `warn`:

- **2026-06-09 — `EDBHANDLEREXITED` / `Error { kind: Closed }`:** Supabase's pooler (Supavisor) dropped a connection the worker had held open; the next query on the dead connection threw. (job: `webinar-recordings`)
- **2026-06-10 — `P2024` pool exhaustion:** the worker's Prisma pool defaults to `physical_cores × 2 + 1 = 3` (the `t3.large` is 1 physical core; `DATABASE_URL` set no `connection_limit`), and several minute-cadence jobs (`cert-issue` + `scheduled-emails` + `webinar-recordings` at `:05`) ticking concurrently on that 3-connection pool starved `cert-issue`'s lock-acquire past `pool_timeout`. (job: `cert-issue`)

**Fix (layered):**
1. `withJobLock` wraps the acquire `$queryRaw`: a **retryable** connection error (per `classifyPrismaError`) becomes a quiet skip (`worker:lock-acquire-transient-skip`, warn) that retries next tick; non-retryable errors still re-throw.
2. `classifyPrismaError` gained `DB connection closed` (EDBHANDLEREXITED / `kind: Closed`) and `DB connection pool timeout` (P2024) as retryable, **and** the connector `$on("error")` log level is now gated on the `retryable` flag — retryable transients log at `warn` (below the SES alert threshold), real problems stay `error`.
3. `cert-issue` poller `* * * * *` → `*/3 * * * *` — fewer idle lock-acquire polls + fewer collisions with the every-minute `scheduled-emails`.
4. Env (operational, on the box): `DATABASE_URL` pool widened to `connection_limit=10&pool_timeout=15` (was the default 3 / 10s). Shared `.env` so web + worker both widen; safe through pgbouncer (it multiplexes).

**Known limitation (P3):** advisory locks are *session*-scoped but run through the Supabase *transaction* pooler, so the singleton guarantee doesn't truly hold across two concurrent workers — fine today (single worker), must be fixed before running a 2nd (e.g. Singapore DR failover) by pointing the worker at `DIRECT_URL`. Documented in `worker/lib/advisory-lock.ts`.

**Files:** `worker/lib/advisory-lock.ts`, `src/lib/db.ts`, `worker/jobs/cert-issue.ts`; `.env` `DATABASE_URL` (operational, not in git). Commits `80c4850` (EDBHANDLEREXITED), `e90c989` (P2024 + poller).

---

## 7. Email System Issues

### E1 — Email template HTML injection (see S9)

Covered in Security section. `escapeHtml()` added to all interpolated values.

---

### E2 — No consistent email branding

**Root cause:** Each template was a standalone full HTML document. No shared header image or footer across emails.

**Fix:** Implemented branding wrapper system:
- `wrapWithBranding()` — adds table-based header image + footer around body content
- `renderAndWrap()` — combines variable substitution + branding + CSS inlining
- Templates now store body fragments only; branding applied at render time
- Event model extended with `emailHeaderImage` and `emailFooterHtml` fields

**Files:** `src/lib/email.ts`, `prisma/schema.prisma`, all 6+ email send routes

---

### E3 — Non-null assertions on `getDefaultTemplate()` in fire-and-forget chains

**Root cause:** Three places used `getDefaultTemplate()!` which would crash if the template slug was renamed or missing.

**Fix:** Replaced with null checks + `apiLogger.warn()`. Missing templates are logged instead of crashing.

---

### E4 — Brevo SDK loads entire module at startup

**Root cause:** `import * as brevo from "@getbrevo/brevo"` loaded the entire SDK at module load time, slowing cold starts.

**Fix:** Changed to named imports + lazy initialization:
```typescript
import { TransactionalEmailsApi, SendSmtpEmail } from "@getbrevo/brevo";
let apiInstance: TransactionalEmailsApi | null = null;
function getApiInstance() { /* create on first call */ }
```

**File:** `src/lib/email.ts`

---

## 8. API & Data Issues

### A1 — REVIEWER/SUBMITTER can leak user data

**Root cause:** No `denyReviewer()` guard on `GET /api/organization/users`. Roles with `organizationId: null` caused query `WHERE organizationId IS NULL`, returning all org-independent users.

**Fix:** Added explicit `organizationId` null check — returns 403 for REVIEWER/SUBMITTER.

**File:** `api/organization/users/route.ts`

---

### A2 — Import-contacts bypasses ticket capacity check

**Root cause:** Blindly incremented `soldCount` without checking available capacity. Could oversell tickets.

**Fix:** Check `soldCount` vs `quantity` inside the transaction; atomic increment on each registration.

**File:** `api/events/[eventId]/registrations/import-contacts/route.ts`

---

### A3 — Speaker deletion doesn't check abstract status

**Root cause:** Deleting a speaker with non-DRAFT abstracts would orphan those abstracts.

**Fix:** Added check for non-DRAFT abstracts before allowing deletion. Returns 400 with a message to remove/reassign abstracts first.

**File:** `api/events/[eventId]/speakers/route.ts`

---

### A4 — No pagination on list endpoints

**Root cause:** All GET endpoints returned ALL records. Events with 10K+ registrations crashed browsers and timed out APIs.

**Fix:** Added server-side pagination on contacts, registrations, and speakers.

**Files:** Multiple API routes and page components

---

### A5 — Account enumeration via submitter registration

**Root cause:** Different error messages for existing vs new email addresses.

**Status:** Documented. Should return generic message regardless of email existence.

**File:** `api/public/events/[slug]/submitter/route.ts`

---

### A6 — `apiLogger` not standardized across routes

**Root cause:** Some routes used `dbLogger`, some had no try/catch, one used `console.error`.

**Fix:** Audited all 48 API route files, fixed 6 issues to use `apiLogger` consistently.

---

## 9. UI/UX Bugs

### U1 — Settings page saves fail silently

**Root cause:** Non-ok responses showed no error toast.

**Fix:** Added error handling with toast notification on save failure.

**File:** `events/[eventId]/settings/page.tsx`

---

### U2 — Double-submit on ticket creation form

**Root cause:** Submit button had no `disabled` state during mutation.

**Fix:** Added `disabled={createTicket.isPending || updateTicket.isPending}`.

**File:** `events/[eventId]/tickets/page.tsx`

---

### U3 — Registration detail sheet discards in-progress edits

**Root cause:** Background React Query data refresh reset the edit state without warning.

**Fix:** Check `isEditing` before resetting state.

**File:** `registrations/registration-detail-sheet.tsx`

---

### U4 — Hydration mismatch with `window.location.origin`

**Root cause:** Using `window.location.origin` in JSX caused server/client content mismatch.

**Fix:** Use `NEXT_PUBLIC_APP_URL` env var instead.

---

### U5 — Sidebar state hydration mismatch

**Root cause:** `useState` + `useEffect` for localStorage-synced sidebar caused flash.

**Fix:** Changed to `useSyncExternalStore` — avoids hydration mismatch and lint warnings.

**File:** `src/contexts/sidebar-context.tsx`

---

### U6 — Check-in camera scanner crashes the page ("Something went wrong") on tab switch

**Error:** Switching from the Camera tab back to Scanner/Manual on the check-in page threw the dashboard error boundary ("Something went wrong"), with **no entry in `logs/app.log` or `docker logs`**.

**Root cause:** Two issues.
1. **stop/clear race.** In the `CameraScanner` unmount cleanup, `Html5Qrcode.stop()` is async but `clear()` was called synchronously immediately after — before `stop()` resolved. html5-qrcode's `clear()` throws `"Cannot clear while scan is in progress"` when the camera is still running. That throw escaped React's effect-cleanup and bubbled to `(dashboard)/error.tsx`.
2. **Wrong place to look for the log.** It's a *client-side* error. Pino writes server-side only, so frontend crashes never reach `logs/app.log` / `docker logs` — they go to the browser console and **Sentry** (`error.tsx` → `Sentry.captureException`, tag `boundary: dashboard`). "Nothing in docker" was expected, not a logging bug.

**Fix:** Sequenced teardown so cleanup never throws — null the ref first, then `stop().catch(()=>{}).then(() => { try { clear() } catch {} })`. Hardened `startCamera()` (tears down any lingering instance first → prevents "camera already in use" on re-entry) and `stopCamera()` (runs `clear()` even if `stop()` rejects). Camera-start failures now `console.error` with context + surface in the UI `error` state.

**Files:** `src/app/(dashboard)/events/[eventId]/check-in/camera-scanner.tsx`

**Prevention:** Any async-teardown library (camera, websocket, media stream) used in a React effect cleanup must sequence its async stop before any synchronous teardown call, and swallow errors — a cleanup throw bubbles to the nearest error boundary. For frontend error visibility, check Sentry, not docker.

---

### U7 — Sidebar "Overview" item duplicates + accumulates on every navigation (June 17, 2026)

**Symptom:** The "Overview" entry in the event sidebar multiplied — 1, then 2, then 3, then 4 — every time the user went from an event into the dashboard and back. The duplicates even leaked onto the **top-level** nav (Overview rows appearing above Dashboard/Events). Only the **expanded** sidebar was affected; a **full page reload** reset it to 1.

**Root cause:** **Duplicate React keys on two sibling sidebar sections.** `eventNavigationSections` has **two sections with `label: ""`** — the Overview group at the top and the Analytics group at the bottom (intentionally header-less). The render keyed sections with `key={section.label || "top"}`, so **both empty-label sections got the identical key `"top"`**. Duplicate sibling keys make React's list reconciliation undefined: on each client-side (router) navigation React failed to unmount the stale Overview section and **leaked a duplicate `<div>` that was never removed**, so it accumulated. The collapsed/flat list keyed by unique `item.name`, which is why only the expanded sidebar showed it; a full reload built fresh DOM, hence the reset to 1.

**Fix:** Key each section by its array index — `key={`section-${si}`}` — so every section is unique + stable. ([src/components/layout/sidebar.tsx](../src/components/layout/sidebar.tsx), commit `fbff00e`.)

**Verification:** Reproduced on the dev server via **client-side** navigation (the bug doesn't appear under full-reload navigation) — 3 event↔Events round-trips, counting sidebar "Overview" links each time. Before: 1→2→3. After: stays 1 (event) / 0 (Events).

**Prevention:** Never key a `.map()` on a value that can repeat (an empty/optional label, a nullable field). Two siblings sharing a key is silently corrupting — React warns in dev but the symptom (leaked/duplicated DOM that grows across navigations, not on reload) looks like a data bug. Prefer the array index or a guaranteed-unique id for list keys when the natural key isn't provably unique.

---

## 10. Package & Dependency Issues

### P1 — Tiptap v3 incompatibility (see B1)

Pinned to v2. v3 ships source-only without compiled `dist/`. Do NOT upgrade.

---

### P2 — `--legacy-peer-deps` required for Tiptap v2

**Root cause:** Tiptap v2 packages have peer dependency conflicts with each other under npm's strict resolution.

**Fix:** Install with `--legacy-peer-deps` flag. Lock file must be regenerated after.

---

### P3 — NextAuth v5 is beta in production

**Root cause:** `next-auth@5.0.0-beta.30` — beta library with potential breaking changes.

**Mitigation:** Pinned to exact version. Plan migration to stable when released.

---

### P4 — Unused tRPC dependencies

**Root cause:** `@trpc/client`, `@trpc/react-query`, `@trpc/server` in `package.json` but no tRPC code in the project.

**Fix:** Remove unused packages.

---

### P5 — Hardcoded personal email fallback

**Root cause:** Fallback sender email in `src/lib/email.ts` was a personal address.

**Fix:** Use `EMAIL_FROM` env var exclusively.

---

## 11. EventsAir Import Bugs

### EA1 — EventsAir API returns null for events list

**Root cause:** `listEvents()` didn't handle null API response, causing silent failure in the import dialog.

**Fix:** `listEvents()` now throws on null response. `useEventsAirEvents` hook uses `retry: false`. Events API route returns actual error details in 500 response.

---

### EA2 — Import dialog shows no error state

**Root cause:** No error state UI — failed imports showed nothing.

**Fix:** Added error state UI with actual error message, Retry button, and Settings link.

**File:** `src/components/import/eventsair-import-dialog.tsx`

---

### EA3 — 504 timeout on contact import (see V7)

Batch size reduced from 500 to 50. `maxDuration` increased to 60s.

---

### EA4 — Transaction timeout on event creation (see V8)

Sequential DB operations exceeded pgbouncer's 5s transaction timeout.

---

### EA5 — No fetch timeout on API calls (see R3)

Added 30s `AbortController` timeout wrapper.

---

### EA6 — CSV import missing header validation

**Root cause:** CSV parser didn't validate required column headers, causing confusing errors when users uploaded wrong file format.

**Fix:** Added header validation in `csv-parser.ts` with clear error messages listing expected columns.

---

## Quick Reference: Error Categories by Severity

| Severity | Count | Key Examples |
|----------|-------|-------------|
| **CRITICAL** | 15 | Command injection, stored XSS, Docker socket, race conditions, no tests |
| **HIGH** | 14 | RBAC bypasses, brute force, no pagination, beta auth library |
| **MEDIUM** | 18+ | Memory leaks, CSRF gaps, input limits, silent failures |
| **LOW** | 12 | Bcrypt cost, aria-labels, unused deps, documentation gaps |
| **Build** | 6 | Tiptap v3, client/server boundary, ESLint hooks, lock file |
| **Deploy** | 5 | Port collisions, nginx config, env vars, orphan containers |

---

## Lessons Learned

1. **Always use `$transaction()` for count-then-write patterns** — non-atomic operations cause drift under concurrency
2. **Client/server module boundary is strict** — never import server-only modules (`fs`, `pino`) in client components, even transitively
3. **Idempotent migrations are mandatory** — dual deployment (EC2 + Vercel) sharing one DB means migrations run in different ways
4. **Pin major versions of critical packages** — especially Tiptap (v2 only), NextAuth (beta), and Prisma
5. **`execFile` over `exec`** — never interpolate user input into shell commands
6. **Sanitize all HTML output** — DOMPurify for DOM rendering, `escapeHtml()` for email templates
7. **`--legacy-peer-deps` requires lock file regeneration** — always run `npm install --package-lock-only` after
8. **Vercel serverless has hard limits** — 30s timeout, no writable filesystem, cold start resets in-memory state
9. **Fire-and-forget doesn't work on serverless** — all async operations must be `await`ed before response returns
10. **Test your deploy pipeline end-to-end** — nginx config, Docker orphans, and env var propagation are common failure points

---

## 12. Abstract submission — "registrant can't submit an abstract" (July 2026)

Plain-English record of a bug fix and the follow-up problems an adversarial code
review caught in the first attempt. Read top to bottom — each part says *what
went wrong* and *what we did*.

### The original problem (the bug we set out to fix)

**Symptom:** A person registers for an event as a normal attendee, then later
wants to submit an abstract. They click "Sign in", and instead of reaching the
abstract form they get dumped on the **My Registration** page — a dead end.

**Why it happened (three things lined up):**
1. Everyone has a *role*. Someone who registered as an attendee has the role
   **REGISTRANT**. A person who submits abstracts needs the role **SUBMITTER**.
2. Our page-guard (middleware) sends **REGISTRANT** users to `/my-registration`
   for *everything* else — correct for attendees, but it also blocked the
   abstract page.
3. Signing in **never changes your role**. Only filling in the abstract sign-up
   *form* upgrades a REGISTRANT into a SUBMITTER. So "just signing in" left them a
   REGISTRANT → bounced to My Registration.

On top of that, the abstract sign-up form showed "You've already registered —
sign in instead" to *anyone* who had a registration, pushing attendees straight
into that dead end.

**What we did (first attempt):**
- Let a REGISTRANT go through the abstract sign-up form (which upgrades them),
  instead of blocking them.
- After sign-in, if the person is a REGISTRANT, send them to the abstract sign-up
  flow instead of the dashboard.

### The adversarial review — what the first attempt got wrong

We ran an independent "try to break it" review. It found three real issues:

**B1 (most serious — a new leak we introduced).**
To tell "attendee" apart from "already a submitter", the first attempt made a
**public** endpoint return each email's **exact role**
(ADMIN / ORGANIZER / SUBMITTER / …). That's an information leak: anyone could feed
in a list of emails and learn which ones are admins — a gift for phishing.
**Fix:** the endpoint now returns a single yes/no flag — `canSelfUpgrade`
(true only for "no account" or a plain REGISTRANT) — and **never** the real role.
Everything privileged just looks like "false", so nothing can be harvested. The
form was also made to **fail safe**: if that flag is ever missing, it blocks
(shows "sign in") rather than letting someone through.
*Files:* `check-email/route.ts`, `abstract/register/page.tsx`.

**H1 (serious — an old hole our change made easy to reach).**
Upgrading a REGISTRANT to SUBMITTER **never checked the password**. It took an
email + any password and flipped the account (and overwrote the person's name).
This hole existed before, but the old "block everyone" behavior hid it; our fix
routed people straight into it. So a stranger who knew your email could flip your
account and rename you.
**Fix:** before upgrading an existing account, we now **verify the account's
current password** (`bcrypt.compare`). Wrong password → `401` with a clear
message ("enter your existing password, or sign in"). Only the real owner can
upgrade.
*File:* `submitter/route.ts`.

**M1 (medium — the dead end could quietly come back).**
Our post-sign-in routing asked the browser for the fresh session to read the
role. If that lookup was momentarily empty (a known timing quirk right after
sign-in), the code fell back to the dashboard → middleware → **My Registration**
again — the exact bug, reappearing at random.
**Fix:** flipped the default to **fail safe** — only a *confirmed* SUBMITTER/staff
goes to the dashboard; a REGISTRANT **or any unknown/empty session** goes to the
abstract sign-up flow (a public page that never dead-ends). Also guarded the
session lookup so it can't throw.
*File:* `login/page.tsx`.

### Result
- An attendee can now submit an abstract two ways: fill the abstract form
  directly (gets upgraded), or click "Sign in" and be routed into that upgrade
  flow — no more dead end.
- Only the account owner (correct password) can upgrade an account.
- The public endpoint no longer reveals anyone's role.

**Lessons:**
1. When you make a hidden/blocked path reachable, re-check the code at the *end*
   of that path — old, latent bugs suddenly become exploitable (H1).
2. A public preflight should answer the *narrowest* question (a boolean), never
   hand back raw identity/role data (B1).
3. Role-based routing should **fail safe** — send the ambiguous case to the
   harmless place, not the one a guard will bounce (M1).

*Files:* `src/app/api/public/events/[slug]/check-email/route.ts`,
`src/app/api/public/events/[slug]/submitter/route.ts`,
`src/app/e/[slug]/abstract/register/page.tsx`, `src/app/e/[slug]/login/page.tsx`.

---

*Cross-references: `docs/SECURITY_AUDIT_FIXES.md`, `docs/PRODUCTION_AUDIT.md`, `docs/VERCEL_COMPATIBILITY.md`, `docs/github_action_errors.md`*
