/**
 * Event-loop delay monitor (src/lib/event-loop-monitor.ts) — the histogram
 * behind the `eventLoop` block on /api/health and the worker's /health.
 *
 * What matters here: the stats are real numbers in MILLISECONDS (the raw
 * histogram is nanoseconds — a missed /1e6 would report "10,000,000ms" and
 * read as permanently stalled), a genuine synchronous block of the loop is
 * actually visible in maxMs, and the since-boot worsts are monotonic.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { readEventLoopStats, classifyStall } from "@/lib/event-loop-monitor";

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

describe("classifyStall", () => {
  it("a gap the process slept through reads as suspended (the Sep 7, 2026 laptop numbers)", () => {
    // 17.4 minutes of wall-clock gap, ~0.3s of CPU across the whole window.
    // Before `kind` existed this line was indistinguishable from a pinned loop.
    expect(classifyStall({ maxMs: 1_045_824.5, cpuMs: 312 })).toBe("suspended");
  });

  it("a gap Node computed through reads as busy", () => {
    expect(classifyStall({ maxMs: 9_185.5, cpuMs: 9_100 })).toBe("busy");
    // Boundary: CPU covering exactly half the gap still counts as busy.
    expect(classifyStall({ maxMs: 2_000, cpuMs: 1_000 })).toBe("busy");
    expect(classifyStall({ maxMs: 2_000, cpuMs: 999 })).toBe("suspended");
  });
});

// Last on purpose: it re-imports the module under fake timers and a fake
// histogram, which must not touch the real singleton the tests above use.
describe("the stall line", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("node:perf_hooks");
    vi.restoreAllMocks();
  });

  it("carries kind + cpuMs measured against the window start, and re-bases the CPU on rotation", async () => {
    vi.useFakeTimers();
    // Raw histogram values are NANOSECONDS: 1045824.5ms / 12.1ms / 492.1ms.
    const histogram = {
      enable: vi.fn(),
      reset: vi.fn(),
      percentile: vi.fn(() => 12.1e6),
      max: 1_045_824.5e6,
      mean: 492.1e6,
    };
    vi.doMock("node:perf_hooks", () => ({ monitorEventLoopDelay: () => histogram }));
    vi.resetModules();

    const store = globalThis as typeof globalThis & { __eaEventLoopMonitor?: unknown };
    const saved = store.__eaEventLoopMonitor;
    delete store.__eaEventLoopMonitor;
    // Same figure for the boot read and the delta read: 312ms of CPU.
    const cpu = vi
      .spyOn(process, "cpuUsage")
      .mockReturnValue({ user: 300_000, system: 12_000 });

    try {
      const { apiLogger } = await import("@/lib/logger");
      await import("@/lib/event-loop-monitor");
      vi.advanceTimersByTime(60_000);

      expect(apiLogger.warn).toHaveBeenCalledTimes(1);
      expect(apiLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: "event-loop:stall",
          kind: "suspended",
          maxMs: 1_045_824.5,
          cpuMs: 312,
          p99Ms: 12.1,
          windowSeconds: 60,
        }),
      );
      // Boot read (no arg), delta read (against the window start), re-base
      // (no arg). Dropping the delta arg would report CPU since boot, so a
      // long-lived process would class every sleep as "busy".
      expect(cpu.mock.calls).toEqual([[], [{ user: 300_000, system: 12_000 }], []]);
    } finally {
      store.__eaEventLoopMonitor = saved;
    }
  });
});
