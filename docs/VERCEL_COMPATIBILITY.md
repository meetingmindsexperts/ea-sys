# EC2 vs Vercel Compatibility

This document tracks features that work on EC2/Docker but break or degrade on Vercel's serverless environment, along with their fixes.

## Status Overview

| Issue | Severity | Status | Fix |
|-------|----------|--------|-----|
| Database migrations not applied | CRITICAL | **FIXED** | Added `prisma migrate deploy` to Vercel build |
| Local photo storage (default) | CRITICAL | **FIXED** | Set `STORAGE_PROVIDER=supabase` on Vercel |
| Local photo serving route | CRITICAL | **N/A on Supabase** | Supabase photos use CDN URLs directly |
| File-based logging | CRITICAL | **Mitigated** | Logger falls back to stdout on Vercel |
| In-memory rate limiting | MAJOR | **TODO** | Needs Redis/Vercel KV |
| Docker logs endpoint | MEDIUM | **Known** | Use Vercel log viewer instead |
| Bulk email timeout risk | MEDIUM | **TODO** | Needs batching |
| Large CSV import timeout | LOW-MEDIUM | **Known** | Limit import size |

---

## Critical Issues

### 1. Database Migrations Not Applied

**File:** `vercel.json`

**Problem:** Vercel build command was `prisma generate && next build` — never ran `prisma migrate deploy`. Schema changes tracked in migration files were never applied.

**Fix:** Updated build command to `prisma generate && prisma migrate deploy && next build`.

**Requirement:** `DIRECT_URL` must be set in Vercel environment variables pointing to Supabase's **direct** connection (port 5432, NOT the pooler on port 6543). Prisma needs a non-pooled connection for DDL operations (CREATE TABLE, ALTER TABLE, etc.).

```
# Vercel Environment Variables
DATABASE_URL=postgresql://postgres.xxx:password@aws-0-xx.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1
DIRECT_URL=postgresql://postgres.xxx:password@db.xxx.supabase.co:5432/postgres
```

### 2. Photo Storage Defaults to Local Filesystem

**File:** `src/lib/storage.ts`

**Problem:** `STORAGE_PROVIDER` defaults to `"local"`, which writes to `public/uploads/` — a read-only filesystem on Vercel. Photos silently fail.

**Fix:** Set `STORAGE_PROVIDER=supabase` in Vercel environment variables. Supabase Storage uploads return CDN URLs that work without local filesystem access.

**Required env vars for Vercel:**
```
STORAGE_PROVIDER=supabase
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SUPABASE_STORAGE_BUCKET=photos
```

### 3. Local Photo Serving Route

**File:** `src/app/uploads/[...path]/route.ts`

**Problem:** Reads uploaded photos from `public/uploads/` on the local filesystem. This directory doesn't exist at runtime on Vercel.

**Impact:** Only affects photos uploaded via the `local` storage provider. When using `STORAGE_PROVIDER=supabase`, photos are served directly from Supabase CDN URLs — this route is never hit.

**No code fix needed** — just ensure `STORAGE_PROVIDER=supabase` on Vercel.

### 4. File-Based Logging

**File:** `src/lib/logger.ts`

**Problem:** Writes logs to `logs/app.log` and `logs/error.log`. Vercel has no writable filesystem.

**Current mitigation:** Logger detects `VERCEL` environment variable and falls back to stdout-only logging. Vercel captures stdout in its built-in log viewer.

**Impact:** No persistent log files on Vercel. Use Vercel's Log Drains or Sentry for long-term log storage.

---

## Major Issues

### 5. In-Memory Rate Limiting (Security Gap)

**File:** `src/lib/security.ts`

**Problem:** Rate limits stored in a `globalThis` Map (in-memory). Each Vercel serverless invocation has isolated memory — the Map resets on every cold start.

**Impact:** Rate limiting is effectively disabled on Vercel:
- Photo uploads: 20/hour limit bypassed
- Bulk email: limit bypassed
- CSV imports: limit bypassed

**Used in:**
- `src/app/api/upload/photo/route.ts` (20 photos/hour)
- `src/app/api/events/[eventId]/emails/bulk/route.ts`
- `src/app/api/contacts/import/route.ts`

**Fix needed:** Move to Redis-backed rate limiting (Vercel KV, Upstash Redis, or database-backed). This is the most significant remaining Vercel gap.

### 6. Docker Logs Endpoint

**File:** `src/app/api/logs/route.ts`

**Problem:** Runs `docker logs` command or reads from `logs/` directory. Neither exists on Vercel.

**Impact:** Logs page shows "No logs found" on Vercel. Use Vercel's built-in log viewer at `https://vercel.com/[team]/[project]/logs` instead.

---

## Medium Issues

### 7. Bulk Email Timeout Risk

**File:** `src/app/api/events/[eventId]/emails/bulk/route.ts`

**Problem:** Sends all emails in parallel via `Promise.allSettled()` with no batching. Vercel functions have a 30-second timeout (configured in `vercel.json`).

**Impact:** Sending 300+ emails in a single request could exceed the timeout. On EC2, there's no timeout pressure.

**Fix needed:** Implement batched email sending (e.g., 50 per batch with sequential batches).

### 8. Large CSV Import Timeout

**File:** `src/app/api/contacts/import/route.ts`

**Problem:** Processes entire CSV file in one request without chunking.

**Impact:** Very large imports (100K+ rows) could hit the 30-second Vercel timeout. Normal-sized imports (< 10K rows) should be fine.

---

## What Works Fine on Vercel

- Prisma client singleton (caching correctly disabled in production)
- Middleware scoping and route protection
- Supabase storage provider (when configured)
- CSV exports (built in memory, returned as Response)
- React Query caching (client-side, no server dependency)
- NextAuth authentication
- All API route logic
- No WebSockets, no cron jobs, no background workers

---

## Vercel Environment Variables Checklist

Ensure these are set in the Vercel dashboard (`Settings > Environment Variables`):

```
# Required
DATABASE_URL=postgresql://...pooler...:6543/postgres?pgbouncer=true&connection_limit=1
DIRECT_URL=postgresql://...direct...:5432/postgres
NEXTAUTH_SECRET=<your-secret>
NEXTAUTH_URL=https://your-app.vercel.app

# Storage (required for photo uploads)
STORAGE_PROVIDER=supabase
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SUPABASE_STORAGE_BUCKET=photos

# Recommended
NEXT_PUBLIC_APP_URL=https://your-app.vercel.app
BREVO_API_KEY=<your-key>
EMAIL_FROM=noreply@yourdomain.com

# Optional
NEXT_PUBLIC_SENTRY_DSN=<your-dsn>
SENTRY_DSN=<your-dsn>
LOG_LEVEL=info
```
