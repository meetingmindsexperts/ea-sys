/**
 * Graceful shutdown handler for the worker process.
 *
 * Docker sends SIGTERM and waits 30s before SIGKILL. Our handler:
 *   1. Marks the health state as shutting-down so /health returns 503
 *   2. Stops all scheduled cron tasks (no new ticks)
 *   3. Closes the health HTTP server (no new health requests)
 *   4. Waits up to 25s for in-flight ticks to settle
 *   5. Disconnects Prisma so the connection pool drains cleanly
 *   6. Exits 0
 *
 * The 25s drain timeout leaves 5s of Docker's 30s grace for the final
 * SIGKILL cleanup if a tick is genuinely wedged. In practice every
 * tick we care about finishes in <2s so the drain is fast.
 *
 * Per docs/WORKER_EXTRACTION_PLAN.md §3 — "if the in-flight tick is
 * the cert renderer mid-batch, it finishes the current item then
 * bails."
 */

import type { Server } from "http";
import type { ScheduledTask } from "node-cron";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import type { HealthState } from "./health-server";

interface ShutdownContext {
  tasks: ScheduledTask[];
  healthServer: Server | null;
  healthState: HealthState;
  /** Set of in-flight tick promises. The shutdown handler races
   *  Promise.allSettled(inFlight) against the 25s timeout to give
   *  tick functions time to settle. */
  inFlight: Set<Promise<unknown>>;
}

const DRAIN_TIMEOUT_MS = 25_000;

export function installShutdownHandler(ctx: ShutdownContext): void {
  // Re-entry guard — SIGTERM + SIGINT can both fire during a fast
  // kill, and we don't want two parallel shutdown sequences racing
  // Prisma's $disconnect.
  let shuttingDown = false;

  async function handle(signal: NodeJS.Signals) {
    if (shuttingDown) {
      apiLogger.warn({ msg: "worker:shutdown-already-in-progress", signal });
      return;
    }
    shuttingDown = true;
    ctx.healthState.shuttingDown = true;
    apiLogger.info({
      msg: "worker:shutdown-start",
      signal,
      inFlightCount: ctx.inFlight.size,
    });

    // Stop the scheduler so no new ticks queue while we're draining.
    for (const task of ctx.tasks) {
      try {
        task.stop();
      } catch (err) {
        apiLogger.warn({
          msg: "worker:task-stop-failed",
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Stop accepting new healthcheck requests. (Docker may continue
    // hitting /health during shutdown; once the server is closed
    // those requests are refused, Docker marks us unhealthy + moves
    // on to SIGKILL faster.)
    if (ctx.healthServer) {
      ctx.healthServer.close();
    }

    // Drain in-flight ticks with a timeout. allSettled (not all) so
    // a tick that's still throwing in-flight doesn't block the
    // shutdown.
    if (ctx.inFlight.size > 0) {
      apiLogger.info({
        msg: "worker:shutdown-draining",
        inFlightCount: ctx.inFlight.size,
        timeoutMs: DRAIN_TIMEOUT_MS,
      });
      const timeout = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), DRAIN_TIMEOUT_MS),
      );
      const drain = Promise.allSettled([...ctx.inFlight]).then(() => "drained" as const);
      const outcome = await Promise.race([drain, timeout]);
      apiLogger.info({ msg: "worker:shutdown-drain-result", outcome });
    }

    // Close the Postgres pool cleanly. If this throws we still exit
    // — the connection is closing anyway because the process is.
    try {
      await db.$disconnect();
    } catch (err) {
      apiLogger.warn({
        msg: "worker:prisma-disconnect-failed",
        err: err instanceof Error ? err.message : String(err),
      });
    }

    apiLogger.info({ msg: "worker:shutdown-complete" });
    // Exit 0 — clean shutdown, Docker will not restart unless its
    // restart policy is `always`/`unless-stopped` AND the container
    // is configured to restart on graceful exits (it usually isn't).
    process.exit(0);
  }

  process.on("SIGTERM", () => {
    void handle("SIGTERM");
  });
  process.on("SIGINT", () => {
    void handle("SIGINT");
  });

  // Uncaught exception in a tick that escapes our per-tick try/catch.
  // We log and exit non-zero so Docker restarts us (better than a
  // wedged process).
  process.on("uncaughtException", (err) => {
    apiLogger.error({
      err,
      msg: "worker:uncaught-exception",
      stack: err.stack,
    });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    apiLogger.error({
      msg: "worker:unhandled-rejection",
      reason: reason instanceof Error ? reason.message : String(reason),
    });
    process.exit(1);
  });
}
