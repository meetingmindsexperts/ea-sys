/**
 * EA-SYS worker process entry point.
 *
 * Runs a node-cron scheduler firing every background job on its own cadence —
 * the current roster lives in src/lib/worker-jobs.ts (a drift test enforces it
 * against worker/jobs/*.ts, so that list is the one to trust).
 *
 * Each job runs under a **lease** (worker/lib/job-lease.ts) so it can never run
 * twice at once — whether that is two worker processes (Singapore DR boot-up,
 * horizontal scaling) or, far more commonly, one job's tick overrunning into
 * its own next tick. A tick that takes four minutes simply skips three.
 *
 * The lease replaced a Postgres advisory lock on 2026-08-10. Advisory locks
 * must be released by the same connection that took them, which Prisma's pool
 * cannot guarantee — so they leaked and roughly 70% of ticks silently skipped
 * for months. See job-lease.ts for the full account; the short version is that
 * "which connection ran it" must not be able to affect correctness.
 *
 * Entry contract:
 *   - Loads .env (dotenv) so DATABASE_URL etc. are populated when
 *     running outside Docker (Docker injects via env_file:)
 *   - Imports @/lib/db for the shared Prisma client
 *   - Starts the health HTTP server on PORT (default 3099)
 *   - Registers 5 cron schedules
 *   - Installs SIGTERM/SIGINT handlers + uncaught-exception traps
 *   - Logs `worker:started` so an operator can confirm boot via
 *     /admin/docs viewer's logs panel
 */

import "dotenv/config";
// Must be the first import that can reach the logger: it stamps EA_SYS_TIER,
// which pino reads into its base fields at module evaluation. See its docblock
// for why this cannot be an assignment in this file's body.
import "./lib/tier";
// Sentry must initialize BEFORE any other code path can throw —
// otherwise early-boot errors (env validation, Prisma client init,
// node-cron schedule parsing) won't reach Sentry. This is a side-
// effect import: sentry.server.config.ts at the project root calls
// Sentry.init() during module load. The web tier triggers the same
// file via Next.js's instrumentation hook (src/instrumentation.ts);
// the worker isn't a Next.js runtime so it has to import directly.
//
// SENTRY_DSN env var gates the actual init — when unset, init is a
// no-op so dev runs aren't noisy.
import "../sentry.server.config";
import cron from "node-cron";
import { apiLogger } from "@/lib/logger";

import * as certIssue from "./jobs/cert-issue";
import * as scheduledEmails from "./jobs/scheduled-emails";
import * as webinarRecordings from "./jobs/webinar-recordings";
import * as webinarAttendance from "./jobs/webinar-attendance";
import * as oauthCleanup from "./jobs/oauth-cleanup";
import * as invoiceReconciliation from "./jobs/invoice-reconciliation";
import * as crmReminders from "./jobs/crm-reminders";
import * as contactsCentralSync from "./jobs/contacts-central-sync";
import * as contactsCentralReconcile from "./jobs/contacts-central-reconcile";
import * as logArchive from "./jobs/log-archive";
import * as emailLogPrune from "./jobs/email-log-prune";
import * as crmInboundEmail from "./jobs/crm-inbound-email";
import * as loginEventPrune from "./jobs/login-event-prune";
import * as systemLogPrune from "./jobs/system-log-prune";
import * as supportingDocumentPrune from "./jobs/supporting-document-prune";
import * as dailyDigest from "./jobs/daily-digest";
import * as analyticsPrune from "./jobs/analytics-prune";
import * as hrYearRoll from "./jobs/hr-year-roll";

import { startHealthServer, type HealthState } from "./lib/health-server";
import { installShutdownHandler } from "./lib/shutdown";

const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT ?? 3099);

/**
 * THE roster. Every job appears exactly once, and the cron registrations, the
 * /health seed and the startup log are all DERIVED from it.
 *
 * This used to be three hand-maintained lists, and they had drifted: the health
 * seed named 5 jobs while 9 were registered. The four missing ones
 * (invoice-reconciliation, contacts-central-sync, contacts-central-reconcile,
 * log-archive) were simply ABSENT from /worker/health until their first tick —
 * so asking "is log-archive running?" returned no key at all, which is
 * indistinguishable from "that job doesn't exist". For a monthly job that's a
 * 30-day blind spot. Deriving everything from one array makes the drift
 * unexpressible rather than merely fixed.
 */
const JOBS = [
  certIssue,
  scheduledEmails,
  webinarRecordings,
  webinarAttendance,
  oauthCleanup,
  invoiceReconciliation,
  contactsCentralSync,
  contactsCentralReconcile,
  logArchive,
  crmReminders,
  emailLogPrune,
  crmInboundEmail,
  loginEventPrune,
  systemLogPrune,
  supportingDocumentPrune,
  dailyDigest,
  analyticsPrune,
  hrYearRoll,
];

// Shared state — populated as jobs tick. The health endpoint reads
// from this so operators can see at a glance whether each schedule
// is firing. lastTickAt updates AFTER the tick settles (success or
// failure), so a stale entry means the job is either crashed or
// holding the lock.
//
// Seeded with EVERY job at null, so "registered but hasn't ticked yet" is
// visible as a key with a null value, rather than being invisible.
const state: HealthState = {
  startedAt: Date.now(),
  lastTickAt: Object.fromEntries(JOBS.map((j) => [j.JOB_NAME, null])),
  schedules: Object.fromEntries(JOBS.map((j) => [j.JOB_NAME, j.SCHEDULE])),
  shuttingDown: false,
};

// Track in-flight tick promises so the shutdown handler can drain
// them before the process exits. Each tick is added on start and
// removed in finally — this means a hung tick stays in the set
// until the drain timeout in shutdown.ts fires.
const inFlight = new Set<Promise<unknown>>();

/**
 * Wraps a job's `tick()` so we can:
 *   - track it in `inFlight` for shutdown draining
 *   - log start + duration + outcome regardless of how the tick exits
 *   - update state.lastTickAt AFTER the tick settles (so the health
 *     endpoint never shows a future timestamp during a hang)
 *
 * Errors that escape the job's own try/catch land here — we log them
 * (the "every failure logs" rule) but never re-throw, because a
 * thrown error in a node-cron task suppresses future ticks.
 */
function wrapTick(job: {
  JOB_NAME: string;
  tick: () => Promise<void>;
}): () => Promise<void> {
  return async () => {
    const startedAt = Date.now();
    apiLogger.debug({ msg: "worker:tick-start", job: job.JOB_NAME });
    const promise = (async () => {
      try {
        await job.tick();
      } catch (err) {
        // job.tick() already has its own try/catch — this is the
        // belt-and-suspenders catch for anything that slips through.
        apiLogger.error({
          err,
          msg: "worker:tick-wrapper-uncaught",
          job: job.JOB_NAME,
        });
      } finally {
        state.lastTickAt[job.JOB_NAME] = new Date().toISOString();
        apiLogger.debug({
          msg: "worker:tick-end",
          job: job.JOB_NAME,
          durationMs: Date.now() - startedAt,
        });
      }
    })();
    inFlight.add(promise);
    promise.finally(() => {
      inFlight.delete(promise);
    });
    return promise;
  };
}

// ── Register schedules ───────────────────────────────────────────────
// node-cron 5-field expressions (minute hour day-of-month month
// day-of-week). Each schedule string also lives on the job module
// (`SCHEDULE`) so adding/changing one job touches a single file.
//
// ⚠ STAGGER A NEW SUB-HOURLY JOB. Do not write a bare star-slash-N: every one
// of those fires on :00, and most on :30 as well. With all nine pollers on
// plain steps, EIGHT jobs ticked on the same second against a Prisma pool of
// ten, and on 2026-08-12 that produced a P2024 pool timeout on the
// crm-reminders lease claim. It was handled (retryable, so the tick skipped),
// but the shape is nasty: it is invisible while the database is fast and shows
// up only when it is slow, which is when you can least afford it.
//
// Use the offset form instead: "7-59/5" runs every 5 minutes starting at :07,
// same frequency, different phase. Peak concurrency is now 4, two of which are
// the two every-minute jobs and cannot be moved.
// __tests__/lib/worker-cadence-stagger.test.ts fails if a new job pushes the
// peak past 4, and names the minute and the jobs sharing it.

/**
 * Advisory locks are SESSION-scoped, so the worker must hold a session-mode
 * connection (DIRECT_URL, :5432) — never the transaction pooler. On the pooler
 * the lock is taken on one backend and released on another, so it leaks and
 * every subsequent tick skips (measured on prod 2026-08-10: scheduled-emails
 * ran 435 of 1,440 expected). docker-compose.prod.yml pins this; the check here
 * exists because that pinning is one interpolated line, and the failure it
 * guards against is SILENT — the worker runs, jobs just quietly stop happening.
 *
 * Deliberately does NOT refuse to boot, unlike the RLS tripwire below. A worker
 * on the pooler is DEGRADED (work happens late); a worker that won't start does
 * no work at all — and degraded beats dead for this component. Logging at
 * `error` emails the operator immediately via the admin-alert forwarding hook,
 * which is loud enough.
 */
function assertSessionModeConnection() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/pgbouncer=true|:6543/.test(url)) return;
  apiLogger.error({
    msg: "worker:pooled-connection-detected",
    detail:
      "The worker is connected through the TRANSACTION POOLER. Advisory locks " +
      "leak on the pooler, so jobs will silently skip most of their ticks. " +
      "Expected the session-mode DIRECT_URL (:5432). Check the DATABASE_URL " +
      "override on the ea-sys-worker service in docker-compose.prod.yml.",
    runbook: "docs/AWS_OPERATIONS.md §1.7 E",
  });
}

async function boot() {
  assertSessionModeConnection();

  // RLS tripwire (owner decision July 23, 2026: refuse to boot). A deployment
  // claiming tenant isolation (RLS_SET_LOCAL=1) whose DB connection bypasses
  // RLS (owner role / policies never applied) must not run jobs against the
  // shared database — the assert runs BEFORE any schedule registers, so not a
  // single tick can fire against a mis-isolated DB. Flag off (master): no-op,
  // no DB call. (boot() is async only for this await; the file is CJS under
  // tsx, so no top-level await.)
  if (process.env.RLS_SET_LOCAL === "1") {
    const [{ assertRlsEnforced }, { db }] = await Promise.all([
      import("@/lib/tenant/rls-assert"),
      import("@/lib/db"),
    ]);
    await assertRlsEnforced(db);
  }

  const tasks = JOBS.map((job) => cron.schedule(job.SCHEDULE, wrapTick(job)));

  const healthServer = startHealthServer(HEALTH_PORT, state);

  installShutdownHandler({
    tasks,
    healthServer,
    healthState: state,
    inFlight,
  });

  apiLogger.info({
    msg: "worker:started",
    jobs: tasks.length,
    healthPort: HEALTH_PORT,
    gitSha: process.env.GIT_SHA ?? "unknown",
    schedules: state.schedules,
  });
}

boot().catch((err) => {
  apiLogger.error({ err, msg: "worker:boot-refused" });
  process.exit(1);
});
