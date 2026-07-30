/**
 * Event-loop delay monitor (src/lib/event-loop-monitor.ts) — the histogram
 * behind the `eventLoop` block on /api/health and the worker's /health.
 *
 * What matters here: the stats are real numbers in MILLISECONDS (the raw
 * histogram is nanoseconds — a missed /1e6 would report "10,000,000ms" and
 * read as permanently stalled), a genuine synchronous block of the loop is
 * actually visible in maxMs, and the since-boot worsts are monotonic.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { readEventLoopStats } from "@/lib/event-loop-monitor";

describe("readEventLoopStats", () => {
  it("returns finite millisecond-scale numbers with the full shape", async () => {
    // Let the sampler take at least a couple of ticks first.
    await new Promise((r) => setTimeout(r, 40));
    const stats = readEventLoopStats();

    for (const key of [
      "meanMs",
      "p50Ms",
      "p99Ms",
      "maxMs",
      "windowSeconds",
      "worstP99Ms",
      "worstMaxMs",
      "resolutionMs",
    ] as const) {
      expect(Number.isFinite(stats[key]), key).toBe(true);
      expect(stats[key], key).toBeGreaterThanOrEqual(0);
    }
    // Unit sanity: an idle test process must read as ~the sampler resolution,
    // not nanosecond-scale garbage. 5s is far above any plausible idle delay
    // and far below the raw-nanoseconds failure mode (~10,000,000).
    expect(stats.meanMs).toBeLessThan(5_000);
    expect(stats.resolutionMs).toBe(10);
    expect(stats.p99Ms).toBeGreaterThanOrEqual(stats.p50Ms);
    expect(stats.maxMs).toBeGreaterThanOrEqual(stats.p99Ms);
  });

  it("a synchronous block of the loop shows up in maxMs", async () => {
    // Pin the loop for ~120ms, then yield so the delayed sampler tick fires
    // and records the gap.
    const until = Date.now() + 120;
    while (Date.now() < until) {
      /* busy-spin */
    }
    await new Promise((r) => setTimeout(r, 40));

    const stats = readEventLoopStats();
    // Generous bound (the block was 120ms) so CI scheduling jitter can't
    // flake this — the raw-nanoseconds bug this guards against is off by 10^6.
    expect(stats.maxMs).toBeGreaterThanOrEqual(50);
  });

  it("since-boot worsts are monotonic and never below the current window", () => {
    const first = readEventLoopStats();
    const second = readEventLoopStats();
    expect(second.worstMaxMs).toBeGreaterThanOrEqual(first.worstMaxMs);
    expect(second.worstP99Ms).toBeGreaterThanOrEqual(first.worstP99Ms);
    expect(second.worstMaxMs).toBeGreaterThanOrEqual(second.maxMs);
    expect(second.worstP99Ms).toBeGreaterThanOrEqual(second.p99Ms);
  });
});
