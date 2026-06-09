# Worker extraction plan — move cron + background jobs to a Node service

> Plan of record for extracting the 5 cron-fired jobs (cert renderer,
> scheduled emails, webinar recordings, webinar attendance/engagement,
> MCP OAuth cleanup) out of the Next.js API routes into a dedicated
> Node worker process running in its own Docker container on the same
> EC2 box.
>
> **Status**: Phases 1 + 2 shipped 2026-06-04. Phase 3 (dual-write
> watch window) in progress. Phase 4 **operational half done early
> 2026-06-09** — the 5 `/api/cron/*` crontab lines on Mumbai are
> commented out (backed up to `/home/ubuntu/crontab.backup.2026-06-09.txt`;
> 3 DR lines untouched), so the worker is now the SOLE runner. Route-shim
> code deletion still pending (kept as rollback handle). Triggered early
> while resolving the 2026-06-09 `EDBHANDLEREXITED` worker alert — see
> CLAUDE.md Recent Features.
> **Owner**: Krishna.
> **Sister docs**: [POSTGRES_BACKUP_PLAN.md](../infra/dr/POSTGRES_BACKUP_PLAN.md)
> for the design-doc convention; [ARCHITECTURE.md](ARCHITECTURE.md)
> §"Services Layer" for the broader services-extraction direction this
> aligns with.

---

## 1. Why we're doing this

The current pattern — external cron hits `/api/cron/*` endpoints with
a `CRON_SECRET` — works, but it has three real costs that compound:

1. **CPU bursts in the Next.js process degrade dashboard latency.**
   The certificate issue worker uses pdf-lib + pdfjs to render PDFs;
   a burst (50 renders/tick × ~50ms each = 2.5s of CPU) competes
   directly with dashboard API responses. The June 3 CPU
   investigation showed the 63% spike at 05:15 UTC was a Next.js
   cold-start under StrictMode double-invoke — proving the same box
   handles both serving + heavy work today. A separate process
   isolates that.

2. **Long-running work doesn't fit Next.js's request/response shape.**
   The worker logic is genuinely background-work-shaped: drain
   PENDING rows from a DB table on a cadence, with state machines
   for retries + idempotency. Hosting it as HTTP routes adds a
   meaningless framing layer (Next builds a Response just to discard
   it; cron has to pass a secret header; logs are tagged as web
   requests).

3. **Scheduling lives outside the codebase.** External crontab lines
   on the Mumbai box are invisible to CI, code review, and the
   `/admin/docs` viewer. They drift silently from what the code
   expects. Moving to an in-process scheduler (`node-cron`) puts the
   schedule next to the job in source.

This is the second of the two architectural moves flagged in the
"would I still choose Next.js" reflection (the first was "skip Vercel
optionality"). It's the higher-impact one.

### Decisions locked in (2026-06-03)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| Q1 | Repo structure | **Same repo, new `worker/` folder, shared root `package.json`** | Solo-dev velocity over monorepo purity. Worker imports `@/lib/*` via existing tsconfig paths, no code duplication, one CI, one deploy |
| Q2 | Scheduler library | **`node-cron`** | Minimal (~70 KB), cron-syntax-compatible, schedules live in code. No persistence layer needed since job state already lives in Postgres (ScheduledEmail / CertificateIssueRunItem / ZoomMeeting). Process restart loses next-tick but picks up on the next interval — fine for our 1-10 min cadences |
| Q3 | Migration strategy | **Dual-write window (~1 week)** | Ship worker + keep `/api/cron/*` routes as thin shims pointing at the same shared functions. Verify worker behavior in prod for a week. Then delete routes + cron lines in a follow-up commit. Easy rollback if worker has an unforeseen issue |

### RPO/RTO targets

- **Worker process restart**: <10s (Docker SIGTERM → SIGKILL after 30s grace)
- **Worst-case missed tick**: one cadence (so 60s for scheduled-emails, 10 min for webinar-attendance) if worker dies mid-tick AND the next process boot races the natural cron rhythm
- **Job durability**: PENDING rows stay in Postgres; nothing in-memory survives restart, nothing in-memory NEEDS to survive restart

---

## 2. Inventory — what moves, what stays

### Moves to the worker

| Job | Current location | Cadence | Notes |
|---|---|---|---|
| Scheduled email drainer | `/api/cron/scheduled-emails` | every 1 min | Drains ScheduledEmail PENDING rows + invokes bulk-email pipeline |
| Certificate issue worker | invoked by scheduled-emails tick today | every 30s after extraction | CPU-heaviest job by far — biggest reason to extract |
| Webinar recording sync | `/api/cron/webinar-recordings` | every 5 min | Polls Zoom `/meetings/{id}/recordings` |
| Webinar attendance + engagement | `/api/cron/webinar-attendance` | every 10 min | Polls Zoom participant report + chains polls/Q&A |
| MCP OAuth cleanup | `/api/cron/mcp-oauth-cleanup` | hourly | Deletes expired codes + tokens past 7-day grace |

### Stays in Next.js (request-driven, not background)

- `/api/webhooks/stripe` — webhook-driven, not cron
- All dashboard CRUD routes
- MCP HTTP transport (`/api/mcp/*`)
- AI agent execute endpoint
- Public registration flows
- File upload endpoints

### Stays as bash crons on the Mumbai box (no Node value-add)

- Uploads sync to Singapore (`aws s3 sync`, hourly)
- Postgres `pg_dump` to Singapore (`scripts/dr-pg-dump.sh`, daily 23:00 UTC)
- `.env` snapshot to Singapore (daily 21:00 UTC)

These don't touch Prisma or any Node logic. System-cron is correct
for them.

---

## 3. Architecture

```
                            ┌──────────────────────────────┐
                            │   ea-sys-green (Next.js)     │
                            │   /app, /api/*, /admin/*     │
                            │   Port 3000 → nginx :443     │
                            │   - Stripe webhook handler   │
                            │   - All dashboard CRUD       │
                            │   - MCP HTTP transport       │
                            │   - AI agent execute         │
                            │   - Public registration      │
                            └──────────────┬───────────────┘
                                           │ shared @/lib/* via tsconfig paths
                                           │ shared Prisma client + types
                                           │ shared .env
                                           │
                            ┌──────────────▼───────────────┐
                            │   ea-sys-worker (NEW Node)   │
                            │   No HTTP routes; node-cron  │
                            │   Port 3099 → /health only   │
                            │   - cert-issue (30s)         │
                            │   - scheduled-emails (60s)   │
                            │   - webinar-recordings (5m)  │
                            │   - webinar-attendance (10m) │
                            │   - oauth-cleanup (1h)       │
                            │   pg_try_advisory_lock(jobId)│
                            │   SIGTERM → drain → exit     │
                            └──────────────────────────────┘

                            Both containers on the same
                            EC2 t3.large, talking to the
                            same Supabase Postgres.
```

### Why same repo, same package.json

The worker reads `prisma/schema.prisma`, imports `@/lib/db`, `@/lib/email`,
`@/lib/certificates/issue-worker`, `@/lib/webinar-*`, `@/lib/zoom/*` —
all of which already exist as well-factored libs. Sharing dependencies
through one `package.json` means:

- Prisma client is generated once, used by both
- TypeScript paths (`@/lib/*`) resolve in both with the same `tsconfig.json`
- npm version changes propagate atomically to both
- One `npm ci` in CI / Docker build
- The worker is **trivially revertible** — if it turns out to be a bad
  idea, delete the `worker/` folder + the second Docker service and
  we're back to the current `/api/cron/*` pattern with zero data loss

The cost: the worker pulls in npm dependencies it doesn't need
(React, Next.js itself, Tailwind, etc.). The Docker `Dockerfile.worker`
can use a smaller base image (`node:24-slim`, no Next-specific layers).
The deps don't load at runtime unless imported — Node's tree-shakes
at import-time, not at install-time. Real cost is disk space in the
image: ~200 MB more than a hand-rolled lean image. Acceptable.

### Why `node-cron`

5 periodic jobs at 30s-1h cadences. No need for:

- Priorities (every job is independent)
- Delayed jobs (job state is already in DB tables)
- Cross-machine queueing (single worker process, advisory-lock-guarded)
- Persistent schedules (process restart picks up the next tick from
  the wall-clock cadence — we don't care if a single tick is missed)

`node-cron` is the minimum-viable choice. Schedules read like:

```ts
import cron from "node-cron";
import { runCertIssueTick } from "@/lib/certificates/issue-worker";

cron.schedule("*/30 * * * * *", () => runCertIssueTick().catch(logErr));
```

If we ever need retries / priorities / Redis-backed durable queues,
that's a v2 conversation. Not today.

### Why Postgres advisory locks

The worker's singleton guarantee is enforced by Postgres, not by
process management. Each job tick wraps its work in:

```ts
async function withJobLock<T>(jobId: number, fn: () => Promise<T>) {
  const [{ locked }] = await db.$queryRaw<[{ locked: boolean }]>`
    SELECT pg_try_advisory_lock(${jobId}) AS locked
  `;
  if (!locked) {
    logger.debug({ jobId, msg: "skip-tick:locked-by-other-worker" });
    return null;
  }
  try {
    return await fn();
  } finally {
    await db.$queryRaw`SELECT pg_advisory_unlock(${jobId})`;
  }
}
```

This means:

- **Mumbai worker + Singapore DR worker can both be running** without
  double-processing — only one gets the lock per job per tick
- **Mumbai worker dying mid-tick releases the lock automatically** at
  connection close (Postgres advisory locks are session-scoped)
- **No state in shared memory** — the only durable state is in Postgres
  job tables (ScheduledEmail, CertificateIssueRunItem, ZoomMeeting)

Job IDs are hardcoded constants:

```ts
const JOB_IDS = {
  CERT_ISSUE: 1001,
  SCHEDULED_EMAILS: 1002,
  WEBINAR_RECORDINGS: 1003,
  WEBINAR_ATTENDANCE: 1004,
  OAUTH_CLEANUP: 1005,
} as const;
```

### Graceful shutdown

Docker sends SIGTERM, gives 30s, then SIGKILL. Our handler:

1. `cron.getTasks()` → stop all scheduled tasks (no new ticks)
2. Wait for any in-flight tick's promise to resolve (with a 25s timeout)
3. Release any held advisory locks
4. Close Prisma connection
5. Exit 0

If the in-flight tick is the cert renderer mid-batch, it finishes the
current item then bails — `runCertIssueTick` already has a loop guard
that checks a shouldStop flag.

### Health check

The worker exposes a tiny HTTP server on port 3099 with one endpoint:

```
GET /health → { ok: true, uptime: 1234, lastTickAt: { cert: "...", ... } }
```

Docker healthcheck hits this every 30s. If 3 consecutive checks fail,
the container restarts. Nginx does NOT proxy to this — it's internal-
only on `127.0.0.1:3099`.

---

## 4. File-by-file plan

### New files

```
worker/
├── index.ts                          # Entry point, scheduler bootstrap
├── jobs/
│   ├── cert-issue.ts                 # Thin shim → @/lib/certificates/issue-worker.runIssueTick
│   ├── scheduled-emails.ts           # Thin shim → @/lib/scheduled-emails-worker.runTick (extract from API route)
│   ├── webinar-recordings.ts         # Thin shim → @/lib/webinar-recording-sync.runTick
│   ├── webinar-attendance.ts         # Thin shim → @/lib/webinar-attendance.runTick (chains engagement)
│   └── oauth-cleanup.ts              # Thin shim → DB delete query
├── lib/
│   ├── advisory-lock.ts              # withJobLock(id, fn) helper
│   ├── job-ids.ts                    # Hardcoded JOB_IDS constants
│   ├── shutdown.ts                   # SIGTERM/SIGINT graceful shutdown
│   └── health-server.ts              # /health HTTP listener on :3099
├── tsconfig.json                     # Extends root tsconfig, includes worker/**
└── README.md                         # How to run locally + production
```

### Existing files to modify

| File | Change |
|---|---|
| `package.json` | Add `node-cron` dep. Add `worker:dev` and `worker:start` scripts |
| `tsconfig.json` | Include `worker/**` in compilation |
| `Dockerfile.worker` (NEW) | Multi-stage: builder copies + npm ci + npx prisma generate + tsx build; runner uses node:24-slim + copies built worker JS + runs `node worker/dist/index.js` |
| `docker-compose.yml` | New `ea-sys-worker` service: same env_file, depends on db, healthcheck on :3099/health |
| `scripts/deploy.sh` | Build worker image alongside web image. Restart worker container last (after web is healthy) |
| `src/lib/scheduled-emails-worker.ts` (NEW) | Extract the body of `/api/cron/scheduled-emails` route handler into a `runTick()` function. Route becomes a thin shim that calls `runTick()` (dual-write window) |
| `src/app/api/cron/scheduled-emails/route.ts` | Becomes thin shim — `await runTick(); return 200` |
| `src/app/api/cron/webinar-recordings/route.ts` | Same — thin shim |
| `src/app/api/cron/webinar-attendance/route.ts` | Same |
| `src/app/api/cron/mcp-oauth-cleanup/route.ts` | Same |

### Files to delete (after dual-write window)

- `src/app/api/cron/scheduled-emails/route.ts`
- `src/app/api/cron/webinar-recordings/route.ts`
- `src/app/api/cron/webinar-attendance/route.ts`
- `src/app/api/cron/mcp-oauth-cleanup/route.ts`
- Corresponding lines in Mumbai's crontab (we'll script the removal)

---

## 5. New npm dependencies

| Package | Why | Size |
|---|---|---|
| `node-cron` | The scheduler | ~70 KB |
| `tsx` (already a dev dep, just confirming) | Build the worker for production | n/a |

That's it. No Redis, no BullMQ, no agenda. Postgres advisory locks +
node-cron + existing Prisma client is the entire infra delta.

---

## 6. Per-job migration sketch

Each job follows the same shape. Example (cert-issue):

**Today** ([src/app/api/cron/scheduled-emails/route.ts](../src/app/api/cron/scheduled-emails/route.ts)):
```ts
// inside the route handler
await runCertIssueTick(); // among other work
```

**After extraction** (`src/lib/certificates/issue-worker.ts` unchanged):
```ts
export async function runCertIssueTick(): Promise<TickResult> { ... }
```

**New worker thin shim** (`worker/jobs/cert-issue.ts`):
```ts
import { runCertIssueTick } from "@/lib/certificates/issue-worker";
import { withJobLock } from "../lib/advisory-lock";
import { JOB_IDS } from "../lib/job-ids";
import { workerLogger } from "../lib/logger";

export async function tick() {
  return withJobLock(JOB_IDS.CERT_ISSUE, async () => {
    const start = Date.now();
    try {
      const result = await runCertIssueTick();
      workerLogger.info({
        job: "cert-issue",
        durationMs: Date.now() - start,
        ...result,
      });
    } catch (err) {
      workerLogger.error({ job: "cert-issue", err: String(err) });
      // Never re-throw from a tick — would crash the cron task and
      // miss future ticks. Catch + log + move on; the underlying
      // job state machine handles retries via its FAILED status.
    }
  });
}
```

**Schedule** (`worker/index.ts`):
```ts
import cron from "node-cron";
import * as certIssue from "./jobs/cert-issue";

cron.schedule("*/30 * * * * *", certIssue.tick); // every 30s
```

The Next.js `/api/cron/*` route shim during the dual-write window:
```ts
// route.ts becomes a thin wrapper
export async function POST(req: Request) {
  if (!authCron(req)) return new Response("Unauthorized", { status: 401 });
  await runCertIssueTick(); // SAME shared function
  return Response.json({ ok: true });
}
```

Both paths call the same `runCertIssueTick`. The advisory lock means
even if both fire on the same second, only one does work. No race
concerns during dual-write.

---

## 7. Docker + deploy

### `docker-compose.yml` additions

```yaml
services:
  ea-sys-green:
    # ... existing ...

  ea-sys-worker:
    image: ea-sys-worker:latest
    build:
      context: .
      dockerfile: Dockerfile.worker
    container_name: ea-sys-worker
    restart: unless-stopped
    env_file: .env
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3099/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    # Same network as ea-sys-green so it can reach Postgres via the
    # same connection string. No port published — health is internal.
```

### `Dockerfile.worker`

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-slim AS builder
WORKDIR /app
RUN apt-get update -y && apt-get install -y openssl
COPY package.json package-lock.json ./
COPY prisma ./prisma/
COPY scripts/copy-pdfjs-worker.mjs ./scripts/copy-pdfjs-worker.mjs
RUN npm ci
COPY tsconfig.json ./
COPY worker ./worker
COPY src/lib ./src/lib
COPY src/types ./src/types
RUN npx prisma generate
RUN npx tsc --project worker/tsconfig.json --outDir worker/dist

FROM node:24-slim AS runner
WORKDIR /app
RUN apt-get update -y && apt-get install -y openssl curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 worker
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/worker/dist ./worker
COPY --from=builder /app/src/lib ./src/lib
USER worker
ENV NODE_ENV=production
ENV PORT=3099
CMD ["node", "worker/index.js"]
```

### `scripts/deploy.sh` additions

The existing blue-green script handles `ea-sys-green` swap; we add a
parallel handling for the worker:

1. `docker compose build ea-sys-worker`
2. After web is healthy and traffic swapped, `docker compose up -d ea-sys-worker` (replaces the existing worker container — brief gap is fine since jobs are state-machine-safe + advisory-locked)
3. Verify worker `/health` returns 200 before declaring success

---

## 8. Migration sequencing (dual-write window)

### Phase 1 — Extract shared functions (~half day)

1. Move the body of each `/api/cron/*` route handler into a `runTick()` function in `src/lib/*-worker.ts`
2. Route handlers become thin shims calling the extracted function
3. Deploy. Existing crons + behavior unchanged.

**Verification**: `/admin/docs` viewer, logs, dashboard latency all unchanged.

### Phase 2 — Add the worker process (~1 day)

1. Add `node-cron` dep
2. Create `worker/` folder, `Dockerfile.worker`, docker-compose entry
3. `tsc --project worker/tsconfig.json` builds successfully
4. Local: `npm run worker:dev` runs the scheduler against local DB
5. Deploy worker container alongside existing setup
6. **Both paths now drain the same job queues** — but advisory locks mean no double-processing

**Verification**: `docker logs ea-sys-worker` shows tick logs at expected cadences. `/admin/docs` viewer shows healthy lastTickAt timestamps. Cert renders + email sends still flow (cron path + worker path both fire; lock serializes).

### Phase 3 — Watch for ~1 week

Live operation. Watch for:

- Any worker container restart that doesn't recover cleanly
- Any race the advisory lock doesn't cover
- Any job that fires only via cron route and never via worker (would indicate a wiring bug)
- Dashboard latency under cron-tick bursts (should improve)

### Phase 4 — Cut over (~30 min)

1. ✅ **Done 2026-06-09** — SSM into Mumbai: `crontab -e` → the 5 cron lines that hit `/api/cron/*` are commented out (not deleted, for instant rollback; backup at `/home/ubuntu/crontab.backup.2026-06-09.txt`). Worker is the sole runner from this point.
2. Commit the route deletions + remove the `CRON_SECRET` check from the bottom of those handlers (or just delete them entirely) — **still pending**
3. Deploy. Worker is now the only path.

**Verification**: worker logs show ticks at expected cadences for 24 hours.

---

## 9. Open items / deferrals

| Item | Why deferred | Re-eval trigger |
|---|---|---|
| Admin UI for worker status (`/admin/workers` tab) | The lastTickAt info is already in Postgres via the existing job tables. A dedicated UI is nice-to-have, not required. | When an operator complains they can't tell if the worker is running |
| Retry policies per-job (exponential backoff, max attempts) | Current state machines have their own retry semantics (FAILED + retry-failed endpoint). Adding a queue-level retry adds coordination cost. | When an org-level outage causes durable failure modes the current state machines don't recover from |
| Multiple worker instances (horizontal scaling) | Advisory locks already support this. But: 5 jobs at our cadences fit comfortably in one process. | When a single worker's CPU exceeds 50% sustained |
| BullMQ + Redis migration | Adds infra dependency. Not needed at our scale. | When job throughput exceeds 100/min OR cross-machine queueing matters |
| Worker metrics dashboard (Prometheus / CloudWatch custom metrics) | Existing logs are searchable in `/admin/logs`. Metrics would help with anomaly detection. | When debugging cron behavior becomes log-grep heavy |
| Health endpoint exposes per-job lastTickAt | v1 just returns `{ ok: true }`. Adding per-job data is small but not required for Docker healthcheck. | When ops wants at-a-glance visibility from `curl localhost:3099/health` |
| Separating worker into its own npm workspace | Cleaner long-term boundary; not worth the one-time churn now. | When the worker's dependency surface meaningfully diverges from the web app's |

---

## 10. Execution checklist

In order. Each step independently verifiable.

- [ ] **10.1** Extract `runTick()` functions from each `/api/cron/*` route handler into `src/lib/*-worker.ts` (or co-located with existing helpers). Routes become thin shims. Deploy. Verify all existing behavior unchanged.
- [ ] **10.2** `npm install node-cron`. Bump `package.json` version.
- [ ] **10.3** Create `worker/tsconfig.json` extending root `tsconfig.json`, with `outDir: worker/dist` and `include: [worker/**]`. Verify `npx tsc --project worker/tsconfig.json --noEmit` passes (no files yet).
- [ ] **10.4** Write `worker/lib/advisory-lock.ts`, `worker/lib/job-ids.ts`, `worker/lib/shutdown.ts`, `worker/lib/health-server.ts`.
- [ ] **10.5** Write the 5 `worker/jobs/*.ts` shims, each calling its corresponding `runTick()`.
- [ ] **10.6** Write `worker/index.ts` — bootstrap, register cron schedules, start health server, wire shutdown.
- [ ] **10.7** Write `Dockerfile.worker` (multi-stage build).
- [ ] **10.8** Add `ea-sys-worker` service to `docker-compose.yml`.
- [ ] **10.9** Add `worker:dev` (tsx) and `worker:start` (node) scripts to `package.json`.
- [ ] **10.10** Run locally: `npm run worker:dev`. Verify ticks fire, advisory locks work, jobs drain expected state machines.
- [ ] **10.11** Update `scripts/deploy.sh` to build + restart the worker container after web is healthy.
- [ ] **10.12** Deploy. Both paths run for ~1 week.
- [ ] **10.13** Watch logs. Confirm worker ticks fire at expected cadences AND `/admin/docs` viewer shows healthy lastTickAt.
- [ ] **10.14** Cut over: remove cron lines from Mumbai crontab. Commit deletion of `/api/cron/*` route handlers. Deploy. Worker is the only path.
- [ ] **10.15** Update `CLAUDE.md` "Recent Features" with the worker migration. Update `docs/HANDOVER.md` §12 (Deployment) to document the worker.
- [ ] **10.16** Save memory `reference_worker_architecture.md` so future sessions know the worker exists.

Estimated total effort: **~2-3 days** (mostly the extraction + verification, not the build).

---

## 11. Rollback plan

If the worker turns out to be broken in production and we need to
revert during the dual-write window:

1. `docker compose stop ea-sys-worker` — kills the worker immediately
2. Existing `/api/cron/*` routes + Mumbai crontab continue to drain
   jobs (since they're dual-writing during this phase)
3. Open a follow-up commit to debug worker, redeploy when fixed

If we need to revert AFTER the cut-over (Phase 4):

1. Re-add cron lines to Mumbai crontab (template in this doc + git history)
2. Revert the route-deletion commit
3. Deploy
4. Worker continues to run alongside (advisory lock means no double-processing)
5. Debug worker without time pressure, fix, re-cut over

In either case: **no data loss** because all job state lives in
Postgres tables that both paths read/write.

---

## 12. Cost estimate

| Item | Impact |
|---|---|
| Disk space on EC2 (additional Docker image) | ~+200 MB |
| RAM at idle | ~+50-100 MB |
| RAM under load (cert render burst) | ~+200-400 MB |
| CPU at idle | ~+1% |
| CPU under load | spikes contained inside worker; dashboard latency UNAFFECTED |
| EC2 bill | $0 incremental (t3.large has massive headroom — currently <5% RAM used) |
| Image build time | +~2 min in CI |
| Operational complexity | One more container to monitor + restart |

Real cost is operational: one more thing to think about. The
isolation benefit (dashboard latency stops being affected by cert
renders) is well worth it.

---

## 13. Cross-references

- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — services-layer convention
  the worker shims align with
- [infra/dr/POSTGRES_BACKUP_PLAN.md](../infra/dr/POSTGRES_BACKUP_PLAN.md) —
  design-doc convention this follows
- [docs/HANDOVER.md](HANDOVER.md) §12 — will need updating post-cut-over
- [CLAUDE.md](../CLAUDE.md) "Recent Features" — entry to add after deploy
- Memory file [feedback_always_log_failures.md](../../../.claude/projects/-Users-krishnapallapolu-Downloads-upcoming-ea-sys/memory/feedback_always_log_failures.md) — every tick logs success/failure; never silent

---

## 14. Sign-off

Plan accepted by Krishna 2026-06-03. Implementation can begin against
the §10 checklist when scheduled.

---

## 15. Implementation log (live updates)

Tracked here so the plan doc doubles as the historical record. Each
entry references the commit hash for git-bisect later.

### Phase 1 — `dcadc44` (2026-06-04)

Extracted the bodies of 4 `/api/cron/*` route handlers into shared
`runTick()` functions under `src/lib/`. The route handlers became
thin shims (auth + delegate). Behavior unchanged; this is the
single-source-of-truth seam both the route AND the worker will
call.

- `src/lib/scheduled-emails-worker.ts` ← was in route handler
- `src/lib/webinar-recordings-worker.ts` ← was in route handler
- `src/lib/webinar-attendance-worker.ts` ← was in route handler
- `src/lib/mcp-oauth-cleanup-worker.ts` ← was in route handler
- `src/lib/certificates/issue-worker.ts` already had `tickAllRuns()` —
  no work needed; the route was already a shim

Verified: tsc + lint + 1357/1357 vitest + build clean.

### Phase 2 — `0350592` (2026-06-04)

Built the Node worker process. 15 new files (+1101 LOC).

- `worker/index.ts` — node-cron scheduler bootstrap, health server,
  shutdown handler installation
- `worker/jobs/*.ts` × 5 — ~20-line shims wrapping each `runTick()` in
  `withJobLock(jobId, name, fn)` + try/catch
- `worker/lib/job-ids.ts` — numeric advisory-lock IDs (1001-1005)
- `worker/lib/advisory-lock.ts` — `pg_try_advisory_lock` wrapper
- `worker/lib/health-server.ts` — `GET /health` on port 3099
- `worker/lib/shutdown.ts` — SIGTERM/SIGINT graceful drain (25s
  timeout, then exit; Docker has 30s before SIGKILL)
- `Dockerfile.worker` — multi-stage, `node:24-slim` base, runs
  `npx tsx worker/index.ts`
- `docker-compose.prod.yml` — new `ea-sys-worker` service alongside
  blue/green/mediamtx
- `worker/README.md` — operator-facing quick reference
- `package.json` — added `node-cron`, moved `tsx` to deps for runtime,
  added `worker:dev` + `worker:start` scripts

Smoke-tested locally end-to-end: `npx tsx worker/index.ts` boots,
registers all 5 schedules, health server responds, SIGTERM triggers
graceful shutdown. Verified: tsc + lint + 1357/1357 vitest + build
clean.

### Phase 2.5 — `8672b4f` (2026-06-04)

Added public-facing health endpoints alongside the existing
`/api/health`:

- `src/app/health/route.ts` → `/health` — shorter URL alias for
  `/api/health` (re-exports the same GET handler)
- `src/app/worker/health/route.ts` → `/worker/health` — Next.js-side
  proxy to the worker container's internal `:3099/health` via Docker
  DNS (`ea-sys-worker:3099`). The worker container does NOT publish
  3099 externally; this proxy is the only public surface for worker
  state. 503 on unreachable/timeout/shutting-down. 2s timeout
  ceiling.
- `WORKER_HEALTH_URL` env override for local dev when not running in
  Docker (default: `http://ea-sys-worker:3099/health`).
- `worker/README.md` updated:
  - Healthcheck section now lists 3 ways (public proxy, docker exec,
    docker inspect) in order of operator convenience
  - Logs section corrects the dashboard link (`/logs`, not
    `/admin/docs`) and adds the `worker:` grep filter for searching
    among mixed web+worker output

### Phase 3 — in progress (started 2026-06-04)

Watch window. Both legacy `/api/cron/*` routes AND the worker drain
the same job queues; advisory locks (worker/lib/advisory-lock.ts)
serialize them. What "healthy" looks like:

- `/logs?search=worker:tick-end` shows entries at the expected
  cadences (every 1 min for cert-issue + scheduled-emails, every 5
  min for webinar-recordings, every 10 min for webinar-attendance,
  every hour at :00 for oauth-cleanup)
- `/logs?search=worker:skip-tick-locked` shows occasional entries
  (the legacy cron path beat the worker to the lock once in a while)
- `/worker/health` returns 200 with `lastTickAt` timestamps updating
  per cadence
- Dashboard request latency unchanged from before (cert renders no
  longer compete with web responses)
- No `worker:tick-uncaught` or `worker:uncaught-exception` keys (or
  if any, investigate before Phase 4)

### Phase 4 — planned ~2026-06-11

After ~1 week of clean dual-write operation, cut over: remove the 5
cron lines from Mumbai's crontab, delete the thin-shim route
handlers in `src/app/api/cron/`, deploy. Worker is the only path.
Rollback procedure documented in §11.
