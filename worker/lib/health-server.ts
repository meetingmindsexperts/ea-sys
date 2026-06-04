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
   *  after each tick (success OR failure). */
  lastTickAt: Record<string, string | null>;
  /** Optional flag for shutdown — once true, /health returns 503 so
   *  Docker's healthcheck flags us as unhealthy + restarts faster.
   *  Defensive in case SIGTERM handling stalls. */
  shuttingDown: boolean;
}

export function startHealthServer(port: number, state: HealthState): Server {
  const server = createServer((req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    const body = {
      ok: !state.shuttingDown,
      uptimeSeconds: Math.floor((Date.now() - state.startedAt) / 1000),
      lastTickAt: state.lastTickAt,
      shuttingDown: state.shuttingDown,
    };
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
