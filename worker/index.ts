/**
 * EA-SYS worker process entry point.
 *
 * Runs a node-cron scheduler that fires the 5 background jobs on
 * their natural cadences (cert-issue + scheduled-emails every minute,
 * webinar-recordings every 5 min, webinar-attendance every 10 min,
 * oauth-cleanup hourly). Each job is wrapped in a Postgres advisory
 * lock (worker/lib/advisory-lock.ts) so multiple instances can run
 * safely — the dual-write window during migration (Phase 2-3 of
 * docs/WORKER_EXTRACTION_PLAN.md), Singapore DR boot-up, or future
 * horizontal scaling.
 *
 * The legacy /api/cron/* routes stay live during Phase 2-3 as
 * thin shims around the same runTick() functions; advisory locks
 * mean both paths firing the same job is safe — whichever gets the
 * lock does the work, the other politely skips.
 *
 * Phase 4 (after ~1 week of clean operation) deletes the legacy
 * routes + the Mumbai crontab lines that hit them, and the worker
 * becomes the only path.
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
