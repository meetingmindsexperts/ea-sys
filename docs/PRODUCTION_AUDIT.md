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

### 3. CSRF protection bypass when Origin header is absent
- **File:** `src/middleware.ts:46-61`
- The CSRF check is skipped entirely if the `Origin` header is missing. Certain cross-site request methods can omit this header.
- **Fix:** Reject mutation requests (POST/PUT/DELETE) from browser sessions when `Origin` is absent.

### 4. `customFields` accepts arbitrary JSON (`z.any()`)
- **File:** `src/app/api/events/[eventId]/registrations/route.ts:31`
- `z.record(z.string(), z.any())` allows storing deeply nested objects, executable content, or multi-MB payloads. Potential stored XSS and DB bloat vector.
- **Fix:** Replace with `z.record(z.string(), z.union([z.string().max(1000), z.number(), z.boolean()]))`.

### 5. Registration soldCount race condition on cancel/delete
- **File:** `src/app/api/events/[eventId]/registrations/[registrationId]/route.ts:170-180,255-261`
- The `soldCount` decrement and registration update/delete are separate non-transactional operations. Concurrent cancellations cause permanent count drift.
- **Fix:** Wrap in `db.$transaction()` like the CREATE handler already does.

### 6. Accommodation `bookedRooms` not atomic
- **File:** `src/app/api/events/[eventId]/accommodations/route.ts:207-238`
- Room availability check, accommodation create, and `bookedRooms` increment are 3 separate operations. Concurrent bookings can overbook rooms.
- **Fix:** Use `db.$transaction()` with conditional `updateMany` (where `bookedRooms < totalRooms`).

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

### 13. API key auth bypasses RBAC -- null role treated as admin-equivalent
- **File:** `src/lib/api-auth.ts:39-48`
- API key `OrgContext` has `role: null`. RBAC checks for `role === "REVIEWER"` pass for null, giving API keys unrestricted access to contacts, registrations, speakers.
- **Fix:** Scope API key access to specific endpoints or treat null role as restricted.

### 14. REVIEWER/SUBMITTER can leak user data via `/api/organization/users`
- **File:** `src/app/api/organization/users/route.ts:18-48`
- No `denyReviewer()` guard on GET. REVIEWER/SUBMITTER with `organizationId: null` causes query `WHERE organizationId IS NULL`, returning all org-independent users.
- **Fix:** Add early return if `!session.user.organizationId`.

### 15. `Event.settings` accepts arbitrary JSON, can overwrite `reviewerUserIds`
- **File:** `src/app/api/events/[eventId]/route.ts:26`
- `z.record(z.string(), z.unknown())` with shallow merge means `{ reviewerUserIds: [] }` in an event update wipes all reviewer assignments.
- **Fix:** Define explicit Zod schema for settings. Strip `reviewerUserIds` from the generic update endpoint.

### 16. Import-contacts bypasses ticket capacity check
- **File:** `src/app/api/events/[eventId]/registrations/import-contacts/route.ts:70-99`
- Blindly increments `soldCount` without checking available capacity. Can oversell tickets.
- **Fix:** Add atomic capacity check using conditional `updateMany`.

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
