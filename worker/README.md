# `worker/` — EA-SYS background-jobs service

Long-running Node process that runs every cron-driven job on a
`node-cron` scheduler, separate from the Next.js web container.

See [`docs/WORKER_EXTRACTION_PLAN.md`](../docs/WORKER_EXTRACTION_PLAN.md)
for the full architecture, decisions locked, and 4-phase migration plan.
This README is the operator-side quick-reference.

---

## What it does

Fifteen jobs, one process. **Keep this table in sync with
`src/lib/worker-jobs.ts`** — a drift test
(`__tests__/lib/worker-jobs-drift.test.ts`) enforces the roster there, but
nothing enforces this table, so it is the one that rots.

| Job | Schedule | Lock ID | Source of truth |
|---|---|---|---|
| `cert-issue` | `*/3 * * * *` (every 3 min) | 1001 | `src/lib/certificates/issue-worker.ts` → `tickAllRuns` |
| `scheduled-emails` | `* * * * *` (every minute) | 1002 | `src/lib/scheduled-emails-worker.ts` → `runScheduledEmailsTick` |
| `webinar-recordings` | `*/5 * * * *` (every 5 min) | 1003 | `src/lib/webinar-recordings-worker.ts` → `runWebinarRecordingsTick` |
| `webinar-attendance` | `*/10 * * * *` (every 10 min) | 1004 | `src/lib/webinar-attendance-worker.ts` → `runWebinarAttendanceTick` |
| `oauth-cleanup` | `0 * * * *` (hourly at :00) | 1005 | `src/lib/mcp-oauth-cleanup-worker.ts` → `runMcpOAuthCleanupTick` |
| `invoice-reconciliation` | `*/10 * * * *` (every 10 min) | 1006 | `src/lib/invoice-reconciliation-worker.ts` → `runInvoiceReconciliationTick` |
| `contacts-central-sync` | `16,53 * * * *` (~every 37 min) | 1007 | `src/lib/contacts-central-sync.ts` → `runContactsCentralTick` |
| `contacts-central-reconcile` | `24 2 * * *` (daily 02:24 UTC) | 1008 | `src/lib/contacts-central-sync.ts` → `runContactsCentralReconcile` |
| `log-archive` | `30 3 1 * *` (monthly, 1st 03:30) | 1009 | `src/lib/log-archive.ts` → `runLogArchiveTick` |
| `crm-reminders` | `*/5 * * * *` (every 5 min) | 1010 | `src/crm/reminders-worker.ts` → `runTick` |
| `email-log-prune` | `45 3 * * *` (daily 03:45 UTC) | 1011 | `src/lib/email-log-prune-worker.ts` → `runEmailLogPruneTick` |
| `crm-inbound-email` | `* * * * *` (every minute) | 1012 | `src/crm/inbound-email-worker.ts` → `runTick` |
| `login-event-prune` | `15 4 * * *` (daily 04:15 UTC) | 1013 | `src/lib/login-event-prune-worker.ts` → `runLoginEventPruneTick` |
| `system-log-prune` | `45 4 * * *` (daily 04:45 UTC) | 1014 | `src/lib/system-log-prune-worker.ts` → `runSystemLogPruneTick` |
| `daily-digest` | `30 5 * * *` (daily 05:30 UTC) | 1015 | `src/lib/daily-digest-worker.ts` → `runDailyDigestTick` |

> The three retention sweeps + the digest are deliberately staggered
> (03:45 → 04:15 → 04:45 → 05:30) so they neither contend for the same DB
> window nor let the digest report mid-prune numbers.

> `daily-digest` is the only job whose output is a **human** rather than a state
> change: one infrastructure-health email per day to `ALERT_EMAIL_TO`, sent
> whether or not anything happened — so its silence is a signal rather than
> reassurance. The verdict is computed by `assessInfra()`; the AI only writes
> prose on top and cannot change it, and a model outage degrades the email to
> numbers-only rather than losing it. See §1.7 C of
> [docs/AWS_OPERATIONS.md](../docs/AWS_OPERATIONS.md).

### If the worker breaks

**A crash self-heals; a freeze does not.** `restart: unless-stopped` fires when
the process *exits* — but a wedged event loop or an exhausted DB pool leaves the
container `Up` and useless. Docker's healthcheck detects that and flips the label
to `unhealthy`; plain Compose then does nothing about it (only Swarm acts on
health). [`scripts/worker-watchdog.sh`](../scripts/worker-watchdog.sh) is the
missing action layer — cron `*/2`, restarts after 3 consecutive unhealthy checks,
capped at 3 restarts/hour, emails on every restart. Details + install line in
§1.7 D of [docs/AWS_OPERATIONS.md](../docs/AWS_OPERATIONS.md).

**Nothing is lost while it is down.** Every job is a poller over durable state,
not an alarm clock: `scheduled-emails` asks "any PENDING row whose time has
passed?" oldest-first, `webinar-attendance` picks up never-synced rows
*regardless of age*, the prune jobs simply sweep more next run. `node-cron` does
**not** replay missed ticks, and that is correct — replaying them would duplicate
work or be a long series of no-ops. The real consequence is that mail arrives
**late in a clump**, never not at all.

**On recovery there is no stampede**, because every job drains a fixed batch per
tick (`scheduled-emails` 10 rows/min, `cert-issue` 50 renders + 25 emails,
`invoice-reconciliation` 25) — a backlog leaves at a constant rate. The genuine
contention risk is not recovery but **coincident tick boundaries** sharing one
10-connection DB pool; that is what caused the June 2026 `P2024` incident, and
why `cert-issue` runs `*/3` and the retention sweeps are staggered. Stagger any
new job onto an odd offset rather than a round `*/5`.

### Why a lease and not a lock — the bug that hid for months

Until 2026-08-10 each job took a Postgres advisory lock. Advisory locks are
**session-scoped**: the connection that TAKES the lock must be the one that
RELEASES it. Prisma hands out whichever pooled connection is free, so the
release routinely ran on a connection that had never held the lock — it silently
did nothing, the original connection sat on the lock while idle, and every
subsequent tick found the job "already running" and skipped.

Measured on prod over 24h before the fix:

| Job | Expected | Actual |
|---|---|---|
| `scheduled-emails` | 1,440 | **435** |
| `crm-inbound-email` | 1,440 | **375** |
| `cert-issue` | 480 | **182** |
| `oauth-cleanup` (hourly) | 24 | 24 ✓ |

The shortfall scaled with frequency, because frequent jobs mean a busy pool.
Emails still went out — 5 to 17 minutes late instead of 90 seconds. Nothing was
ever lost.

**It hid because every health surface asked the wrong question** — *"did the
last run succeed?"*, to which the answer was always yes. Three guards now exist:

1. The skip logs at `warn` (was `debug`, which reached neither `/logs` nor
   CloudWatch nor the digest).
2. The daily digest compares each job's 24h count against `expectedPerDay` in
   [src/lib/worker-jobs.ts](../src/lib/worker-jobs.ts) and warns below 80%.
3. `worker:lease-lost-mid-tick` logs at **error** if a lease ever expires while
   its tick is still running.

**A lease is structurally immune.** Claiming is one statement
(`INSERT … ON CONFLICT DO UPDATE … WHERE` free-or-expired), so it is atomic
wherever it runs and "which connection" stops being able to affect correctness.
Pinned by real-Postgres tests in
[tests/crm-db/job-lease.db.test.ts](../tests/crm-db/job-lease.db.test.ts),
including the connection-split case the old lock failed — a mocked Prisma has
one fake connection, so that bug was not even *expressible* in the unit suite,
which is exactly why it survived a year of green tests.

> This also retires the old precondition on running a **second** worker: leases
> make a DR-failover worker safe, where advisory locks risked duplicate emails
> and certificates.

#### The worker still uses DIRECT_URL — but no longer needs to

`docker-compose.prod.yml` overrides `DATABASE_URL` for this service to the
session-mode `DIRECT_URL` (:5432). That override was the *first* attempt at the
bug above; it narrowed the leak but did not close it, because the split happens
inside Prisma's own pool, below the pooler.

It is kept because session mode is the right shape for a long-lived process
holding a handful of connections, and `assertSessionModeConnection()` in
[index.ts](index.ts) warns at boot if it is ever lost. But it is **no longer
load-bearing for correctness** — if direct connections ever become scarce on the
database plan, moving the worker back to the pooler is now safe.

> `invoice-reconciliation` (audit Round 2, DATA-5) recovers post-payment
> invoices the Stripe webhook failed to create — it sweeps for PAID
> registrations that have a PAID `Payment` but no `INVOICE` row and re-runs the
> webhook's `createPaidInvoice` + `sendInvoiceEmail` path. Idempotent, bounded
> (25/tick, 14-day look-back), per-row failure isolated.

> `contacts-central-sync` / `contacts-central-reconcile` mirror EA-SYS contacts
> into an external Supabase table. **Both no-op unless `CONTACTS_CENTRAL_ENABLED=true`**
> + URL/key are set. The incremental job pushes contacts changed in the last
> 45 min (~37-min cadence); the reconcile does a nightly full push (self-healing).
> See [docs/CONTACTS_CENTRAL_SYNC.md](../docs/CONTACTS_CENTRAL_SYNC.md).

Each job runs under a **lease** (`worker/lib/job-lease.ts`) — a row in
`JobLease` claimed for a bounded time and renewed by a heartbeat while the tick
runs. That stops a job running twice at once, whether the second runner is
another worker process or, far more commonly, the job's OWN next tick arriving
before the current one has finished.

A lease rather than a lock because a lock has to be released by the same
database connection that took it, and Prisma's pool cannot promise that — see
the section below. A lease is claimed in one atomic statement, so which
connection runs it stops mattering, and an abandoned lease **expires by itself**
instead of wedging the job.

---

## File layout

```
worker/
├── index.ts                   # Entry point — bootstraps the scheduler
├── jobs/
│   ├── cert-issue.ts          # Thin shim → tickAllRuns
│   ├── scheduled-emails.ts    # → runScheduledEmailsTick
│   ├── webinar-recordings.ts  # → runWebinarRecordingsTick
│   ├── webinar-attendance.ts  # → runWebinarAttendanceTick
│   ├── oauth-cleanup.ts       # → runMcpOAuthCleanupTick
│   ├── invoice-reconciliation.ts # → runInvoiceReconciliationTick
│   ├── contacts-central-sync.ts  # → runContactsCentralTick (incremental)
│   └── contacts-central-reconcile.ts # → runContactsCentralReconcile (nightly)
├── lib/
│   ├── job-ids.ts             # Stable numeric job ids (log correlation)
│   ├── job-lease.ts           # withJobLock(id, name, fn) — claim/heartbeat/release
│   ├── health-server.ts       # GET /health on :3099
│   └── shutdown.ts            # SIGTERM/SIGINT graceful drain
└── README.md                  # this file
```

The `src/lib/*-worker.ts` files contain the actual logic; the
`worker/jobs/*.ts` files are 20-line shims that wire the cadence +
lock around them.

---

## Local development

```bash
# Same .env as the web app — DATABASE_URL etc.
npm run worker:dev
```

This runs `tsx watch worker/index.ts` — auto-restart on file changes.
Connects to whichever Postgres your `.env` points at (Supabase
production, in EA-SYS's case).

Expect log output:

```
{"level":30,"msg":"worker:health-listening","port":3099}
{"level":30,"msg":"worker:started","jobs":5,"healthPort":3099,"schedules":{...}}
{"level":20,"msg":"worker:tick-start","job":"scheduled-emails"}
{"level":20,"msg":"worker:tick-end","job":"scheduled-emails","durationMs":42}
...
```

If you ALSO have `npm run dev` running, any legacy `/api/cron/*`
route you still trigger shares the same `JobLease` rows — so running
both is safe: whichever claims the lease does the work and the other
skips.

### Health endpoint

```bash
curl http://localhost:3099/health
```

```json
{
  "ok": true,
  "uptimeSeconds": 1234,
  "lastTickAt": {
    "cert-issue": "2026-06-04T09:48:00.123Z",
    "scheduled-emails": "2026-06-04T09:48:00.456Z",
    "webinar-recordings": "2026-06-04T09:45:00.789Z",
    "webinar-attendance": "2026-06-04T09:40:00.000Z",
    "oauth-cleanup": "2026-06-04T09:00:00.000Z"
  },
  "shuttingDown": false
}
```

A `lastTickAt` value of `null` means the schedule hasn't fired since
boot — expected during the first minute of cert-issue/scheduled-emails
or the first 5/10/60 min of the others. A stale value (older than
2× the cadence) usually means either a stuck tick or another worker
is holding the lock.

---

## Production deploy

The worker runs as a sibling container to `ea-sys-blue`/`green` in
`docker-compose.prod.yml` on the same EC2 box. Built from
`Dockerfile.worker`. Same `.env`, same `public/uploads` mount, same
`logs` mount, same `web` network.

```bash
# On Mumbai box:
cd /home/ubuntu/ea-sys
bash scripts/deploy.sh
```

The deploy script's blue-green flow handles the web container swap;
the worker is rebuilt + restarted alongside. A brief gap between
worker stop + new container start is fine because:
- Job state lives in Postgres tables (`ScheduledEmail`,
  `CertificateIssueRunItem`, `ZoomMeeting`)
- Cron cadences are idempotent — a missed tick is recovered on the
  next interval
- Advisory locks are session-scoped — a crashing worker releases its
  lock automatically at connection close

### Healthcheck

Three ways to inspect, in increasing convenience:

1. **Public Next.js proxy** (no SSH required):
   ```
   https://events.meetingmindsgroup.com/worker/health
   ```
   The Next.js container proxies through to the worker container
   via Docker DNS (`ea-sys-worker:3099`). Same JSON shape as the
   raw `/health` endpoint; 503 when worker is unreachable or
   shutting down. Sister endpoint `/health` covers the web tier.

2. **`docker exec` inside the box** (good for first-line debugging):
   ```bash
   docker exec ea-sys-worker curl -fs http://localhost:3099/health
   ```

3. **Docker's own healthcheck**:
   `docker-compose.prod.yml` polls `localhost:3099/health` inside
   the container every 30s. After 3 consecutive failures the
   container restarts. Last status visible via:
   ```bash
   docker inspect --format '{{.State.Health.Status}}' ea-sys-worker
   ```

### Logs

Three views, all from the same Pino stream:

1. **In-dashboard log viewer** (no SSH required) — open
   [`/logs`](https://events.meetingmindsgroup.com/logs) with a
   SUPER_ADMIN session. Pick `source=database`, then search for
   `worker:` to see only worker output. The worker writes through
   the same Pino logger as the web app, so its SystemLog DB rows
   appear alongside the dashboard's logs — no separate viewer.

2. **`docker logs`** (SSH):
   ```bash
   docker logs ea-sys-worker --since 10m --tail 100
   # Only worker keys:
   docker logs ea-sys-worker --since 1h | grep '"msg":"worker:'
   ```

3. **File logs** on the host (SSH; backup if DB or stdout is
   unavailable):
   ```bash
   tail -f /home/ubuntu/ea-sys/logs/app.log
   # Filter to worker only:
   tail -f /home/ubuntu/ea-sys/logs/app.log | grep '"msg":"worker:'
   ```
   Note: the worker and web containers both mount the same host
   `./logs` directory, so this file is interleaved with web output.
   The `worker:` prefix is your filter.

Search for `msg:"worker:"` to see only worker output:

```bash
docker logs ea-sys-worker --since 1h | grep '"msg":"worker:'
```

Useful keys:

| Key | Meaning |
|---|---|
| `worker:started` | Boot — schedules registered, health server up |
| `worker:tick-start` | A job's tick is about to run (debug-level) |
| `worker:tick-end` | A tick settled; `durationMs` is the wall-clock cost |
| `worker:skip-tick-leased` | The lease was already held — usually this job's OWN previous tick still running. Politely skipped. **Warn-level** (was `debug` until Aug 2026, which is how a 70% skip rate hid for months) |
| `worker:lease-claim-transient-skip` | A retryable DB connection-closed (e.g. Supabase `EDBHANDLEREXITED`) hit the claim; treated like contention — tick skipped, retries next cycle. **Warn-level — does NOT page** |
| `worker:lease-lost-mid-tick` | The lease expired while the tick was STILL running and someone else took it — two ticks may now overlap. **Error-level: raise `LEASE_TTL_MS` or find out why the tick outran its heartbeat** |
| `worker:tick-uncaught` | Exception escaped the job's own try/catch |
| `worker:tick-wrapper-uncaught` | Exception escaped EVEN the wrapper's catch (rare) |
| `worker:shutdown-start` | SIGTERM received; draining begins |
| `worker:shutdown-drain-result` | `"drained"` (graceful) or `"timeout"` (forced) |
| `worker:lease-release-failed` | Could not hand the lease back; self-correcting — it expires at `LEASE_TTL_MS` and the job resumes |
| `worker:lease-renew-failed` | A heartbeat did not land; harmless unless repeated (the lease would then expire mid-tick) |
| `worker:uncaught-exception` | Process-level — restart will follow |

---

## Cutover plan (Phase 4)

> **Status (2026-06-09):** the operational half is DONE early — the 5
> `/api/cron/*` crontab lines on Mumbai are **commented out** (backed up
> to `/home/ubuntu/crontab.backup.2026-06-09.txt`; the 3 DR backup lines
> are untouched), so the worker is already the **sole runner**. The route
> shims are still in code (step 3 below) as the rollback handle — to
> revert, re-enable the crontab lines. Code deletion still pending.

1. Confirm via `/admin/logs` viewer that worker ticks fire at expected
   cadences (search for `worker:tick-end` keys; counts should match
   the legacy `scheduled-emails:tick-complete` / etc. counts)
2. ✅ On Mumbai box: comment/remove the 5 lines that hit `/api/cron/*`
   (done 2026-06-09 — commented, not deleted, for instant rollback)
3. Commit the deletion of the 4 thin-shim route handlers AND the
   `scheduled-emails` route's leftover wiring
4. Deploy. Worker is now the only path.

Rollback: see `docs/WORKER_EXTRACTION_PLAN.md` §11 — both paths
support being re-enabled within minutes, with no data loss because
job state lives in Postgres.

---

## Adding a new job

1. Write the worker logic as a plain `async function runMyJobTick():
   Promise<Report>` in `src/lib/my-job-worker.ts` (no HTTP envelope)
2. Add a numeric ID to `worker/lib/job-ids.ts` (next free in the
   1000-1099 range)
3. Create `worker/jobs/my-job.ts` mirroring the existing shims
4. Register the schedule in `worker/index.ts` — one line in the
   `tasks` array, one entry in the initial `state.lastTickAt` map
5. If you want the legacy HTTP route for dual-write parity, add
   `/api/cron/my-job/route.ts` as a thin shim around the same
   `runMyJobTick`

Each of those steps is small (~10-15 LOC). The shape is uniform.
