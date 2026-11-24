/**
 * The watchdog job runs two halves each minute: restarting a dropped Zoom
 * stream, and the sweep that disconnects a partner's stream on a key that may
 * no longer be used (review of a6ec7911: nothing pinned that the job calls the
 * sweep at all, or that one half failing leaves the other running).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { tickSpy, sweepSpy, recordingSpy, mockLogger } = vi.hoisted(() => ({
  tickSpy: vi.fn(),
  sweepSpy: vi.fn(),
  recordingSpy: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/webinar/stream-watchdog", () => ({ runStreamWatchdogTick: tickSpy }));
vi.mock("@/lib/webinar/external-stream-sweep", () => ({ sweepExternalPublishers: sweepSpy }));
vi.mock("@/lib/webinar/stream-recording-sweep", () => ({ convergeStreamRecordings: recordingSpy }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("../../worker/lib/job-lease", () => ({
  withJobLock: async (_id: number, _name: string, fn: () => Promise<void>) => fn(),
}));

import { tick } from "../../worker/jobs/webinar-stream-watchdog";

beforeEach(() => {
  vi.clearAllMocks();
  tickSpy.mockResolvedValue({ checked: 0, dropped: 0, restartsRequested: 0 });
  sweepSpy.mockResolvedValue({ checked: 0, disconnected: 0 });
  recordingSpy.mockResolvedValue({ checked: 0, corrected: 0, closed: 0 });
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

  // The third half (Nov 24, 2026): the stream server is made to agree with every recording.
  it("runs the recording sweep every tick, whatever the other two did", async () => {
    tickSpy.mockRejectedValue(new Error("zoom down"));
    sweepSpy.mockRejectedValue(new Error("mediamtx down"));
    await tick();
    expect(recordingSpy).toHaveBeenCalledTimes(1);
  });

  it("a failing recording sweep is logged as its own part and never throws out of the job", async () => {
    recordingSpy.mockRejectedValue(new Error("db down"));
    await expect(tick()).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ part: "recording-sweep" }));
  });

  it("says so when the recording sweep put the server right or closed a recording, and is quiet otherwise", async () => {
    await tick();
    expect(mockLogger.info).not.toHaveBeenCalled();
    recordingSpy.mockResolvedValue({ checked: 1, corrected: 1, closed: 0 });
    await tick();
    expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({ corrected: 1 }), "webinar-stream-watchdog:recording-sweep");
  });
});
