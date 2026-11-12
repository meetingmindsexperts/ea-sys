/**
 * The watchdog job runs two halves each minute: restarting a dropped Zoom
 * stream, and the sweep that disconnects a partner's stream on a key that may
 * no longer be used (review of a6ec7911: nothing pinned that the job calls the
 * sweep at all, or that one half failing leaves the other running).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { tickSpy, sweepSpy, mockLogger } = vi.hoisted(() => ({
  tickSpy: vi.fn(),
  sweepSpy: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/webinar/stream-watchdog", () => ({ runStreamWatchdogTick: tickSpy }));
vi.mock("@/lib/webinar/external-stream-sweep", () => ({ sweepExternalPublishers: sweepSpy }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("../../worker/lib/job-lease", () => ({
  withJobLock: async (_id: number, _name: string, fn: () => Promise<void>) => fn(),
}));

import { tick } from "../../worker/jobs/webinar-stream-watchdog";

beforeEach(() => {
  vi.clearAllMocks();
  tickSpy.mockResolvedValue({ checked: 0, dropped: 0, restartsRequested: 0 });
  sweepSpy.mockResolvedValue({ checked: 0, disconnected: 0 });
});

describe("webinar-stream-watchdog job", () => {
  it("runs the watchdog and the partner-stream sweep every tick", async () => {
    await tick();
    expect(tickSpy).toHaveBeenCalledTimes(1);
    expect(sweepSpy).toHaveBeenCalledTimes(1);
  });

  it("the sweep still runs when the watchdog throws, and the failure is logged", async () => {
    tickSpy.mockRejectedValue(new Error("zoom down"));
    await tick();
    expect(sweepSpy).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "worker:tick-uncaught" }));
  });

  it("a failing sweep is logged as its own part and never throws out of the job", async () => {
    sweepSpy.mockRejectedValue(new Error("mediamtx down"));
    await expect(tick()).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ part: "external-sweep" }));
  });

  it("says so when the sweep disconnected something", async () => {
    sweepSpy.mockResolvedValue({ checked: 2, disconnected: 1 });
    await tick();
    expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({ disconnected: 1 }), "webinar-stream-watchdog:external-sweep");
  });
});
