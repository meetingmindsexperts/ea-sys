/**
 * The worker's runs for finished recordings (Nov 25, 2026; step 4): the MP4
 * run works each recording in its own tenant, and the daily run deletes
 * recordings past their time and files no recording claims.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  op: { streamRecording: { findMany: vi.fn() } },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  tenants: [] as string[],
  build: vi.fn(),
  del: vi.fn(),
  list: vi.fn(),
  delFiles: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ dbOperator: h.op }));
vi.mock("@/lib/logger", () => ({ apiLogger: h.logger }));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (org: string, fn: () => unknown) => {
    h.tenants.push(org);
    return fn();
  },
}));
vi.mock("@/services/stream-recording-archive", () => ({ buildRecordingArchive: h.build }));
vi.mock("@/services/stream-recording-service", () => ({ deleteStreamRecording: h.del }));
vi.mock("@/lib/storage", () => ({ listStoredFiles: h.list, deleteStoredFiles: h.delFiles }));

import { finishStreamRecordingArchives } from "@/lib/webinar/stream-recording-finish";
import { ORPHAN_MIN_AGE_MS, recordingIdOf, runStreamRecordingRetention } from "@/lib/webinar/stream-recording-retention";

const NOW = new Date("2026-12-01T12:00:00Z");
const rowA = { eventId: "ev1", sessionId: "s1", organizationId: "org1" };
const rowB = { eventId: "ev2", sessionId: "s2", organizationId: "org2" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("STREAM_RECORDING_ENABLED", "true");
  h.tenants.length = 0;
  h.op.streamRecording.findMany.mockResolvedValue([]);
  h.list.mockResolvedValue([]);
  h.delFiles.mockResolvedValue({ failed: 0 });
  h.del.mockResolvedValue({ ok: true, filesLeft: 0 });
});

describe("finishStreamRecordingArchives", () => {
  it("works each FINISHING recording in its own tenant, oldest finish first, and counts the outcomes", async () => {
    h.op.streamRecording.findMany.mockResolvedValue([rowA, rowB]);
    h.build.mockResolvedValueOnce("ready").mockResolvedValueOnce("waiting");
    const report = await finishStreamRecordingArchives(NOW);
    expect(h.op.streamRecording.findMany.mock.calls[0][0]).toMatchObject({ where: { status: "FINISHING" }, orderBy: { finishedAt: "asc" } });
    expect(h.tenants).toEqual(["org1", "org2"]);
    expect(report).toMatchObject({ checked: 2, ready: 1, waiting: 1, errors: 0 });
  });

  it("one recording's failure never stops the others", async () => {
    h.op.streamRecording.findMany.mockResolvedValue([rowA, rowB]);
    h.build.mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce("ready");
    const report = await finishStreamRecordingArchives(NOW);
    expect(report).toMatchObject({ errors: 1, ready: 1 });
    expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ eventId: "ev1" }), "stream-recording-finish:recording-failed");
  });
});

describe("recordingIdOf", () => {
  it("the recording's id from a file's path, and null for any other shape", () => {
    expect(recordingIdOf("/uploads/recordings/ev1/s1/r1/1795512296-718063.ts")).toBe("r1");
    expect(recordingIdOf("/uploads/recordings/ev1/s1/r1/recording.mp4")).toBe("r1");
    expect(recordingIdOf("/uploads/recordings/ev1/stray.ts")).toBeNull();
    expect(recordingIdOf("/uploads/recordings/ev1/s1/r1/deeper/x.ts")).toBeNull();
  });
});

describe("runStreamRecordingRetention", () => {
  // Review of 593a7f31a: before the owner's steps the worker may not list recordings/ at all.
  it("does nothing on a server not set up for recording", async () => {
    vi.stubEnv("STREAM_RECORDING_ENABLED", "");
    await runStreamRecordingRetention(NOW);
    expect(h.op.streamRecording.findMany).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
  });

  const old = new Date(NOW.getTime() - ORPHAN_MIN_AGE_MS);
  const young = new Date(NOW.getTime() - ORPHAN_MIN_AGE_MS + 1);

  it("deletes recordings past their time through the staff delete, as the system, each in its own tenant", async () => {
    h.op.streamRecording.findMany.mockResolvedValueOnce([rowA]).mockResolvedValue([]);
    const report = await runStreamRecordingRetention(NOW);
    expect(h.op.streamRecording.findMany.mock.calls[0][0].where).toEqual({ status: { in: ["READY", "FAILED"] }, deleteAfter: { lt: NOW } });
    expect(h.del).toHaveBeenCalledWith({ ...rowA, userId: null, source: "worker", reason: "retention" });
    expect(h.tenants).toEqual(["org1"]);
    expect(report.expired).toBe(1);
  });

  it("deletes day-old files no recording claims, and never a claimed, young or strangely placed one", async () => {
    h.list.mockResolvedValue([
      { storedPath: "/uploads/recordings/ev1/s1/gone/1.ts", modifiedAt: old, sizeBytes: 1 },
      { storedPath: "/uploads/recordings/ev1/s1/kept/1.ts", modifiedAt: old, sizeBytes: 1 },
      { storedPath: "/uploads/recordings/ev1/s1/new/1.ts", modifiedAt: young, sizeBytes: 1 },
      { storedPath: "/uploads/recordings/ev1/stray.ts", modifiedAt: old, sizeBytes: 1 },
    ]);
    h.op.streamRecording.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "kept" }]);
    const report = await runStreamRecordingRetention(NOW);
    expect(h.op.streamRecording.findMany.mock.calls[1][0].where).toEqual({ id: { in: ["gone", "kept"] } });
    expect(h.delFiles).toHaveBeenCalledWith(["/uploads/recordings/ev1/s1/gone/1.ts"], "/uploads/recordings/");
    expect(report.orphanFiles).toBe(1);
  });

  it("a failed delete of one recording is counted and logged, and the run goes on", async () => {
    h.op.streamRecording.findMany.mockResolvedValueOnce([rowA, rowB]).mockResolvedValue([]);
    h.del.mockRejectedValueOnce(new Error("s3 down")).mockResolvedValueOnce({ ok: true, filesLeft: 0 });
    const report = await runStreamRecordingRetention(NOW);
    expect(report).toMatchObject({ expired: 1, expiredFailed: 1 });
  });
});
