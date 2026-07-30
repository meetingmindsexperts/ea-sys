/**
 * Event-loop delay monitor — the "is Node's single thread pinned?" metric.
 *
 * Wraps node:perf_hooks `monitorEventLoopDelay` in a process-wide singleton
 * and surfaces it on both health endpoints:
 *   - web:    GET /api/health (and the /health alias)  → `eventLoop`
 *   - worker: GET :3099/health (proxied at /worker/health) → `eventLoop`
 *
 * Why it exists: CPU-bound work (badge/barcode rasterization, PDF rendering,
 * pdf-lib cert renders) runs on the same event loop that serves the live
 * check-in scanner and the Stripe webhook. When the loop is pinned, EVERY
 * request stalls — but nothing measured it, so "the box feels slow" had no
 * number. This gives it one.
 *
 * Semantics:
 *   - The histogram covers a rolling ~60s window (reset each rotation), so
 *     the numbers answer "how is the loop doing NOW", not "since boot".
 *   - `worstP99Ms` / `worstMaxMs` are since-boot high-water marks, so a spike
 *     that happened hours ago is still visible after the window moved on.
 *   - A window whose max delay reaches STALL_WARN_MS logs `event-loop:stall`
 *     at WARN (visible in /logs + CloudWatch; warn does NOT page). Healthy
 *     windows log nothing — zero steady-state log volume.
 *
 * Reading the numbers: the sampler itself runs on a 10ms timer, so an IDLE
 * process reports mean/p50 around ~10ms — that's the measurement floor
 * (`resolutionMs`), not lag. Worry when p99 climbs into the hundreds of ms or
 * max hits seconds.
 *
 * SERVER-ONLY (node:perf_hooks) — never import from a "use client" component.
 * State hangs off globalThis so Next dev HMR re-evaluation can't stack a
 * second histogram + interval (same pattern as src/lib/db.ts).
 */
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { apiLogger } from "@/lib/logger";

const WINDOW_MS = 60_000;
/** A single ≥1s block of the loop inside a window is a genuine stall. */
const STALL_WARN_MS = 1_000;
const RESOLUTION_MS = 10;

export interface EventLoopStats {
  /** Mean / p50 / p99 / max loop delay over the current window, in ms. */
  meanMs: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Seconds of data behind the numbers above (window rotates every 60s). */
  windowSeconds: number;
  /** Since-boot high-water marks — survive window rotation. */
  worstP99Ms: number;
  worstMaxMs: number;
  /** Sampler resolution; an idle loop reports mean ≈ this, which is the
   *  measurement floor, not lag. */
  resolutionMs: number;
}

interface MonitorState {
  histogram: IntervalHistogram;
  windowStartedAt: number;
  worstP99Ms: number;
  worstMaxMs: number;
}

const toMs = (ns: number): number =>
  Number.isFinite(ns) ? Math.round(ns / 1e5) / 10 : 0;

function createState(): MonitorState {
  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  histogram.enable();
  const state: MonitorState = {
    histogram,
    windowStartedAt: Date.now(),
    worstP99Ms: 0,
    worstMaxMs: 0,
  };

  // Rotate the window: fold the finished window into the since-boot worsts,
  // warn if it contained a stall, then reset for a fresh window. unref() so
  // this timer never holds the worker's graceful shutdown open.
  const timer = setInterval(() => {
    const p99Ms = toMs(histogram.percentile(99));
    const maxMs = toMs(histogram.max);
    state.worstP99Ms = Math.max(state.worstP99Ms, p99Ms);
    state.worstMaxMs = Math.max(state.worstMaxMs, maxMs);
    if (maxMs >= STALL_WARN_MS) {
      apiLogger.warn({
        msg: "event-loop:stall",
        maxMs,
        p99Ms,
        meanMs: toMs(histogram.mean),
        windowSeconds: Math.round((Date.now() - state.windowStartedAt) / 1000),
      });
    }
    histogram.reset();
    state.windowStartedAt = Date.now();
  }, WINDOW_MS);
  timer.unref();

  return state;
}

const globalStore = globalThis as typeof globalThis & {
  __eaEventLoopMonitor?: MonitorState;
};
const state = (globalStore.__eaEventLoopMonitor ??= createState());

/**
 * Snapshot of current event-loop delay. Cheap (pure reads off the histogram);
 * safe to call on every /health hit.
 */
export function readEventLoopStats(): EventLoopStats {
  const p99Ms = toMs(state.histogram.percentile(99));
  const maxMs = toMs(state.histogram.max);
  // Fold the in-progress window into the worsts too, so a live spike is
  // reflected immediately rather than only after the next rotation.
  state.worstP99Ms = Math.max(state.worstP99Ms, p99Ms);
  state.worstMaxMs = Math.max(state.worstMaxMs, maxMs);

  return {
    meanMs: toMs(state.histogram.mean),
    p50Ms: toMs(state.histogram.percentile(50)),
    p99Ms,
    maxMs,
    windowSeconds: Math.round((Date.now() - state.windowStartedAt) / 1000),
    worstP99Ms: state.worstP99Ms,
    worstMaxMs: state.worstMaxMs,
    resolutionMs: RESOLUTION_MS,
  };
}
