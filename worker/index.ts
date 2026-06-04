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
import cron from "node-cron";
import { apiLogger } from "@/lib/logger";

import * as certIssue from "./jobs/cert-issue";
import * as scheduledEmails from "./jobs/scheduled-emails";
import * as webinarRecordings from "./jobs/webinar-recordings";
import * as webinarAttendance from "./jobs/webinar-attendance";
import * as oauthCleanup from "./jobs/oauth-cleanup";

import { startHealthServer, type HealthState } from "./lib/health-server";
import { installShutdownHandler } from "./lib/shutdown";

const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT ?? 3099);

// Shared state — populated as jobs tick. The health endpoint reads
// from this so operators can see at a glance whether each schedule
// is firing. lastTickAt updates AFTER the tick settles (success or
// failure), so a stale entry means the job is either crashed or
// holding the lock.
const state: HealthState = {
  startedAt: Date.now(),
  lastTickAt: {
    [certIssue.JOB_NAME]: null,
    [scheduledEmails.JOB_NAME]: null,
    [webinarRecordings.JOB_NAME]: null,
    [webinarAttendance.JOB_NAME]: null,
    [oauthCleanup.JOB_NAME]: null,
  },
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

const tasks = [
  cron.schedule(certIssue.SCHEDULE, wrapTick(certIssue)),
  cron.schedule(scheduledEmails.SCHEDULE, wrapTick(scheduledEmails)),
  cron.schedule(webinarRecordings.SCHEDULE, wrapTick(webinarRecordings)),
  cron.schedule(webinarAttendance.SCHEDULE, wrapTick(webinarAttendance)),
  cron.schedule(oauthCleanup.SCHEDULE, wrapTick(oauthCleanup)),
];

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
  schedules: {
    [certIssue.JOB_NAME]: certIssue.SCHEDULE,
    [scheduledEmails.JOB_NAME]: scheduledEmails.SCHEDULE,
    [webinarRecordings.JOB_NAME]: webinarRecordings.SCHEDULE,
    [webinarAttendance.JOB_NAME]: webinarAttendance.SCHEDULE,
    [oauthCleanup.JOB_NAME]: oauthCleanup.SCHEDULE,
  },
});
