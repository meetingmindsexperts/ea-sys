/**
 * Tiny HTTP server used only by Docker's healthcheck.
 *
 * Exposes `GET /health` on the configured port (default 3099).
 * Returns 200 with `{ ok, uptimeSeconds, lastTickAt }` so an operator
 * can see at a glance whether the worker is running AND whether each
 * scheduled job has fired recently. Any other path returns 404.
 *
 * Not exposed externally — the worker container's healthcheck hits it
 * via `localhost:3099`; nginx does NOT proxy to this port. The choice
 * of 3099 keeps it out of the way of the Next.js app on 3000 / 3113.
 *
 * Per docs/WORKER_EXTRACTION_PLAN.md §3 — health is internal, not a
 * public service.
 */

import { createServer, type Server } from "http";
import { apiLogger } from "@/lib/logger";

export interface HealthState {
  startedAt: number;
  /** ISO timestamps keyed by job name. Populated by worker/index.ts
   *  after each tick (success OR failure). Seeded with EVERY registered job
   *  at null, so a job that has not ticked yet is visible as a null rather
   *  than being absent from the payload entirely. */
  lastTickAt: Record<string, string | null>;
  /** Cron expression per job, so the reader can judge whether a given
   *  lastTickAt is stale WITHOUT having to know the schedules by heart. */
  schedules: Record<string, string>;
  /** Optional flag for shutdown — once true, /health returns 503 so
   *  Docker's healthcheck flags us as unhealthy + restarts faster.
   *  Defensive in case SIGTERM handling stalls. */
  shuttingDown: boolean;
}

/**
 * Longest plausible gap between ticks for a cron expression, in ms.
 *
 * Only handles the shapes we actually use (`* * * * *`, `*​/N * * * *`,
 * `M * * * *`, `M,M * * * *`, `M H * * *`, `M H D * *`). Anything unrecognised
 * returns null, which the caller reads as "can't judge" — an unknown schedule
 * must never be reported as stale.
 */
export function maxIntervalMs(schedule: string): number | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, , dow] = parts;

  const MIN = 60_000;
  const monthly = dom !== "*" && dow === "*";
  if (monthly) return 32 * 24 * 60 * MIN; // monthly job — a month plus slack

  if (hour !== "*") {
    // Runs at fixed hour(s) each day → at most 24h between ticks (fewer if
    // several hours are listed, but 24h is the safe upper bound).
    const hours = hour.split(",").length;
    return Math.ceil((24 / hours) * 60) * MIN;
  }

  const everyN = min.match(/^\*\/(\d+)$/);
  if (everyN) return Number(everyN[1]) * MIN;
  if (min === "*") return MIN;

  // Fixed minute(s) of every hour, e.g. "0 * * * *" or "16,53 * * * *".
  const times = min.split(",").length;
  return Math.ceil(60 / times) * MIN;
}

/**
 * A job is stale if it has gone conspicuously longer than its cadence without
 * ticking. The x3 multiplier plus a 2-minute floor is deliberately forgiving —
 * a job holding an advisory lock, or a slow tick, must not read as broken.
 *
 * Note we also require the worker to have been UP for that long: a
 * just-restarted worker has not missed anything yet.
 */
export function isStale(
  lastTickAt: string | null,
  schedule: string,
  uptimeMs: number
): boolean {
  const interval = maxIntervalMs(schedule);
  if (interval == null) return false; // unknown cadence → never cry wolf
  const budget = Math.max(interval * 3, 2 * 60_000);
  if (uptimeMs < budget) return false; // not up long enough to have missed one
  if (!lastTickAt) return true; // up long enough, and never ticked
  return Date.now() - new Date(lastTickAt).getTime() > budget;
}

export function startHealthServer(port: number, state: HealthState): Server {
  const server = createServer((req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const uptimeMs = Date.now() - state.startedAt;
    const jobs = Object.entries(state.lastTickAt).map(([name, lastTick]) => {
      const schedule = state.schedules[name] ?? "";
      return {
        name,
        schedule,
        lastTickAt: lastTick,
        stale: isStale(lastTick, schedule, uptimeMs),
      };
    });

    const body = {
      ok: !state.shuttingDown,
      uptimeSeconds: Math.floor(uptimeMs / 1000),
      gitSha: process.env.GIT_SHA ?? "unknown",
      jobs,
      staleJobs: jobs.filter((j) => j.stale).map((j) => j.name),
      // Kept for backward compatibility — deploy.sh and the Docker healthcheck
      // only look at the status code, but anything else already parsing this
      // shape keeps working.
      lastTickAt: state.lastTickAt,
      shuttingDown: state.shuttingDown,
    };

    // DELIBERATELY still 200 when jobs are stale.
    //
    // This endpoint drives Docker's healthcheck, and an unhealthy container gets
    // RESTARTED. If a stale job returned 503, a bug in the staleness heuristic
    // above — or one genuinely wedged job — would put the whole worker into a
    // restart loop, killing the eight healthy jobs to punish the ninth. Staleness
    // is a signal for a human (it surfaces on /admin/infra), not a trigger for
    // an automated kill. Only shutdown flips this to 503.
    const status = state.shuttingDown ? 503 : 200;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });

  // Bind to all interfaces so Docker's healthcheck (running inside
  // the container's own network namespace) can reach it.
  server.listen(port, "0.0.0.0", () => {
    apiLogger.info({ msg: "worker:health-listening", port });
  });

  return server;
}
