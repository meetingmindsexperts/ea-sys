/**
 * Public worker-health probe at /worker/health.
 *
 * Proxies through to the ea-sys-worker container's internal
 * /health endpoint (on port 3099). The worker container does NOT
 * publish 3099 externally; only the Next.js container (same Docker
 * `web` network) can reach it via DNS at `ea-sys-worker:3099`.
 * This route is the only public surface for that data.
 *
 * Returns:
 *   200 + body = worker's own JSON      when the worker is reachable
 *                                       AND its /health returned OK
 *   503 + { ok: false, reason }         when the worker is unreachable
 *                                       OR returned non-200
 *                                       OR took longer than the timeout
 *
 * No auth (matches /health and /api/health — these are operational
 * probes, not secret surfaces). The response is sanitized to drop
 * anything we wouldn't want public.
 *
 * For local dev where the worker isn't in Docker, set
 * `WORKER_HEALTH_URL=http://localhost:3099/health` in .env so this
 * route reaches the locally-running `npm run worker:dev` process.
 */

import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";

// Hard-coded ~2s ceiling. The worker's /health should respond in
// single-digit ms; anything slower is a sign of trouble and we'd
// rather report 503 promptly than make a load balancer wait.
const FETCH_TIMEOUT_MS = 2000;

// Default points at the Docker DNS name. In local dev (no Docker),
// override with WORKER_HEALTH_URL=http://localhost:3099/health.
const DEFAULT_WORKER_HEALTH_URL = "http://ea-sys-worker:3099/health";

interface WorkerHealthBody {
  ok?: boolean;
  uptimeSeconds?: number;
  lastTickAt?: Record<string, string | null>;
  shuttingDown?: boolean;
}

export async function GET() {
  const target = process.env.WORKER_HEALTH_URL ?? DEFAULT_WORKER_HEALTH_URL;
  const start = Date.now();

  // AbortSignal.timeout is the Node 18+ standard way to cap a fetch;
  // simpler than juggling AbortController + setTimeout by hand. The
  // resulting error name is "TimeoutError" so we can distinguish it
  // from network-level failures.
  try {
    const res = await fetch(target, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // Disable Next.js fetch cache — health probes must always hit
      // the live target.
      cache: "no-store",
    });

    const responseTimeMs = Date.now() - start;

    if (!res.ok) {
      apiLogger.warn({
        msg: "worker-health-proxy:non-ok",
        targetUrl: target,
        upstreamStatus: res.status,
        responseTimeMs,
      });
      return NextResponse.json(
        {
          ok: false,
          reason: `worker /health returned ${res.status}`,
          upstreamStatus: res.status,
          responseTimeMs,
          timestamp: new Date().toISOString(),
        },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }

    const body = (await res.json().catch(() => null)) as WorkerHealthBody | null;

    return NextResponse.json(
      {
        ok: body?.ok === true,
        uptimeSeconds: body?.uptimeSeconds ?? null,
        lastTickAt: body?.lastTickAt ?? null,
        shuttingDown: body?.shuttingDown ?? false,
        responseTimeMs,
        timestamp: new Date().toISOString(),
      },
      {
        // If the worker reports `shuttingDown`, mirror that as 503
        // so a load balancer would deregister us cleanly while we
        // drain — same behavior as /health when the DB is down.
        status: body?.ok === true && !body?.shuttingDown ? 200 : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (err) {
    const responseTimeMs = Date.now() - start;
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    apiLogger.warn({
      msg: isTimeout ? "worker-health-proxy:timeout" : "worker-health-proxy:fetch-failed",
      targetUrl: target,
      err: err instanceof Error ? err.message : String(err),
      responseTimeMs,
    });
    return NextResponse.json(
      {
        ok: false,
        reason: isTimeout
          ? `worker /health did not respond within ${FETCH_TIMEOUT_MS}ms`
          : "worker /health unreachable",
        responseTimeMs,
        timestamp: new Date().toISOString(),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
