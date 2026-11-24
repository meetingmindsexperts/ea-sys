/**
 * The stream-recording-ship job (Nov 24, 2026): every minute at second 15,
 * under its own lease, quiet when there was nothing to ship.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { shipSpy, mockLogger } = vi.hoisted(() => ({
  shipSpy: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/webinar/stream-recording-ship", () => ({ shipStreamRecordings: shipSpy }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("../../worker/lib/job-lease", () => ({
  withJobLock: async (_id: number, _name: string, fn: () => Promise<void>) => fn(),
}));

import { JOB_ID, JOB_NAME, SCHEDULE, tick } from "../../worker/jobs/stream-recording-ship";
import { JOB_IDS } from "../../worker/lib/job-ids";
import { maxIntervalMs } from "../../worker/lib/health-server";

beforeEach(() => {
  vi.clearAllMocks();
  shipSpy.mockResolvedValue({ recordings: 0, shipped: 0, discarded: 0, waiting: 0 });
});

describe("stream-recording-ship job", () => {
  it("has its own lease id, and the health check reads its schedule as once a minute", () => {
    expect(JOB_NAME).toBe("stream-recording-ship");
    expect(JOB_ID).toBe(JOB_IDS.STREAM_RECORDING_SHIP);
    expect(new Set(Object.values(JOB_IDS)).size).toBe(Object.values(JOB_IDS).length);
    expect(SCHEDULE).toBe("15 * * * * *");
    expect(maxIntervalMs(SCHEDULE)).toBe(60_000);
  });

  it("is quiet when there was nothing to ship", async () => {
    await tick();
    expect(shipSpy).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it("says what it did when it shipped, discarded or left something", async () => {
    shipSpy.mockResolvedValue({ recordings: 1, shipped: 9, discarded: 0, waiting: 0 });
    await tick();
    expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({ shipped: 9, job: "stream-recording-ship" }), "stream-recording-ship:tick");
  });

  it("a failing run is logged and never throws out of the job", async () => {
    shipSpy.mockRejectedValue(new Error("db down"));
    await expect(tick()).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "worker:tick-uncaught", job: "stream-recording-ship" }));
  });
});
