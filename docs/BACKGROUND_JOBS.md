# Background jobs — how work actually gets done

The canonical answer to *"I clicked send, why hasn't it arrived?"*, *"what runs
on a schedule?"*, and *"what happens if the worker dies?"*.

- **Operator-facing version:** [user-guide §19](../public/user-guide.html) —
  written for organizers, and what the in-app Help Assistant answers from.
- **Developer reference:** [worker/README.md](../worker/README.md) — the job
  table, file layout, how to add a job.
- **Ops / incident reference:** [AWS_OPERATIONS.md §1.7](AWS_OPERATIONS.md) —
  monitoring, the watchdog, diagnosing a stuck job.
- **Why the tier exists at all:** [WORKER_EXTRACTION_PLAN.md](WORKER_EXTRACTION_PLAN.md).

---

## 1. Two ways an email leaves the system

This distinction explains almost every "why is it slow" question, and the two
paths have nothing in common.

### Immediate — sent inside the click

A speaker invitation, a registration confirmation, a password reset, a payment
receipt, an abstract decision. One recipient, one action, sent by the web
container during the request. **Latency: seconds. The worker is not involved.**

### Queued — handed to the worker

Anything to *many* recipients: bulk sends, the certificate fan-out, webinar
sequences, scheduled campaigns. The web container writes a `ScheduledEmail` row
and returns `202 Accepted` with a job id; the `scheduled-emails` job picks it up
and sends in batches of 25.

**This was deliberate (June 2026).** Sending 2,000 emails — each possibly with a
generated PDF — inside one HTTP request times out, and a timeout mid-send leaves
nobody able to say who received what. Handing off makes the send resumable and
the request instant.

> **Consequence to state plainly:** "Send now" means *"queued, sending starts
> within about 90 seconds"*, not *"sent"*. The poll is every 60s, so the honest
> promise is a full poll interval plus the send — quoting 60s flat is a number
> the system cannot meet. If that delay ever matters operationally, the fix is
> §5's wake-up call, not a faster poll.

### What happens if a tick runs long?

A common and reasonable worry: the 09:41 tick is still sending at 09:42 — do
they overlap and double-send?

**No.** The 09:42 tick tries to take the job's lock, finds 09:41 still holding
it, and skips immediately. The lock is not only about multiple workers; it
equally stops a slow tick colliding with its own next tick. A tick that takes
four minutes simply means three skipped ticks, then normal service — and because
of §2, whatever was due in those minutes is still waiting and goes out next tick.

The caveat is in §4: a long tick is exactly when the connection pool is busiest,
which is when a lock is most likely to leak.

---

## 2. The jobs are pollers, not alarm clocks

Every job asks the database a question on a fixed cadence:

> `scheduled-emails` — *"is there a PENDING row whose time has passed?"* (oldest first)

It is **not** "at 09:00, send Bob's email". That difference is why the system
tolerates downtime gracefully:

| | Alarm clock | Poller (what we do) |
|---|---|---|
| Missed while down | Lost forever | Still on the list, picked up on return |
| Needs catch-up replay | Yes | No — replaying would duplicate work |
| Recovery behaviour | Burst | Drains at a fixed rate |

`node-cron` deliberately does **not** backfill missed ticks, and that is correct.
A worker down six hours does not come back and fire 360 missed `scheduled-emails`
ticks — it fires the next one, which finds everything still waiting.

**The real consequence of downtime is late, never lost.**

The one job with a time window is `webinar-attendance`, and it is built for this:
the 24-hour limit applies only to *re-syncing* something already synced; a
webinar never synced at all is picked up regardless of age.

---

## 3. Nothing stampedes on recovery

Each job drains a **fixed batch per tick**, not "everything due":

| Job | Per tick |
|---|---|
| `scheduled-emails` | 10 rows |
| `cert-issue` | 50 renders / 25 emails |
| `invoice-reconciliation` | 25 rows |
| `webinar-attendance` | serial, 500ms apart (Zoom rate limits) |

So a backlog leaves at a constant, predictable rate. Combined with §2's no-replay
property, a classic thundering herd is not expressible here.

**The genuine contention risk is not recovery — it is coincident tick
boundaries.** At the top of each minute two jobs fire; every third minute a
third joins; on the hour more. They share one connection pool. That is what
caused the June 2026 `P2024` incident, and why `cert-issue` runs `*/3` and the
retention sweeps are staggered 03:45 / 04:15 / 04:45 / 05:30.

> **Rule for new jobs:** pick an odd offset (`7,37 * * * *`) over a round
> `*/5`. Round numbers all collide at `:00`.

---

## 4. One job, one runner — and why the connection type matters

Each job takes a Postgres **advisory lock** before running, so it can never run
twice concurrently. Advisory locks are **session-scoped**: the backend that takes
the lock must be the one that releases it.

**Therefore the worker MUST hold a session-mode connection** (`DIRECT_URL`,
`:5432`) and must never use the transaction pooler (`:6543`,
`pgbouncer=true`) — pinned by the `DATABASE_URL` override on the
`ea-sys-worker` service in `docker-compose.prod.yml`.

This is not theoretical tidiness. It ran on the pooler for months:

| Job | Expected/day | Actual (24h, 2026-08-10) |
|---|---|---|
| `scheduled-emails` | 1,440 | **435** |
| `crm-inbound-email` | 1,440 | **375** |
| `cert-issue` | 480 | **182** |
| `oauth-cleanup` (hourly) | 24 | 24 ✓ |

The lock was taken on one backend and released on another that never held it, so
it stayed stuck until pgbouncer recycled the connection minutes later — and every
tick in between skipped. Emails that promised "within ~60s" took 5–17 minutes.
Nothing was lost; everything was late.

**It hid because every health surface asked the wrong question** — *"did the last
run succeed?"* — and the answer was always yes. Three guards now exist:

1. The skipped-tick log is `warn` (was `debug`, which reached neither `/logs`
   nor CloudWatch nor the digest).
2. The daily digest compares each job's 24h count against `expectedPerDay` in
   [src/lib/worker-jobs.ts](../src/lib/worker-jobs.ts) and warns below 80%.
3. `assertSessionModeConnection()` at worker boot logs at **error** (→ operator
   email) if the worker is ever back on the pooler.

### ✅ Fixed properly on 2026-08-10 — a lease, not a lock

Moving off the pooler was the first attempt and it **did not work**: prod went
from 435 runs a day to 7 in 30 minutes, and three locks were caught being held
by connections that had been idle for minutes. The split happens inside
**Prisma's own pool**, below the pooler — proved by probing Postgres directly:

| Pool state | Acquire | Release | `pg_advisory_unlock` |
|---|---|---|---|
| Idle | pid 14724 | pid 14724 | ✅ `true` |
| **Busy** | pid 14731 | pid **14727** | ❌ `false` — leaked |

Two jobs run every minute, so the pool is never idle at a tick boundary. The
leak was therefore near-constant, and no choice of connection *type* could fix
a mix-up happening one layer above it.

**The fix: [`worker/lib/job-lease.ts`](../worker/lib/job-lease.ts).** Instead of
a lock bound to a connection, a row in `JobLease` claimed for a bounded time:

```sql
INSERT INTO "JobLease" (job, owner, "lockedUntil", …)
VALUES (…) ON CONFLICT (job) DO UPDATE SET …
 WHERE "JobLease".owner IS NULL OR "JobLease"."lockedUntil" < now()
RETURNING job
```

One statement is its own transaction, so it is atomic **wherever it runs** —
connection identity stops being able to affect correctness. Two further
properties fall out of it:

- **Leases expire.** A worker killed mid-tick frees its job at `lockedUntil`
  (5 min) rather than wedging it. The advisory lock had no story for this at
  all; a leaked one sat until the connection closed.
- **Every mutation is owner-conditional.** A tick that overran its lease cannot
  release or extend the successor that legitimately took over — without that,
  a slow tick finishing late would hand its replacement's lease away mid-run.

A heartbeat renews the lease every 60s while a tick runs, so "expired" always
means *the holder died*, never *the holder is slow*. If a lease is ever lost
mid-tick anyway, that logs at **error** and pages — it means the TTL is too
short for that job's real runtime.

**Verified on prod within 4 minutes of deploy:** `scheduled-emails` 4 runs of 4
expected, `crm-inbound-email` 4 of 4, `cert-issue` 2 — full cadence, up from
~23%, with every lease row reading released seconds after its tick.

Pinned by real-Postgres tests
([tests/crm-db/job-lease.db.test.ts](../tests/crm-db/job-lease.db.test.ts)),
including the connection-split case the lock failed. Those have to hit a real
database: a mocked Prisma has exactly one fake connection, so the bug was not
even *expressible* in the unit suite — which is precisely how it survived a year
of green tests.

---

## 5. What is deliberately NOT built

**A wake-up call.** The web container could ping the worker the instant a bulk
send is queued, taking "send now" from ~60s to ~1s, after which the poll would
become a pure safety net and could slow down. It is a good idea and a real
improvement. It is not built because it only helps the *one* job that has a
web-side trigger — certificates, CRM replies and webinar syncs have no such
event and would still depend on the poller. Fix the poller first; the bell is
optional afterwards.

**Per-tenant fairness.** Batch limits are global, not per-tenant. One tenant
queueing 5,000 emails consumes all 10 slots a minute while everyone else waits.
Harmless with one organisation; a real noisy-neighbour problem the day the
platform instance has several.

---

## 6. If the worker breaks

| Failure | Self-heals? | Caught by |
|---|---|---|
| **Crash** (process exits) | Yes — `restart: unless-stopped` | — |
| **Freeze** (running, doing nothing) | Only via the watchdog | Uptime Robot ~2 min → watchdog restart ~6 min → daily digest as backstop |
| **Under-running** (ticking, but rarely) | No | Daily digest §4 check |
| **Container missing** | No | Watchdog alerts; deliberately does not recreate (that would guess an image tag) |

Docker detects a freeze and flips the health label, but **plain Compose never
acts on its own verdict** — only Swarm restarts on health. That gap is why
[`scripts/worker-watchdog.sh`](../scripts/worker-watchdog.sh) exists.

**Nothing is lost during any of these.** Job state lives in Postgres, and §2
means work waits rather than evaporating.

---

## 7. Checking cadence health yourself

```bash
npm run prod:psql
```
```sql
SELECT job,
       count(*) FILTER (WHERE status::text = 'OK')  AS ok_24h,
       count(*) FILTER (WHERE status::text <> 'OK') AS failed_24h,
       max("startedAt")                             AS last_run
FROM "JobRun"
WHERE "startedAt" >= now() - interval '24 hours'
GROUP BY job ORDER BY ok_24h DESC;
```

Compare `ok_24h` against `expectedPerDay` in
[src/lib/worker-jobs.ts](../src/lib/worker-jobs.ts). A job well below its
expected count is **skipping, not failing** — look at held locks and worker
restarts, not at the job's own error handling. `JobRun` rows are pruned after
14 days.
