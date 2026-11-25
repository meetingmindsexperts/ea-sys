/**
 * The stream-recording-finish and stream-recording-retention jobs (Nov 25,
 * 2026; step 4): their own lease ids and schedules, and a failure never
 * thrown out of the job.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { finishSpy, retentionSpy, mockLogger } = vi.hoisted(() => ({
  finishSpy: vi.fn(),
  retentionSpy: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/webinar/stream-recording-finish", () => ({ finishStreamRecordingArchives: finishSpy }));
vi.mock("@/lib/webinar/stream-recording-retention", () => ({ runStreamRecordingRetention: retentionSpy }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("../../worker/lib/job-lease", () => ({
  withJobLock: async (_id: number, _name: string, fn: () => Promise<void>) => fn(),
}));

import * as finishJob from "../../worker/jobs/stream-recording-finish";
import * as retentionJob from "../../worker/jobs/stream-recording-retention";
import { JOB_IDS } from "../../worker/lib/job-ids";
import { maxIntervalMs } from "../../worker/lib/health-server";

const QUIET = { checked: 1, errors: 0, skipped: 0, waiting: 1, ready: 0, empty: 0, retry: 0, failed: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  finishSpy.mockResolvedValue(QUIET);
  retentionSpy.mockResolvedValue({ expired: 0, expiredFailed: 0, orphanFiles: 0, orphanFilesLeft: 0 });
});

describe("stream-recording-finish job", () => {
  it("has its own lease id and runs every minute at second 45", () => {
    expect(finishJob.JOB_ID).toBe(JOB_IDS.STREAM_RECORDING_FINISH);
    expect(new Set(Object.values(JOB_IDS)).size).toBe(Object.values(JOB_IDS).length);
    expect(finishJob.SCHEDULE).toBe("45 * * * * *");
    expect(maxIntervalMs(finishJob.SCHEDULE)).toBe(60_000);
  });

  it("is quiet while recordings only wait, and says so when one is made", async () => {
    await finishJob.tick();
    expect(mockLogger.info).not.toHaveBeenCalled();
    finishSpy.mockResolvedValue({ ...QUIET, waiting: 0, ready: 1 });
    await finishJob.tick();
    expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({ ready: 1 }), "stream-recording-finish:tick");
  });

  it("a failing run is logged and never throws out of the job", async () => {
    finishSpy.mockRejectedValue(new Error("db down"));
    await expect(finishJob.tick()).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "worker:tick-uncaught", job: "stream-recording-finish" }));
  });
});

describe("stream-recording-retention job", () => {
  it("has its own lease id and runs daily", () => {
    expect(retentionJob.JOB_ID).toBe(JOB_IDS.STREAM_RECORDING_RETENTION);
    expect(retentionJob.SCHEDULE).toBe("40 4 * * *");
  });

  it("says what it did, and a failure never throws out of the job", async () => {
    await retentionJob.tick();
    expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({ job: "stream-recording-retention" }), "stream-recording-retention:tick");
    retentionSpy.mockRejectedValue(new Error("s3 down"));
    await expect(retentionJob.tick()).resolves.toBeUndefined();
  });
});
