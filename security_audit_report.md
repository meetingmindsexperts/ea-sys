# EA-SYS Security & Production Readiness Audit

**Date:** 2026-02-26
**Scope:** Full codebase review — auth, API routes, database, file uploads, frontend, email, deployment
**Branch:** claude/wonderful-einstein

---

## CRITICAL Issues (Fix before production)

### 1. Command Injection in Logs API

- **File:** `src/app/api/logs/route.ts:31-48`
- **Description:** The `since`, `tail`, and `search` query params are interpolated directly into a shell command (`docker logs`) without any sanitization. An attacker with SUPER_ADMIN access can inject arbitrary OS commands.
- **Example:** `GET /api/logs?since=1h;rm+-rf+/` → executes `docker logs --since 1h;rm -rf / ...`
- **Impact:** Full remote code execution on the server. Even though it's admin-only, a single compromised admin token = full server takeover.
- **Fix:** Sanitize all inputs with a strict allowlist, or replace `child_process.exec` with the Docker Engine API (HTTP). At minimum, use `execFile` with arguments as an array (not string interpolation).

### 2. Stored XSS via `dangerouslySetInnerHTML` (footerHtml)

- **Files:**
  - `src/app/e/[slug]/register/page.tsx:754`
  - `src/app/e/[slug]/confirmation/page.tsx:161`
  - `src/app/(dashboard)/events/[eventId]/settings/page.tsx:839`
- **Description:** `event.footerHtml` is rendered unsanitized via `dangerouslySetInnerHTML`. Any admin/organizer can inject `<script>` tags that execute on **public-facing** registration pages visited by all attendees.
- **Impact:** Stored XSS affecting unauthenticated users. Could steal session tokens, redirect to phishing pages, or deface the registration form.
- **Fix:** Sanitize HTML with DOMPurify before rendering. Strip `<script>`, `<iframe>`, event handlers (`onclick`, `onerror`, etc.).

### 3. Docker Socket Mounted in Production

- **File:** `docker-compose.prod.yml:20,45`
- **Description:** Both blue/green containers mount `/var/run/docker.sock:/var/run/docker.sock`. If the application is compromised (e.g., via the command injection above), an attacker gets full Docker daemon access.
- **Impact:** Full host compromise — container escape, arbitrary container creation, host filesystem access.
- **Fix:** Remove the Docker socket mount from both services. If Docker API access is needed for the logs feature, use a read-only socket proxy or a separate sidecar container with restricted access.

---

## HIGH Issues (Fix soon)

### 4. SUBMITTER Role Not Blocked on Event Create/Update/Delete

- **Files:**
  - `src/app/api/events/route.ts:85-87`
  - `src/app/api/events/[eventId]/route.ts:84-86`
- **Description:** These routes manually check `role === "REVIEWER"` instead of using `denyReviewer(session)`. The `denyReviewer()` function blocks both REVIEWER **and** SUBMITTER, but these routes only block REVIEWER. SUBMITTER users can create events, update event settings (including `footerHtml`), and delete events.
- **Impact:** Privilege escalation — submitters can modify or delete events they registered for.
- **Fix:** Replace the manual `role === "REVIEWER"` check with `denyReviewer(session)` from `@/lib/auth-guards`.

### 5. No Error Boundaries or Loading States

- **Description:** Zero `error.tsx` or `loading.tsx` files found anywhere in the `src/app/` directory.
- **Impact:** An unhandled error in any server/client component crashes the entire page. Users see a blank white page in production (or stack traces in development). No graceful degradation.
- **Fix:** Add at minimum a root `src/app/error.tsx` and `src/app/loading.tsx`. Consider adding per-section error boundaries for `(dashboard)` and `e/[slug]`.

### 6. Race Condition: Ticket Overselling

- **Files:**
  - `src/app/api/public/events/[slug]/register/route.ts:109-111,183-186`
  - `src/app/api/events/[eventId]/registrations/route.ts:169-174,248-251`
- **Description:** The sold-out check (`soldCount >= quantity`) and the `soldCount` increment are separate, non-atomic operations. Under concurrent registrations, multiple requests can pass the check simultaneously and oversell tickets.
- **Impact:** More tickets sold than available. Financial and logistical problems.
- **Fix:** Use a Prisma transaction with a conditional update:
  ```typescript
  await db.$transaction(async (tx) => {
    const updated = await tx.ticketType.updateMany({
      where: { id: ticketTypeId, soldCount: { lt: tx.ticketType.findFirst(...).quantity } },
      data: { soldCount: { increment: 1 } },
    });
    if (updated.count === 0) throw new Error("Sold out");
    // ... create registration inside same transaction
  });
  ```

### 7. No Magic Byte Validation on File Upload

- **File:** `src/app/api/upload/photo/route.ts:81,108`
- **Description:** Only `file.type` (client-provided MIME type) is validated. The file extension is extracted from the client filename (`file.name.split(".").pop()`). An attacker can upload an HTML file with `Content-Type: image/jpeg` and filename `malicious.html` — it gets saved as `{uuid}.html`.
- **Impact:** Stored XSS via uploaded HTML/SVG files served from the application domain.
- **Fix:** (a) Validate magic bytes of the file buffer against expected signatures. (b) Derive extension from validated MIME type, never from client filename.

### 8. Missing Security Headers on Served Files

- **File:** `src/app/uploads/[...path]/route.ts:33-37`
- **Description:** No `X-Content-Type-Options: nosniff`, no `Content-Security-Policy`, no `X-Frame-Options` headers. Direct access to port 3000 bypasses nginx security headers.
- **Impact:** MIME-sniffing attacks — browsers may interpret uploaded files as HTML/JavaScript.
- **Fix:** Add headers to the response:
  ```typescript
  headers: {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'none'; script-src 'none'",
    "X-Frame-Options": "DENY",
  }
  ```

### 9. Email Template HTML Injection

- **File:** `src/lib/email.ts` (all templates)
- **Description:** All email templates use string interpolation (`${params.speakerName}`, `${params.personalMessage}`, `${params.reviewNotes}`, etc.) without HTML-escaping. User-controlled content is injected directly into HTML email bodies.
- **Impact:** An attacker can inject HTML/CSS that spoofs email content (phishing within legitimate system emails). Could trick recipients into clicking malicious links.
- **Fix:** HTML-escape all user-provided values before interpolation:
  ```typescript
  function escapeHtml(str: string): string {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  ```

### 10. Registration Creation Not Transactional

- **File:** `src/app/api/public/events/[slug]/register/route.ts:167-186`
- **Description:** Registration creation and `soldCount` increment are separate operations. If the increment fails or the app crashes between them, data is inconsistent.
- **Impact:** Data integrity issues — registrations without count updates, or orphaned records on failure.
- **Fix:** Wrap registration creation + soldCount increment + attendee find-or-create in a single `db.$transaction()`.

---

## MEDIUM Issues (Fix when possible)

### 11. In-Memory Rate Limiting Not Production-Grade

- **File:** `src/lib/security.ts:14-26`
- **Description:** Rate limits are stored in a `globalThis` Map. Issues: (a) Blue-green deployment means each container has separate stores (effective limit doubled). (b) Container restart clears all limits. (c) Expired entries are never cleaned (memory leak).
- **Fix:** Use Redis for distributed rate limiting, or at minimum add a periodic cleanup of expired entries.

### 12. Unbounded Queries (No Pagination)

- **Files:** `src/app/api/events/[eventId]/registrations/route.ts:65`, and similar patterns across speakers, sessions, abstracts, accommodations GET handlers.
- **Description:** `findMany` without `take` limit. An event with 10,000+ registrations returns all records in one response.
- **Impact:** Slow responses, high memory usage, potential OOM for large events.
- **Fix:** Add cursor-based or offset pagination with a default `take` limit (e.g., 100).

### 13. Error Responses Leak Internal Details

- **File:** `src/app/api/upload/photo/route.ts:190`
- **Description:** Returns `error.message` in the response body, which can include file system paths like `ENOENT: no such file or directory, open '/app/public/uploads/...'`.
- **Fix:** Return generic error messages. Detailed errors are already logged via `apiLogger`.

### 14. Attendee Model Has No Organization Scoping

- **File:** `prisma/schema.prisma:175-196`
- **Description:** The `Attendee` model has no `organizationId` field. If the same email registers for events in different organizations, the attendee record is shared across orgs. Org A can see dietary requirements, phone numbers, etc. entered via Org B's event.
- **Fix:** Add `organizationId` to Attendee, or scope attendee lookups to the event's organization.

### 15. Orphaned Uploaded Files Never Cleaned

- **File:** `src/components/ui/photo-upload.tsx:68-72`
- **Description:** When photos are removed or replaced, old files remain on disk permanently. No cleanup mechanism exists. With 500KB/file and 20 uploads/hour limit, orphaned files can accumulate ~7GB/month.
- **Fix:** Add a DELETE endpoint for photos and call it when removing/replacing. Consider a periodic cleanup job for files not referenced in the database.

### 16. JWT Has No Explicit Expiration / Not Invalidated on Password Change

- **File:** `src/lib/auth.ts`
- **Description:** No `maxAge` configured on the JWT session strategy (defaults to 30 days). JWTs are not invalidated when a user changes their password — a compromised token remains valid until natural expiry.
- **Fix:** Set explicit `maxAge`, and consider storing a token version/nonce in the JWT that's checked against the database and rotated on password change.

### 17. Password Policy Too Weak

- **Files:** `src/lib/auth.ts:11`, `src/app/api/auth/reset-password/route.ts:13`
- **Description:** Minimum password length is only 6 characters. No complexity requirements.
- **Fix:** Require at least 8 characters. Consider requiring mixed case, numbers, or special characters.

### 18. Bulk Email Has No Recipient Cap / No Batching

- **File:** `src/app/api/events/[eventId]/emails/bulk/route.ts:236-261`
- **Description:** All emails fire concurrently via `Promise.allSettled` with no batch size limit. An event with 5,000 registrations sends 5,000 concurrent API calls to Brevo.
- **Impact:** Brevo rate limit errors, potential OOM, blocked API key.
- **Fix:** Add a maximum recipient cap (e.g., 500) and send in batches with delays (e.g., 50 at a time with 1-second intervals).

---

## LOW Issues (Nice to have)

### 19. No CSRF Protection on Custom API Routes

- **Description:** NextAuth handles CSRF for auth routes, but custom API routes under `/api/events/*` rely solely on cookie-based JWT. A malicious site could POST to these endpoints from a user's browser.
- **Fix:** Verify `Origin`/`Referer` headers on state-changing requests, or implement a CSRF token pattern.

### 20. `x-forwarded-for` IP Spoofing

- **File:** `src/lib/security.ts:28-35`
- **Description:** Client IP is taken from `x-forwarded-for` which is spoofable if the app is accessed without nginx. Rate limiting can be bypassed.
- **Fix:** When behind nginx, configure it to set a trusted `X-Real-IP` header and only trust that.

### 21. Sensitive Data in Audit Logs

- **File:** `src/app/api/events/[eventId]/registrations/route.ts:255-261`
- **Description:** Entire registration objects (including attendee PII — email, phone, dietary requirements) are stored in audit log `changes` JSON.
- **Fix:** Log only entity IDs and changed field names, not full values.

### 22. Path Traversal Check Could Be Stronger

- **File:** `src/app/uploads/[...path]/route.ts:20`
- **Description:** Only checks for `..` in path segments. Does not check for null bytes (`%00`), does not resolve symlinks, does not verify the resolved path is within the uploads directory using `path.resolve()`.
- **Fix:** Use `path.resolve()` canonicalization + directory boundary check + `fs.realpath()` for symlink resolution.

---

## What's Done Well

- Zod validation on virtually all API inputs
- Rate limiting on public endpoints (registration, password reset)
- Anti-enumeration on forgot-password (always returns success)
- Password hashing with bcrypt (cost factor 10)
- Reset tokens hashed with SHA-256 + pepper before storage
- Verification tokens have expiry and are deleted after use
- Transactional writes for password reset flow
- Email sending failures don't block registration
- `.env` files properly gitignored
- Audit logging on important actions
- Proper use of `Promise.all` for parallel queries
- Role-based event scoping via `buildEventAccessWhere`
- 3-layer RBAC enforcement (API + middleware + UI)
- Sentry integration for error monitoring
- Docker log rotation configured

---

## Priority Fix Order

| # | Issue | Effort | Impact |
|---|-------|--------|--------|
| 1 | Command injection in logs API | 1 hour | Prevents RCE |
| 2 | Remove Docker socket mount | 5 min | Prevents container escape |
| 3 | SUBMITTER bypass on event routes | 10 min | Fixes privilege escalation |
| 4 | Sanitize footerHtml with DOMPurify | 30 min | Fixes stored XSS |
| 5 | Add root error.tsx | 15 min | Prevents blank pages |
| 6 | Wrap registration in transaction | 30 min | Fixes data integrity |
| 7 | Add magic byte validation + security headers | 1 hour | Fixes upload XSS |
| 8 | HTML-escape email template variables | 1 hour | Fixes email injection |
| 9 | Fix ticket overselling race condition | 1 hour | Fixes financial risk |
| 10 | Add pagination to list endpoints | 2 hours | Prevents OOM |
