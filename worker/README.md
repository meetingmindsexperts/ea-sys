# `worker/` — EA-SYS background-jobs service

Long-running Node process that runs the 5 cron-driven jobs on a
`node-cron` scheduler, separate from the Next.js web container.

See [`docs/WORKER_EXTRACTION_PLAN.md`](../docs/WORKER_EXTRACTION_PLAN.md)
for the full architecture, decisions locked, and 4-phase migration plan.
This README is the operator-side quick-reference.

---

## What it does

Five jobs, one process:

| Job | Schedule | Lock ID | Source of truth |
|---|---|---|---|
| `cert-issue` | `* * * * *` (every minute) | 1001 | `src/lib/certificates/issue-worker.ts` → `tickAllRuns` |
| `scheduled-emails` | `* * * * *` (every minute) | 1002 | `src/lib/scheduled-emails-worker.ts` → `runScheduledEmailsTick` |
| `webinar-recordings` | `*/5 * * * *` (every 5 min) | 1003 | `src/lib/webinar-recordings-worker.ts` → `runWebinarRecordingsTick` |
| `webinar-attendance` | `*/10 * * * *` (every 10 min) | 1004 | `src/lib/webinar-attendance-worker.ts` → `runWebinarAttendanceTick` |
| `oauth-cleanup` | `0 * * * *` (hourly at :00) | 1005 | `src/lib/mcp-oauth-cleanup-worker.ts` → `runMcpOAuthCleanupTick` |

Each job is wrapped in a Postgres advisory lock
(`worker/lib/advisory-lock.ts`) — multiple worker processes can run
without double-processing. The lock is session-scoped, so a crashed
worker releases its locks automatically at connection close.

The same `runTick()` functions are ALSO callable from the legacy
`/api/cron/*` routes (extracted in Phase 1). During the dual-write
window (Phase 2-3), both paths fire; the lock ensures only one path
does work per tick.

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
│   └── oauth-cleanup.ts       # → runMcpOAuthCleanupTick
├── lib/
│   ├── job-ids.ts             # Numeric advisory-lock IDs
│   ├── advisory-lock.ts       # withJobLock(id, name, fn) helper
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

If you ALSO have `npm run dev` running, the legacy `/api/cron/*`
routes will keep firing via whatever cron you have. Both paths
share the advisory lock — running both is safe and is the
explicit dual-write configuration described in
`docs/WORKER_EXTRACTION_PLAN.md` Phase 2-3.

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

`docker-compose.prod.yml` configures Docker to hit
`http://localhost:3099/health` every 30s inside the container. After
3 consecutive failures the container restarts. The endpoint is NOT
proxied through nginx — operators inspect via:

```bash
docker exec ea-sys-worker curl -fs http://localhost:3099/health
```

### Logs

```bash
docker logs ea-sys-worker --since 10m --tail 100
```

OR via the `/admin/docs` viewer's logs panel — the worker writes
through the same Pino logger as the web app, so SystemLog DB rows
show up alongside the dashboard's logs.

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
| `worker:skip-tick-locked` | Another worker held the advisory lock; we politely skipped |
| `worker:tick-uncaught` | Exception escaped the job's own try/catch |
| `worker:tick-wrapper-uncaught` | Exception escaped EVEN the wrapper's catch (rare) |
| `worker:shutdown-start` | SIGTERM received; draining begins |
| `worker:shutdown-drain-result` | `"drained"` (graceful) or `"timeout"` (forced) |
| `worker:advisory-unlock-failed` | Postgres connection died before unlock; session-close cleanup will release |
| `worker:uncaught-exception` | Process-level — restart will follow |

---

## Cutover plan (Phase 4)

After ~1 week of clean dual-write operation:

1. Confirm via `/admin/logs` viewer that worker ticks fire at expected
   cadences (search for `worker:tick-end` keys; counts should match
   the legacy `scheduled-emails:tick-complete` / etc. counts)
2. On Mumbai box: `crontab -e` → remove the 5 lines that hit
   `/api/cron/*`
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
