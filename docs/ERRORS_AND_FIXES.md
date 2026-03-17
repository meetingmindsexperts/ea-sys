# EA-SYS — Errors, Issues & Fixes Log

A comprehensive record of every significant error, bug, and issue encountered in the project, organized by category. Each entry includes the root cause, the fix applied, and the files affected.

**Last updated:** 2026-03-17

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

*Cross-references: `docs/SECURITY_AUDIT_FIXES.md`, `docs/PRODUCTION_AUDIT.md`, `docs/VERCEL_COMPATIBILITY.md`, `docs/github_action_errors.md`*
