# EA-SYS Production Readiness & Robustness Audit

**Date:** 2026-02-26
**Scope:** Full codebase audit across 51 API routes, 80+ handlers, Prisma schema, frontend pages, Docker/CI/CD, and dependencies.

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 10 |
| HIGH | 14 |
| MEDIUM | 18 |
| LOW | 12 |
| **Total** | **54** |

---

## CRITICAL (Fix before next deploy)

### 1. Docker socket mounted into application container
- **File:** `docker-compose.prod.yml:23,49`
- Both blue/green containers mount `/var/run/docker.sock`. If the Node.js process is compromised, an attacker gains visibility into all containers on the host, including environment variables with secrets.
- **Fix:** Remove the docker socket mount. Move the logs-reading feature to a sidecar container or use Docker logging driver APIs instead.

### 2. Docker CLI + curl installed in production image
- **File:** `Dockerfile:34-43`
- `docker-ce-cli` and `curl` are installed in the runner stage. These dramatically increase attack surface for post-exploitation.
- **Fix:** Remove both from the production image. If the logs API needs Docker access, use a separate admin service.

### 3. CSRF protection bypass when Origin header is absent [FIXED]
- **File:** `src/middleware.ts:46-61`
- The CSRF check is skipped entirely if the `Origin` header is missing. Certain cross-site request methods can omit this header.
- **Fix:** Reject mutation requests (POST/PUT/DELETE) from browser sessions when `Origin` is absent.
- **Resolution:** Middleware now blocks requests with missing Origin header for non-API-key sessions (2026-03-13).

### 4. `customFields` accepts arbitrary JSON (`z.any()`) [FIXED]
- **File:** `src/app/api/events/[eventId]/registrations/route.ts:31`
- `z.record(z.string(), z.any())` allows storing deeply nested objects, executable content, or multi-MB payloads. Potential stored XSS and DB bloat vector.
- **Fix:** Replace with `z.record(z.string(), z.union([z.string().max(1000), z.number(), z.boolean()]))`.
- **Resolution:** Replaced with `z.record(z.string().max(100), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]))` in both registration routes (2026-03-13).

### 5. Registration soldCount race condition on cancel/delete
- **File:** `src/app/api/events/[eventId]/registrations/[registrationId]/route.ts:170-180,255-261`
- The `soldCount` decrement and registration update/delete are separate non-transactional operations. Concurrent cancellations cause permanent count drift.
- **Fix:** Wrap in `db.$transaction()` like the CREATE handler already does.

### 6. Accommodation `bookedRooms` not atomic [FIXED]
- **File:** `src/app/api/events/[eventId]/accommodations/route.ts:207-238`
- Room availability check, accommodation create, and `bookedRooms` increment are 3 separate operations. Concurrent bookings can overbook rooms.
- **Fix:** Use `db.$transaction()` with conditional `updateMany` (where `bookedRooms < totalRooms`).
- **Resolution:** All accommodation create/update/delete operations now use `db.$transaction()` with fresh capacity checks inside the transaction (2026-03-13).

### 7. Event create silently drops `eventType`, `tag`, `specialty` [FIXED]
- **File:** `src/app/api/events/route.ts:99-128`
- These fields are validated by Zod but never destructured or written to the database in the `create` call.
- **Fix:** Include `eventType`, `tag`, `specialty` in the destructured variables and the `db.event.create` data.

### 8. Attendee has no unique email constraint -- duplicates under concurrency [FIXED]
- **File:** `prisma/schema.prisma:175-196`
- `Attendee.email` has only `@@index`, not `@unique`. Concurrent registrations with the same email create duplicate records.
- **Fix:** Add `@unique` to `Attendee.email` and use `upsert` instead of `findFirst` + conditional `create` in registration routes.

### 9. No automated tests -- zero test coverage
- **File:** `.github/workflows/deploy.yml`
- No `npm test` step, no test files exist, no test framework in `devDependencies`. Logic bugs can only be caught manually.
- **Fix:** Add a test framework (vitest), write tests for critical paths (registration, auth, RBAC), add `npm test` to CI.

### 10. No startup validation of required environment variables [FIXED]
- **Files:** `src/lib/db.ts`, `src/lib/security.ts`, `src/lib/email.ts`
- Missing `DATABASE_URL` causes opaque crash on first query. Missing `NEXTAUTH_SECRET` silently weakens token hashing. No fail-fast behavior.
- **Fix:** Add a startup validation module that checks all required env vars and fails immediately with clear error messages.

---

## HIGH (Fix within 1-2 sprints)

### 11. No login brute-force protection
- **File:** `src/lib/auth.ts:36-78`
- The `authorize` function has zero rate limiting. Unlimited password attempts possible.
- **Fix:** Add rate limiting keyed by IP+email on `/api/auth/callback/credentials`.

### 12. Weak password policy (min 6 chars only)
- **File:** `src/lib/auth.ts:11`
- `z.string().min(6)` allows `123456`, `aaaaaa`. Combined with no rate limiting, this is serious.
- **Fix:** Require min 8 chars, 1 uppercase, 1 lowercase, 1 number.

### 13. API key auth bypasses RBAC -- null role treated as admin-equivalent [NOT A BUG]
- **File:** `src/lib/api-auth.ts:39-48`
- API key `OrgContext` has `role: null`. RBAC checks for `role === "REVIEWER"` pass for null, giving API keys unrestricted access to contacts, registrations, speakers.
- **Fix:** Scope API key access to specific endpoints or treat null role as restricted.
- **Resolution:** Verified not a bug — API keys are only used in GET (read-only) handlers via `getOrgContext()`. All write routes (POST/PUT/DELETE) use `auth()` session directly, not `getOrgContext`. API key routes also now require ADMIN+ role (2026-03-13).

### 14. REVIEWER/SUBMITTER can leak user data via `/api/organization/users` [FIXED]
- **File:** `src/app/api/organization/users/route.ts:18-48`
- No `denyReviewer()` guard on GET. REVIEWER/SUBMITTER with `organizationId: null` causes query `WHERE organizationId IS NULL`, returning all org-independent users.
- **Fix:** Add early return if `!session.user.organizationId`.
- **Resolution:** Added explicit `organizationId` null check — returns 403 for REVIEWER/SUBMITTER (2026-03-13).

### 15. `Event.settings` accepts arbitrary JSON, can overwrite `reviewerUserIds` [FIXED]
- **File:** `src/app/api/events/[eventId]/route.ts:26`
- `z.record(z.string(), z.unknown())` with shallow merge means `{ reviewerUserIds: [] }` in an event update wipes all reviewer assignments.
- **Fix:** Define explicit Zod schema for settings. Strip `reviewerUserIds` from the generic update endpoint.
- **Resolution:** Event update route now strips `reviewerUserIds` from incoming settings before merging — this key is managed exclusively by the reviewers API (2026-03-13).

### 16. Import-contacts bypasses ticket capacity check [FIXED]
- **File:** `src/app/api/events/[eventId]/registrations/import-contacts/route.ts:70-99`
- Blindly increments `soldCount` without checking available capacity. Can oversell tickets.
- **Fix:** Add atomic capacity check using conditional `updateMany`.
- **Resolution:** EventsAir contact import now checks `soldCount` vs `quantity` inside the transaction and atomically increments `soldCount` on each registration (2026-03-13).

### 17. No pagination on registrations, speakers, abstracts API & UI
- **Multiple files**
- All event sub-resource GET endpoints return ALL records. Events with 10,000+ registrations will crash browsers and timeout APIs.
- **Fix:** Add server-side pagination with validated `page`/`limit` params.

### 18. `footerHtml` stored XSS risk
- **Files:** `prisma/schema.prisma:114`, `src/app/api/public/events/[slug]/route.ts:48`
- `footerHtml` is served raw to public endpoints. If rendered with `dangerouslySetInnerHTML` without sanitization, it's stored XSS.
- **Fix:** Sanitize with DOMPurify server-side before storage or ensure all render points use `sanitizeHtml()`.

### 19. `next-auth` is beta (`5.0.0-beta.30`) in production
- **File:** `package.json:48`
- Beta auth libraries may have undiscovered vulnerabilities and breaking API changes.
- **Fix:** Pin to exact version (`"next-auth": "5.0.0-beta.30"` without `^`). Plan migration to stable when released.

### 20. No Content-Security-Policy header
- **Files:** `next.config.ts`, `deploy/nginx.conf`
- No CSP anywhere. No browser-level XSS defense.
- **Fix:** Add CSP header in nginx or Next.js middleware restricting script sources.

### 21. In-memory rate limiting ineffective across instances
- **File:** `src/lib/security.ts:19-43`
- `globalThis` Map-based rate limiter resets on restart and is per-process.
- **Fix:** Use Redis for rate limiting, or add infrastructure-level rate limiting (nginx, AWS WAF).

### 22. `x-forwarded-for` header spoofable for rate limit bypass
- **File:** `src/lib/security.ts:46-53`
- Client-provided `x-forwarded-for` is trusted without validation.
- **Fix:** Configure nginx to overwrite `X-Forwarded-For` with actual client IP.

### 23. Event DELETE cascades all data with no safeguard
- **File:** `src/app/api/events/[eventId]/route.ts:211`
- Single API call permanently destroys all registrations, speakers, sessions, abstracts. No soft-delete, no confirmation count.
- **Fix:** Add soft-delete (`status: ARCHIVED`) or require explicit confirmation with record counts.

### 24. No `.env.example` file
- **Fix:** Create `.env.example` documenting all required and optional variables.

---

## MEDIUM (Fix within the quarter)

### 25. `organizationId!` non-null assertion used without null check
- Multiple routes use `session.user.organizationId!` which becomes `WHERE organizationId IS NULL` for REVIEWER/SUBMITTER users if guards fail.
- **Fix:** Add explicit null check before using `organizationId` in queries.

### 26. Missing `onDelete` specifications on critical FK relations
- `Registration.ticketType`, `Registration.attendee`, `Accommodation.roomType`, `Abstract.track`, `Speaker.user` all lack `onDelete` specs.
- **Fix:** Add `onDelete: Restrict` on ticketType/attendee, `onDelete: SetNull` on track/user.

### 27. Speaker deletion doesn't clean up reviewer assignments
- Deleting a speaker who is a reviewer leaves stale entry in `Event.settings.reviewerUserIds`.
- **Fix:** Remove userId from `reviewerUserIds` when deleting a speaker.

### 28. Session speaker update not transactional
- **File:** `src/app/api/events/[eventId]/sessions/[sessionId]/route.ts:161-190`
- Delete all + create new + update session are 3 separate operations.
- **Fix:** Wrap in `db.$transaction()`.

### 29. No Zod validation on QR code check-in PUT
- **File:** `src/app/api/events/[eventId]/registrations/[registrationId]/check-in/route.ts:126`
- Raw `req.json()` destructuring.
- **Fix:** Add Zod schema with `.max(200)`.

### 30. Unbounded array inputs on import/bulk endpoints
- `contactIds`, `recipientIds`, `speakerIds` arrays have `.min(1)` but no `.max()`.
- **Fix:** Add `.max(500)` to all array schemas.

### 31. Email schema fields lack length limits
- `customSubject` and `customMessage` accept unlimited-length strings.
- **Fix:** Add `.max(200)` for subject, `.max(10000)` for message.

### 32. CSV import has no file size or row limit
- **File:** `src/app/api/contacts/import/route.ts`
- 1MB CSV can contain thousands of rows with no cap.
- **Fix:** Add max row limit (5,000) and explicit file size check.

### 33. Settings page saves fail silently
- **File:** `src/app/(dashboard)/events/[eventId]/settings/page.tsx:210-231`
- Non-ok responses show no error toast.
- **Fix:** Add error handling with toast notification on save failure.

### 34. Double-submit on ticket creation form
- **File:** `src/app/(dashboard)/events/[eventId]/tickets/page.tsx:289`
- Submit button has no `disabled` during mutation.
- **Fix:** Add `disabled={createTicket.isPending || updateTicket.isPending}`.

### 35. All React Query hooks return `any` types
- **File:** `src/hooks/use-api.ts`
- File-level eslint-disable for explicit-any. All consumers use unsafe casts.
- **Fix:** Add proper TypeScript generics matching API response shapes.

### 36. Registration detail sheet silently discards in-progress edits
- **File:** `src/app/(dashboard)/events/[eventId]/registrations/registration-detail-sheet.tsx:88-91`
- Background data refresh resets edit state without warning.
- **Fix:** Check `isEditing` before resetting state, or warn user.

### 37. No HSTS header
- **File:** `deploy/nginx.conf`
- Missing `Strict-Transport-Security`.
- **Fix:** Add `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;`

### 38. Accommodation/Settings pages don't use React Query
- Raw `useEffect + fetch + useState` -- no caching, no background refresh.
- **Fix:** Migrate to React Query hooks pattern used elsewhere.

### 39. Account enumeration via submitter registration
- **File:** `src/app/api/public/events/[slug]/submitter/route.ts:112-116`
- Different error for existing vs new email.
- **Fix:** Return generic message regardless of email existence.

### 40. Audit log stores full entity state (PII)
- Full `before`/`after` objects with attendee emails, phones, dietary info stored in audit logs.
- **Fix:** Store only changed fields. Consider periodic cleanup.

### 41. No Docker HEALTHCHECK instruction
- **File:** `Dockerfile`
- Docker has no awareness of container health.
- **Fix:** Add `HEALTHCHECK CMD curl -f http://localhost:3000/api/health || exit 1`.

### 42. tRPC dependencies appear unused
- **File:** `package.json:36-38`
- `@trpc/client`, `@trpc/react-query`, `@trpc/server` listed but no tRPC code exists.
- **Fix:** Remove unused packages.

---

## LOW (Address over time)

| # | Issue | Location |
|---|-------|----------|
| 43 | Bcrypt cost factor 10 (OWASP recommends 12+) | `src/lib/auth.ts:60` |
| 44 | 5-minute stale JWT role window | `src/lib/auth.ts:113` |
| 45 | Health check leaks env info and version | `src/app/api/health/route.ts:12-20` |
| 46 | `Retry-After` header inconsistent on 429s | Multiple rate-limited routes |
| 47 | No sub-route error boundaries | `src/app/(dashboard)/events/[eventId]/*/` |
| 48 | No skeleton loading states | All dashboard pages |
| 49 | `URL.createObjectURL` not revoked in CSV export | `registrations/page.tsx:130` |
| 50 | Icon-only buttons missing `aria-label` | Tickets, abstracts, registration pages |
| 51 | `pino-pretty` in production deps | `package.json:50` |
| 52 | `confirm()` used instead of `AlertDialog` (8 places) | Multiple dashboard pages |
| 53 | Hardcoded personal email fallback | `src/lib/email.ts:46` |
| 54 | Documentation says file logs, but logger only uses stdout | `src/lib/logger.ts` vs CLAUDE.md |

---

## Positive Findings (What's done well)

- **File upload security** -- Magic byte validation, UUID filenames, CSP on served files, path traversal protection
- **SQL injection prevention** -- Prisma parameterized queries throughout, no raw SQL
- **Email template XSS prevention** -- `esc()` function on all interpolated values
- **Token security** -- SHA-256 hashed verification tokens with pepper, proper expiry
- **Sentry integration** -- Well-configured with privacy (masking, blocking media)
- **Logger redaction** -- Passwords, tokens, auth headers properly redacted
- **Audit logging** -- Comprehensive audit trail on most write operations
- **Blue-green deployment** -- Zero-downtime deploys with health check validation
- **React Query caching** -- Good UX with instant navigation and background refresh
- **DOMPurify sanitization** -- All `dangerouslySetInnerHTML` uses are protected
- **Command injection prevention** -- Logs API uses `execFile` with allowlists

---

## 5-Year Robustness Risks

| Risk | What breaks | Fix |
|------|------------|-----|
| No pagination | Event with 50K registrations crashes browsers | Server-side pagination on all list endpoints |
| No test suite | Every change is a potential regression | Add vitest + integration tests for auth, RBAC, registration |
| `soldCount` drift | Ticket availability becomes inaccurate after years of concurrent use | Transactional count updates everywhere |
| JSON fields grow unbounded | `settings`, `customFields`, `socialLinks` accumulate garbage data | Schema validation + periodic cleanup jobs |
| Orphaned Attendee records | DB bloat -- attendees never cleaned up after registration deletion | Add cascade delete or scheduled cleanup |
| No log rotation setup | Disk fills if file logging is re-enabled | Configure pino file rotation or rely solely on Docker log driver |
| Beta auth library | NextAuth v5 may change APIs, lose community support | Track stable release, pin exact version |
| No monitoring/alerting | Server goes down, nobody knows | Add external uptime monitoring + deploy notifications |

---
---

# Round 2 — Multi-Tenant Readiness Audit

**Date:** 2026-06-23
**Trigger:** Pre-multi-tenant ("white-label SaaS") cross-tenant review. An IDOR class was flagged while writing `docs/MULTI_TENANCY.md`; this round looks for "what else."
**Method:** 3 parallel adversarial review agents (lenses: cross-tenant/IDOR/org-scoping · RBAC/finance/auth · data-integrity/races/silent-failures), each verifying every claim against source (`file:line`). One agent-reported "critical" (refund route) was inspected and **rejected as safe**.
**Context:** EA-SYS is single-org today; cross-tenant gaps are *latent* now and become *live data leaks* with a 2nd tenant. Several findings below, however, are **live-impacting even in single-org**. The May-18 audit (separate report) fixed an earlier IDOR set; these are the residual + new findings.

| Severity | Count |
|----------|-------|
| BLOCKER | 0 |
| HIGH | 5 |
| MEDIUM | 5 |
| LOW | 4 |
| **Round-2 total** | **14** |

> **Status legend:** OPEN = not yet fixed. All Round-2 findings are OPEN at time of writing.

---

## Round 2 — HIGH

### 55. [IDOR-1] Promo-code GET leaks another event's config + attendee PII — OPEN
- **File:** `src/app/api/events/[eventId]/promo-codes/[promoCodeId]/route.ts:47` (GET)
- Resolves the promo code by `{ id, eventId }` with **no `organizationId` / event-org check**. The PUT and DELETE in the *same file* DO bind org (lines ~117) — so this is an inconsistency, not the pattern. Response includes the discount config **plus the last 50 redemptions: attendee names, emails, original/discount/final prices**.
- **Impact:** Live even single-org — any authenticated principal (including org-null REGISTRANT / SUBMITTER / REVIEWER) who knows/enumerates an `eventId`+`promoCodeId` reads another event's promo + attendee PII. Cross-tenant PII leak the moment a 2nd org exists.
- **Fix:** Add the org-bound event check before the lookup (mirror the PUT): `db.event.findFirst({ where: { id: eventId, organizationId: session.user.organizationId! }, select: { id: true } })` → 404 if missing.

### 56. [IDOR-2] Accommodation PUT repoints booking to a foreign-event/org room type — OPEN
- **File:** `src/app/api/events/[eventId]/accommodations/[accommodationId]/route.ts:188` (PUT)
- The accommodation row is org-verified, but the body's `roomTypeId` is resolved via `findUnique({ where: { id: data.roomTypeId } })` — **bare id, not bound to the event/hotel/org** — then `bookedRooms` is incremented on it.
- **Impact:** Cross-org inventory tampering + referential break with a 2nd tenant; *today* a within-org cross-event integrity bug (book against another event's room type, inflate its counter).
- **Fix:** Resolve the new room type bound to the same event: `tx.roomType.findFirst({ where: { id: data.roomTypeId, hotel: { eventId } } })` → throw `ROOM_NOT_FOUND` if missing. (The create path in `accommodation-service.ts` already binds the event — gap is the *update* path.)

### 57. [RBAC-1] `bulk-tags` PATCH routes missing `denyReviewer` — OPEN
- **Files:** `src/app/api/events/[eventId]/registrations/bulk-tags/route.ts:16` and `src/app/api/events/[eventId]/speakers/bulk-tags/route.ts:16` (both PATCH)
- The **only two** event-scoped admin write routes missing the `denyReviewer(session)` guard (every sibling — `bulk-type`, imports, tags, hotels, sponsors — has it). `src/proxy.ts` does not 403 MEMBER/restricted roles on `/api/*`, so the per-route guard is the sole gate.
- **Impact:** MEMBER (read-only viewer) and ONSITE can overwrite/clear tags in `replace` mode (data loss). Tags drive bulk-email cohorts **and** tag-driven certificate eligibility, so blast radius is beyond cosmetic. Same class as the May-18 contacts write-guard fix.
- **Fix:** Add `const denied = denyReviewer(session); if (denied) return denied;` after the auth check in both handlers (no `{ allow }` — neither is a registration-desk action).

### 58. [DATA-1] `PromoCode.usedCount` never decremented on cancel/delete — OPEN
- **Files:** increment at `src/app/api/public/events/[slug]/register/route.ts:377` (atomic, correct); **no decrement exists anywhere** (`grep usedCount | decrement` → none). `Registration.promoCodeId` is stored but never released.
- **Impact:** Live-money. A limited-use code (`maxUses`) reaches its cap, an admin cancels some of those registrations, and the code is **permanently exhausted** — silently rejecting valid attendees who should still get the discount.
- **Fix:** In the REST PUT cancel branch, REST DELETE, MCP `update_registration`(→CANCELLED) and MCP `bulk_update_registration_status`(→CANCELLED), add `tx.promoCode.update({ where: { id }, data: { usedCount: { decrement: 1 } } })` inside the existing transaction, guarded against double-decrement on already-cancelled rows (mirror the `soldCount` `isBecomingCancelled` check).

### 59. [DATA-2] Accommodation overbooking TOCTOU — comment falsely claims atomicity — OPEN
- **File:** `src/services/accommodation-service.ts:204`
- The comment states "Atomic: re-check availability inside the tx via `bookedRooms < totalRooms` predicate on the update," but the code is **read-then-write**: `findUnique` → `if (bookedRooms >= totalRooms) throw` → later `update({ bookedRooms: { increment: 1 } })`. Under READ COMMITTED via the pgbouncer transaction pooler there's no row lock between read and increment.
- **Impact:** Two concurrent bookings of the last room both pass and both increment → `bookedRooms = totalRooms + 1` (double-booked, one attendee has no bed). Live even single-org.
- **Fix:** Make the increment the guard — raw conditional `UPDATE "RoomType" SET "bookedRooms" = "bookedRooms" + 1 WHERE id = $1 AND "bookedRooms" < "totalRooms"`, check rows-affected = 0 → `NO_ROOMS_AVAILABLE`. Same pattern `TicketType.soldCount` already uses on the create path. (Also corrects the misleading comment.)

---

## Round 2 — MEDIUM

### 60. [FIN-1] Accommodation + hotel GET leak prices to MEMBER (no finance redaction) — OPEN
- **Files:** `src/app/api/events/[eventId]/accommodations/route.ts:48` (GET returns `Accommodation.totalPrice`), `src/app/api/events/[eventId]/hotels/route.ts:24` (GET returns `RoomType.pricePerNight`). Neither applies `canViewFinance`/`redactFinancialFields`, unlike event/tickets/registrations GETs.
- **Secondary defect:** `totalPrice` is **not in `FINANCIAL_KEYS`** (`src/lib/finance-visibility.ts:46`), so even adding redaction wouldn't strip it.
- **Impact:** MEMBER (defined as "no financial data") reaches these pages/APIs and sees prices. ONSITE is finance-capable by design — unaffected.
- **Fix:** Gate both GETs with `canViewFinance(role) ? data : redactFinancialFields(data)`; add `"totalPrice"` to `FINANCIAL_KEYS`.

### 61. [DATA-3] Reactivate / type-change `soldCount` increment is read-then-write (oversell) — OPEN
- **Files:** REST `src/app/api/events/[eventId]/registrations/[registrationId]/route.ts:461` (reactivate) & `:481` (type-change); MCP `src/lib/agent/tools/registrations.ts:599` & `:618`. Increment not guarded by an `updateMany({ where: { soldCount: { lt: quantity } } })`.
- **Impact:** Two concurrent reactivations/type-changes of the last seat both pass the `>=` check → oversell. Lower severity than DATA-2 (admin-initiated, low concurrency).
- **Fix:** Convert each increment to the atomic predicate `updateMany` + `count === 0 → CAPACITY_EXCEEDED` (the create paths already do this).

### 62. [DATA-4] CSV / EventsAir import capacity check is read-then-write — OPEN
- **Files:** `src/app/api/events/[eventId]/import/registrations/route.ts:313`, `src/app/api/events/[eventId]/import/eventsair/route.ts:147`. Per-row `findUnique` → check → increment inside the loop.
- **Impact:** Concurrent imports (or an import racing public registration) can oversell. Admin-only, rare concurrency.
- **Fix:** Same atomic `updateMany` predicate guard.

### 63. [DATA-5] Stripe post-payment invoice has no reconciliation — OPEN
- **File:** `src/app/api/webhooks/stripe/route.ts:182` — invoice auto-create + email runs in a **detached** `(async () => {})()` after the main tx commits. On failure it **logs** (improved since prior audit) but **never retries**, and being post-commit/detached it can't trigger Stripe's webhook retry.
- **Impact:** A pooler blip or SES throttle during `createPaidInvoice`/`sendInvoiceEmail` → a durably `PAID` registration silently missing its system invoice, with nothing re-attempting.
- **Fix:** Add a worker reconciliation sweep (find `PAID` + `price > 0` registrations with no `INVOICE` row → create+send). The worker tier already exists for this. (Keep the *email* out of any DB transaction.)

### 64. [DATA-6] Registration DELETE hard-deletes a possibly-shared Attendee — OPEN (currently un-triggerable)
- **File:** `src/app/api/events/[eventId]/registrations/[registrationId]/route.ts:671`. Unconditionally `tx.attendee.delete` after deleting the registration; FK defaults to `Restrict`.
- **Impact:** If a sibling registration shares the attendee, the delete throws P2003, the tx rolls back, and DELETE 500s. **Currently un-triggerable** — every create path makes a fresh Attendee or reuses only truly-orphaned ones, and email-change *clones* rather than shares. A latent landmine: the first feature that links an existing Attendee to a 2nd registration breaks DELETE.
- **Fix:** Gate the attendee delete on `tx.registration.count({ where: { attendeeId, id: { not: registrationId } } }) === 0` (the email-change route already has this sibling-count pattern).

---

## Round 2 — LOW

| # | Issue | Location | Note |
|---|-------|----------|------|
| 65 | Organization GET returns billing/tax (`taxId`, company block) with no finance gate | `src/app/api/organization/route.ts:31` | MEMBER can read org billing identity; add `denyFinance`/redact. `taxId`/`companyName` also missing from `FINANCIAL_KEYS`. |
| 66 | `import-contacts` never increments `TicketType.soldCount` | `src/app/api/events/[eventId]/registrations/import-contacts/route.ts:86` | Under-counts the counter (opposite drift from DATA-3/4); rows still authoritative. |
| 67 | Two empty `catch {}` with no log | `src/app/api/organization/branding/route.ts:29`, `src/app/api/auth/forgot-password/route.ts:53` | Benign (non-mutating read / malformed-body 400) but violate the "every failure logs" rule. |
| 68 | Public document/payment-status routes gated only by CUID unguessability | `public/events/[slug]/registrations/[registrationId]/{document,payment-status}` | Correctly event-scoped (NOT cross-tenant); rate-limited. Data-minimization residual — consider a short-lived token if links are ever shared. |

---

## Round 2 — Cleared / verified-not-a-defect

- **Refund route** (`registrations/[registrationId]/refund/route.ts`) — bare-id `findUnique` is gated by the org-bound event + `registration.eventId === eventId`; transitively org-safe. (An agent over-flagged this — confirmed safe.)
- **`refreshEventStats`** — full recompute via `groupBy`/`count` + `upsert`, **not** a read-modify-write delta → no lost-update. (Clears the prior-flagged concern.)
- **`WebinarPresence` upsert** — race-safe via `@@unique([sessionId, registrationId])`; `joinCount` is informational, not a capacity guard.
- **MCP surface** — every event tool routes through `getOrgIdSecure(eventId, authedOrgId)` (404 cross-org); org-level inline tools bind `ctx.organizationId`. **Finance boundary sound** — MEMBER/ONSITE cannot mint MCP tokens (API keys admin-issued; OAuth grant requires ADMIN/SUPER_ADMIN/ORGANIZER), so ungated finance tools at the MCP transport are not reachable by a non-finance principal. Tokens carry no role (no stale-role snapshot).
- **ONSITE allow-list** — `denyReviewer(…, { allow })` appears on exactly the 5 intended routes (create-registration, check-in POST+PUT, record-payment, badges); no other route allows ONSITE.
- **Internal-domain / promote-on-invite** — attaches the event's own org, gated by trusted/verified tier; existing-user branch never mutates role/org; promote requires ADMIN+ and refuses foreign-org users.
- **Migrations** — all since the cert-collapse are additive + `IF NOT EXISTS` / `DO $$ … duplicate_object` guarded → blue-green safe (incl. `20260623000000_add_webinar_presence`).
- **May-18 "~8 silent safeParse→400" backlog** — **CLOSED** (swept ~110 safeParse sites, 0 missing logs).
- **Registrant invoice/quote `denyFinance`** — **FIXED** (owner-vs-org-member branch with null-org 403).
- **`PricingTier.soldCount` one-way leak** — **documented/intentional** (`registration-service.ts` block comment; dashboard counts rows, not the counter). Not a new finding.

---

## Round 2 — Recommended fix order (for live prod)

1. **DATA-1** (promo exhaustion — actively denies attendees) and **RBAC-1** (tag tampering) — small, live impact today.
2. **DATA-2** (overbooking — false-atomic comment masks it) and **IDOR-2** (accommodation roomType — also an integrity bug today).
3. **IDOR-1** (promo PII leak) and **FIN-1** (MEMBER price leak + `FINANCIAL_KEYS` gap).
4. **DATA-3/4** (oversell races), **DATA-5** (invoice reconciliation worker), then **DATA-6** before any feature introduces shared attendees; LOWs as cleanup.

**Regression-prevention suggestion:** a CI grep that flags `findUnique({ where: { id } })` / `findFirst({ where: { id, eventId } })` on tenant-owned models without an `organizationId` / org-bound-event check — would have caught IDOR-1 and IDOR-2.
