/**
 * Recording a partner's stream: start, stop, finish and the minute sweep
 * (Nov 24, 2026; docs/PARTNER_STREAM_RECORDING_PLAN.md, step 1). The database
 * and the stream server are stand-ins; the rules are real.
 *
 * What matters most here: the database is written FIRST and a stream server
 * that fails is reported, not thrown; and the stream key reaches the control
 * module and nothing else (no row, no answer, no log).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDb, mockLogger, control, streamSpy, diskSpy, timelineSpy, storage } = vi.hoisted(() => ({
  storage: { signStoredFileDownload: vi.fn(), listStoredFiles: vi.fn(), deleteStoredFiles: vi.fn() },
  diskSpy: vi.fn(),
  timelineSpy: vi.fn(),
  control: {
    isMediamtxControlConfigured: vi.fn(),
    setPathRecording: vi.fn(),
    clearPathRecording: vi.fn(),
    CONTROL_FAILURE_MESSAGE: {
      NOT_CONFIGURED: "not set up",
      UNREACHABLE: "The stream server did not answer.",
      REFUSED: "refused",
      BAD_ANSWER: "bad answer",
    },
  },
  streamSpy: vi.fn(),
  mockDb: {
    streamRecording: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/webinar/mediamtx-control", () => control);
vi.mock("@/lib/webinar/session-stream", () => ({ sessionStream: streamSpy }));
vi.mock("@/lib/webinar/recording-disk", () => ({ freeDiskBytes: diskSpy, RECORDING_MIN_FREE_BYTES: 6 * 1024 ** 3 }));
vi.mock("@/lib/webinar/stream-timeline", () => ({ recordStreamEvent: timelineSpy }));
vi.mock("@/lib/storage", () => storage);

import {
  deleteStreamRecording,
  DOWNLOAD_LINK_SECONDS,
  finishStreamRecording,
  getStreamRecording,
  streamRecordingDownload,
  keepRecordingInStep,
  resetStreamRecordingReports,
  startStreamRecording,
  stopRecordingOnRoomClose,
  stopStreamRecording,
  streamRecordingAvailable,
} from "@/services/stream-recording-service";

const KEY = "0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-12-01T09:00:00Z");
const SESSION_END = new Date("2026-12-01T10:00:00Z");
const caller = { organizationId: "org1", eventId: "ev1", sessionId: "s1", userId: "u1", source: "rest" as const };

const row = (extra: Record<string, unknown> = {}) => ({
  id: "r1",
  sessionId: "s1",
  eventId: "ev1",
  organizationId: "org1",
  status: "RECORDING",
  partnerAgreedAt: NOW,
  startedAt: NOW,
  lastStartedAt: NOW,
  stoppedAt: null,
  pauses: [],
  finishedAt: null,
  serverClearedAt: null,
  storagePrefix: "/uploads/recordings/ev1/s1/r1",
  session: { endTime: SESSION_END, status: "LIVE" },
  segmentCount: 0,
  totalBytes: BigInt(0),
  durationMs: 0,
  archivePath: null,
  archiveBytes: null,
  error: null,
  deleteAfter: null,
  segments: [],
  ...extra,
});

/** The row as the service reads it, read by read; the last one given answers every later read. */
function reads(...sequence: unknown[]) {
  mockDb.streamRecording.findFirst.mockReset();
  sequence.slice(0, -1).forEach((r) => mockDb.streamRecording.findFirst.mockResolvedValueOnce(r));
  mockDb.streamRecording.findFirst.mockResolvedValue(sequence[sequence.length - 1]);
}
/** The writes that move a recording's state (as against the mark that the server was cleared). */
const moves = () => mockDb.streamRecording.updateMany.mock.calls.map(([arg]) => arg).filter((arg) => "status" in arg.data);
const clearedMarks = () => mockDb.streamRecording.updateMany.mock.calls.map(([arg]) => arg).filter((arg) => "serverClearedAt" in arg.data);

beforeEach(() => {
  vi.clearAllMocks();
  resetStreamRecordingReports();
  process.env.STREAM_RECORDING_ENABLED = "true";
  control.isMediamtxControlConfigured.mockReturnValue(true);
  control.setPathRecording.mockResolvedValue({ ok: true, changed: true });
  control.clearPathRecording.mockResolvedValue({ ok: true, changed: true });
  streamSpy.mockResolvedValue({ source: "external", streamKey: KEY, streamStatus: "ACTIVE" });
  mockDb.streamRecording.updateMany.mockResolvedValue({ count: 1 });
  mockDb.streamRecording.findMany.mockResolvedValue([]);
  mockDb.auditLog.create.mockResolvedValue({});
  diskSpy.mockResolvedValue(18 * 1024 ** 3);
  timelineSpy.mockResolvedValue(undefined);
  storage.signStoredFileDownload.mockResolvedValue("https://bucket.example/signed");
  storage.listStoredFiles.mockResolvedValue([]);
  storage.deleteStoredFiles.mockResolvedValue({ failed: 0 });
  mockDb.streamRecording.deleteMany.mockResolvedValue({ count: 1 });
});
afterEach(() => {
  delete process.env.STREAM_RECORDING_ENABLED;
});

describe("streamRecordingAvailable", () => {
  it("needs the owner's switch AND a stream server we can talk to", () => {
    expect(streamRecordingAvailable()).toBe(true);
    control.isMediamtxControlConfigured.mockReturnValue(false);
    expect(streamRecordingAvailable()).toBe(false);
    control.isMediamtxControlConfigured.mockReturnValue(true);
    delete process.env.STREAM_RECORDING_ENABLED;
    expect(streamRecordingAvailable()).toBe(false);
    process.env.STREAM_RECORDING_ENABLED = "yes";
    expect(streamRecordingAvailable()).toBe(false);
  });
});

describe("startStreamRecording", () => {
  it("the first start needs the partner's agreement, and writes nothing without it", async () => {
    reads(null);
    const result = await startStreamRecording({ ...caller, now: NOW });
    expect(result).toMatchObject({ ok: false, code: "AGREEMENT_REQUIRED" });
    expect(mockDb.streamRecording.create).not.toHaveBeenCalled();
    expect(control.setPathRecording).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ code: "AGREEMENT_REQUIRED" }), "stream-recording:start-refused");
  });

  it("creates the recording, stamps who agreed and when, then tells the stream server", async () => {
    reads(null, row());
    mockDb.streamRecording.create.mockResolvedValue(row());
    const result = await startStreamRecording({ ...caller, partnerAgreed: true, now: NOW });

    expect(result).toMatchObject({ ok: true, recording: { status: "RECORDING" }, server: { ok: true, changed: true } });
    const data = mockDb.streamRecording.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      sessionId: "s1",
      eventId: "ev1",
      organizationId: "org1",
      status: "RECORDING",
      partnerAgreedAt: NOW,
      partnerAgreedByUserId: "u1",
      startedByUserId: "u1",
    });
    expect(data.storagePrefix).toBe(`/uploads/recordings/ev1/s1/${data.id}`);
    expect(data.deleteAfter.toISOString()).toBe("2027-12-01T09:00:00.000Z");
    expect(control.setPathRecording).toHaveBeenCalledWith(KEY, true);
    // The database first, the stream server second.
    expect(mockDb.streamRecording.create.mock.invocationCallOrder[0]).toBeLessThan(control.setPathRecording.mock.invocationCallOrder[0]);
    expect(mockDb.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: "STREAM_RECORDING_STARTED",
      entityType: "StreamRecording",
      userId: "u1",
      organizationId: "org1",
    });
  });

  it("the row never holds the stream key, and neither does the answer, the audit or the log", async () => {
    reads(null, row());
    mockDb.streamRecording.create.mockResolvedValue(row());
    control.setPathRecording.mockResolvedValue({ ok: false, code: "UNREACHABLE" });
    const result = await startStreamRecording({ ...caller, partnerAgreed: true, now: NOW });
    const everything = JSON.stringify([
      mockDb.streamRecording.create.mock.calls,
      mockDb.auditLog.create.mock.calls,
      mockLogger.info.mock.calls,
      mockLogger.warn.mock.calls,
      result,
    ]);
    expect(everything).not.toContain(KEY);
  });

  it("a stream server that fails does not fail the start: the answer says so, for the sweep to retry", async () => {
    reads(null, row());
    mockDb.streamRecording.create.mockResolvedValue(row());
    control.setPathRecording.mockResolvedValue({ ok: false, code: "UNREACHABLE" });
    const result = await startStreamRecording({ ...caller, partnerAgreed: true, now: NOW });
    expect(result).toMatchObject({
      ok: true,
      recording: { status: "RECORDING" },
      server: { ok: false, code: "UNREACHABLE", message: "The stream server did not answer." },
    });
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ code: "UNREACHABLE", setting: "record" }), "stream-recording:server-not-told");
  });

  it("carries on a paused recording without asking for the agreement again, and closes its pause", async () => {
    const pauses = [
      { from: "2026-12-01T08:00:00.000Z", to: "2026-12-01T08:10:00.000Z" },
      { from: "2026-12-01T08:30:00.000Z", to: null },
    ];
    reads(row({ status: "PAUSED", pauses }), row());
    const result = await startStreamRecording({ ...caller, now: NOW });
    expect(result).toMatchObject({ ok: true, recording: { status: "RECORDING" } });
    expect(moves()).toEqual([
      {
        where: { id: "r1", status: "PAUSED" },
        data: {
          status: "RECORDING",
          lastStartedAt: NOW,
          // Every pause is kept; the open one is closed at the Start.
          pauses: [pauses[0], { from: "2026-12-01T08:30:00.000Z", to: NOW.toISOString() }],
        },
      },
    ]);
    expect(mockDb.auditLog.create.mock.calls[0][0].data.action).toBe("STREAM_RECORDING_RESUMED");
  });

  it("pressed twice: nothing is written, and the stream server is told again (harmless)", async () => {
    reads(row());
    const result = await startStreamRecording({ ...caller, now: NOW });
    expect(result).toMatchObject({ ok: true, recording: { status: "RECORDING" } });
    expect(mockDb.streamRecording.updateMany).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    expect(control.setPathRecording).toHaveBeenCalledWith(KEY, true);
  });

  it("two people starting at once: the second answers with the first one's recording", async () => {
    reads(null, row());
    mockDb.streamRecording.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    const result = await startStreamRecording({ ...caller, partnerAgreed: true, now: NOW });
    expect(result).toMatchObject({ ok: true, recording: { id: "r1", status: "RECORDING" } });
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("any other database error is thrown to the route", async () => {
    reads(null);
    mockDb.streamRecording.create.mockRejectedValue(Object.assign(new Error("down"), { code: "P1001" }));
    await expect(startStreamRecording({ ...caller, partnerAgreed: true, now: NOW })).rejects.toThrow("down");
  });

  // Review of 7563027f7: this answered ok with a FINISHING recording, as if the Start had happened.
  it("loses the race to someone closing it: the Start is refused, not answered ok with a finished recording", async () => {
    reads(row({ status: "PAUSED" }), row({ status: "FINISHING" }));
    mockDb.streamRecording.updateMany.mockResolvedValue({ count: 0 });
    const result = await startStreamRecording({ ...caller, now: NOW });
    expect(result).toMatchObject({ ok: false, code: "ALREADY_FINISHED" });
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    expect(control.setPathRecording).not.toHaveBeenCalled();
  });

  it("loses the race to someone else's Start: the same recording, answered ok, audited once by them", async () => {
    reads(row({ status: "PAUSED" }), row());
    mockDb.streamRecording.updateMany.mockResolvedValue({ count: 0 });
    const result = await startStreamRecording({ ...caller, now: NOW });
    expect(result).toMatchObject({ ok: true, recording: { status: "RECORDING" } });
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it.each(["FINISHING", "READY", "FAILED"])("a %s recording is never recorded into again", async (status) => {
    reads(row({ status }));
    expect(await startStreamRecording({ ...caller, partnerAgreed: true, now: NOW })).toMatchObject({ ok: false, code: "ALREADY_FINISHED" });
    expect(control.setPathRecording).not.toHaveBeenCalled();
  });

  it("refused on a disk short of room for the stream server's buffer, and nothing is written", async () => {
    reads(null);
    diskSpy.mockResolvedValue(5 * 1024 ** 3);
    expect(await startStreamRecording({ ...caller, partnerAgreed: true, now: NOW })).toMatchObject({ ok: false, code: "DISK_LOW" });
    expect(mockDb.streamRecording.create).not.toHaveBeenCalled();
    expect(control.setPathRecording).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ freeBytes: 5 * 1024 ** 3 }), "stream-recording:disk-low");
  });

  // Pessimistic (owner, Nov 24, 2026): space that could not be read is not taken as enough.
  it("refused when the free space could not be read", async () => {
    reads(row({ status: "PAUSED" }));
    diskSpy.mockResolvedValue(null);
    expect(await startStreamRecording({ ...caller, now: NOW })).toMatchObject({ ok: false, code: "DISK_LOW" });
    expect(moves()).toEqual([]);
  });

  it("pressing Start on a recording already running never fails on the disk: nothing is switched on", async () => {
    reads(row());
    diskSpy.mockResolvedValue(null);
    expect(await startStreamRecording({ ...caller, now: NOW })).toMatchObject({ ok: true, recording: { status: "RECORDING" } });
    expect(diskSpy).not.toHaveBeenCalled();
  });

  it("only a partner's stream: our own Zoom webinar, or no stream at all, is refused", async () => {
    streamSpy.mockResolvedValue({ source: "zoom", streamKey: KEY, streamStatus: "ACTIVE" });
    expect(await startStreamRecording({ ...caller, partnerAgreed: true })).toMatchObject({ ok: false, code: "NOT_PARTNER_STREAM" });
    streamSpy.mockResolvedValue(null);
    expect(await startStreamRecording({ ...caller, partnerAgreed: true })).toMatchObject({ ok: false, code: "NOT_PARTNER_STREAM" });
    expect(mockDb.streamRecording.create).not.toHaveBeenCalled();
  });

  it("refused outright on a server not set up for it", async () => {
    delete process.env.STREAM_RECORDING_ENABLED;
    expect(await startStreamRecording({ ...caller, partnerAgreed: true })).toMatchObject({ ok: false, code: "NOT_AVAILABLE" });
    expect(streamSpy).not.toHaveBeenCalled();
  });
});

describe("stopStreamRecording", () => {
  it("pauses, adds the pause to the list, and tells the stream server not to record", async () => {
    const earlier = { from: "2026-12-01T08:00:00.000Z", to: "2026-12-01T08:10:00.000Z" };
    reads(row({ pauses: [earlier] }), row({ status: "PAUSED", stoppedAt: NOW }));
    const result = await stopStreamRecording({ ...caller, now: NOW });
    expect(result).toMatchObject({ ok: true, recording: { status: "PAUSED", stoppedAt: NOW } });
    expect(moves()).toEqual([
      {
        where: { id: "r1", status: "RECORDING" },
        data: { status: "PAUSED", stoppedAt: NOW, pauses: [earlier, { from: NOW.toISOString(), to: null }] },
      },
    ]);
    expect(control.setPathRecording).toHaveBeenCalledWith(KEY, false);
    expect(mockDb.auditLog.create.mock.calls[0][0].data.action).toBe("STREAM_RECORDING_STOPPED");
  });

  it("someone else moved it meanwhile: no audit for a change that was not ours, and the answer is what is there", async () => {
    reads(row(), row({ status: "FINISHING" }));
    mockDb.streamRecording.updateMany.mockResolvedValue({ count: 0 });
    const result = await stopStreamRecording({ ...caller, now: NOW });
    expect(result).toMatchObject({ ok: true, recording: { status: "FINISHING" } });
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    // The stream server is told what the row NOW says: a finished recording keeps no setting.
    expect(control.clearPathRecording).toHaveBeenCalledWith(KEY);
    expect(control.setPathRecording).not.toHaveBeenCalled();
  });

  // Review of 7563027f7 (M1): told from a row read earlier, a Start pressed meanwhile was undone.
  it("the row moved while the stream server was being told: it is told again, with what the row now says", async () => {
    // Stop reads RECORDING and pauses it; the server is told "do not record"; meanwhile someone pressed Start.
    reads(row(), row({ status: "PAUSED" }), row(), row());
    const result = await stopStreamRecording({ ...caller, now: NOW });
    expect(control.setPathRecording.mock.calls).toEqual([
      [KEY, false],
      [KEY, true],
    ]);
    expect(result).toMatchObject({ ok: true, recording: { status: "RECORDING" } });
  });

  // Review of 7563027f7 (L2): it fell back to the row from before the move and sent "record" for a recording that was gone.
  it("the recording was deleted meanwhile: nothing is left on the stream server, and the answer says there is none", async () => {
    reads(row(), null);
    const result = await stopStreamRecording({ ...caller, now: NOW });
    expect(result).toMatchObject({ ok: false, code: "NOT_STARTED" });
    expect(control.clearPathRecording).toHaveBeenCalledWith(KEY);
    expect(control.setPathRecording).not.toHaveBeenCalled();
  });

  it("nothing to stop", async () => {
    reads(null);
    expect(await stopStreamRecording(caller)).toMatchObject({ ok: false, code: "NOT_STARTED" });
    reads(row({ status: "READY" }));
    expect(await stopStreamRecording(caller)).toMatchObject({ ok: false, code: "ALREADY_FINISHED" });
  });

  it("works with the owner's switch off: a recording can always be stopped", async () => {
    delete process.env.STREAM_RECORDING_ENABLED;
    reads(row(), row({ status: "PAUSED" }));
    expect(await stopStreamRecording({ ...caller, now: NOW })).toMatchObject({ ok: true, recording: { status: "PAUSED" } });
  });
});

describe("finishStreamRecording", () => {
  it("closes for good and removes the stream's setting from the stream server", async () => {
    reads(row(), row({ status: "FINISHING", stoppedAt: NOW, finishedAt: NOW }));
    const result = await finishStreamRecording({ ...caller, reason: "staff", now: NOW });
    expect(result).toMatchObject({ ok: true, recording: { status: "FINISHING", finishedAt: NOW } });
    expect(moves()).toEqual([{ where: { id: "r1", status: "RECORDING" }, data: { status: "FINISHING", stoppedAt: NOW, finishedAt: NOW } }]);
    expect(control.clearPathRecording).toHaveBeenCalledWith(KEY);
    // The clear was confirmed, so the sweep will not ask again.
    expect(clearedMarks()).toEqual([{ where: { id: "r1", serverClearedAt: null }, data: { serverClearedAt: expect.any(Date) } }]);
    expect(mockDb.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: "STREAM_RECORDING_FINISHED", changes: { reason: "staff" } });
  });

  it("keeps the time it was stopped when it was already paused", async () => {
    const stopped = new Date("2026-12-01T08:30:00Z");
    reads(row({ status: "PAUSED", stoppedAt: stopped }), row({ status: "FINISHING" }));
    await finishStreamRecording({ ...caller, reason: "room-closed", now: NOW });
    expect(moves()[0].data).toEqual({ status: "FINISHING", stoppedAt: stopped, finishedAt: NOW });
  });

  // Review of 7563027f7 (L1): Stop at 10:20, Start at 10:30, Finish at 11:30 stored 10:20.
  it("a Stop from before a later Start is not when recording stopped", async () => {
    reads(row({ status: "RECORDING", stoppedAt: new Date("2026-12-01T08:20:00Z") }), row({ status: "FINISHING" }));
    await finishStreamRecording({ ...caller, reason: "staff", now: NOW });
    expect(moves()[0].data.stoppedAt).toEqual(NOW);
  });

  it("a clear the stream server did not take is NOT marked as done: the sweep owes it", async () => {
    reads(row(), row({ status: "FINISHING" }));
    control.clearPathRecording.mockResolvedValue({ ok: false, code: "UNREACHABLE" });
    const result = await finishStreamRecording({ ...caller, reason: "staff", now: NOW });
    expect(result).toMatchObject({ ok: true, server: { ok: false, code: "UNREACHABLE" } });
    expect(clearedMarks()).toEqual([]);
  });

  it("twice is not an error, and is not written or audited twice", async () => {
    reads(row({ status: "FINISHING", finishedAt: NOW }));
    const result = await finishStreamRecording({ ...caller, reason: "room-closed", now: NOW });
    expect(result).toMatchObject({ ok: true, recording: { status: "FINISHING" } });
    expect(moves()).toEqual([]);
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  // Review of 7563027f7 (L6): the room closing calls this for every webinar, and most were never recorded.
  it("the system finding nothing to close is not a warning; a person is told", async () => {
    reads(null);
    expect(await finishStreamRecording({ ...caller, userId: null, source: "room", reason: "room-closed" })).toMatchObject({ ok: false, code: "NOT_STARTED" });
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({ code: "NOT_STARTED" }), "stream-recording:finish-refused");
    reads(null);
    await finishStreamRecording({ ...caller, reason: "staff" });
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ code: "NOT_STARTED" }), "stream-recording:finish-refused");
  });

  it("the system closes without a person: the audit has no user", async () => {
    reads(row(), row({ status: "FINISHING" }));
    await finishStreamRecording({ ...caller, userId: null, source: "room", reason: "room-closed", now: NOW });
    const data = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("userId");
    expect(data.changes).toMatchObject({ source: "room", reason: "room-closed" });
  });

  it("the session lost its partner stream: the recording still closes, and the answer says the server was not told", async () => {
    reads(row(), row({ status: "FINISHING" }));
    streamSpy.mockResolvedValue(null);
    const result = await finishStreamRecording({ ...caller, reason: "staff", now: NOW });
    expect(result).toMatchObject({ ok: true, recording: { status: "FINISHING" }, server: { ok: false } });
    expect(control.clearPathRecording).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ status: "FINISHING" }), "stream-recording:closed-without-partner-stream");
    // No key is left to clear with, so the sweep is told to stop asking.
    expect(clearedMarks()).toHaveLength(1);
  });

  it("a failed audit write never fails the action", async () => {
    reads(row(), row({ status: "FINISHING" }));
    mockDb.auditLog.create.mockRejectedValue(new Error("audit down"));
    expect(await finishStreamRecording({ ...caller, reason: "staff", now: NOW })).toMatchObject({ ok: true });
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ action: "STREAM_RECORDING_FINISHED" }), "stream-recording:audit-failed");
  });
});

describe("getStreamRecording", () => {
  it("answers numbers a browser can read, and never where the files are", async () => {
    reads(row({ status: "READY", totalBytes: BigInt(2_500_000_000), archivePath: "/uploads/recordings/ev1/s1/r1/archive.mp4", archiveBytes: BigInt(2_400_000_000) }));
    const view = await getStreamRecording({ eventId: "ev1", sessionId: "s1" });
    expect(view).toMatchObject({ status: "READY", totalBytes: 2_500_000_000, hasArchive: true, archiveBytes: 2_400_000_000 });
    expect(JSON.stringify(view)).not.toContain("/uploads/");
    expect(() => JSON.stringify(view)).not.toThrow();
  });

  it("null when the session has none", async () => {
    reads(null);
    expect(await getStreamRecording({ eventId: "ev1", sessionId: "s1" })).toBeNull();
  });

  it("says when the newest piece in storage ends, and null before the first", async () => {
    reads(row({ segments: [{ startedAt: new Date("2026-12-01T09:10:00Z"), durationMs: 6_000 }] }));
    expect((await getStreamRecording({ eventId: "ev1", sessionId: "s1" }))?.lastPieceAt).toEqual(new Date("2026-12-01T09:10:06Z"));
    reads(row());
    expect((await getStreamRecording({ eventId: "ev1", sessionId: "s1" }))?.lastPieceAt).toBeNull();
  });
});

// Step 3 (Nov 25, 2026): each start, stop and finish is a line on the console's stream timeline.
describe("the stream timeline", () => {
  it("a first start, a stop and a carry-on are each a line, with the person who pressed", async () => {
    streamSpy.mockResolvedValue({ source: "external", streamKey: KEY, streamStatus: "ACTIVE" });
    reads(null, row());
    mockDb.streamRecording.create.mockResolvedValue(row());
    await startStreamRecording({ ...caller, partnerAgreed: true, now: NOW });
    expect(timelineSpy).toHaveBeenLastCalledWith({
      organizationId: "org1", eventId: "ev1", sessionId: "s1", kind: "RECORDING_STARTED", userId: "u1", detail: null, source: "rest",
    });
    reads(row(), row({ status: "PAUSED" }));
    await stopStreamRecording({ ...caller, now: NOW });
    expect(timelineSpy).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "RECORDING_STOPPED" }));
    reads(row({ status: "PAUSED" }), row());
    await startStreamRecording({ ...caller, now: NOW });
    expect(timelineSpy).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "RECORDING_STARTED", detail: "Carried on after a stop" }));
  });

  it("a finish says why when the system did it, and is the worker's line when the sweep did", async () => {
    reads(row(), row({ status: "FINISHING" }));
    await finishStreamRecording({ ...caller, userId: null, source: "worker", reason: "overran", now: NOW });
    expect(timelineSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "RECORDING_FINISHED", userId: null, source: "worker", detail: "Still open 6 hours after the scheduled end" }),
    );
    reads(row(), row({ status: "FINISHING" }));
    await finishStreamRecording({ ...caller, source: "room", reason: "room-closed", now: NOW });
    expect(timelineSpy).toHaveBeenLastCalledWith(expect.objectContaining({ source: "rest", detail: "The room was closed" }));
  });

  it("no line without the organisation (the audit row is still written), and none for a refusal", async () => {
    reads(row(), row({ status: "FINISHING" }));
    await finishStreamRecording({ ...caller, organizationId: null, reason: "staff", now: NOW });
    expect(timelineSpy).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).toHaveBeenCalled();
    reads(null);
    await stopStreamRecording({ ...caller, now: NOW });
    expect(timelineSpy).not.toHaveBeenCalled();
  });
});

// Review of be8511218 (HIGH): finishing at once left a mistaken close no way back.
describe("stopRecordingOnRoomClose", () => {
  const at = { organizationId: "org1", eventId: "ev1", sessionId: "s1", userId: "u1", source: "room" as const };

  it("STOPS an open recording (never finishes it), saying the room was closed", async () => {
    reads(row(), row({ status: "PAUSED" }));
    await stopRecordingOnRoomClose(at);
    expect(moves()).toEqual([{ where: { id: "r1", status: "RECORDING" }, data: expect.objectContaining({ status: "PAUSED" }) }]);
    expect(mockDb.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: "STREAM_RECORDING_STOPPED", changes: { reason: "room-closed", source: "room" } });
    expect(timelineSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "RECORDING_STOPPED", detail: "The room was closed: finished in 10 minutes unless the room is opened again" }),
    );
  });

  it("an already finished recording is not a warning when the system closes the room again", async () => {
    reads(row({ status: "READY", finishedAt: NOW }));
    await stopRecordingOnRoomClose({ ...at, userId: null, source: "worker" });
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({ code: "ALREADY_FINISHED" }), "stream-recording:stop-refused");
  });

  it("never throws: the room is already closed, and the sweep finishes it at its limit", async () => {
    mockDb.streamRecording.findFirst.mockRejectedValue(new Error("db down"));
    await expect(stopRecordingOnRoomClose(at)).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ eventId: "ev1" }), "stream-recording:stop-on-room-close-failed");
  });
});

describe("keepRecordingInStep (the sweep's work for one recording)", () => {
  const at = { eventId: "ev1", sessionId: "s1", organizationId: "org1" };

  // Review of be8511218 (HIGH): the room closing stops; the sweep finishes ten minutes later.
  it("finishes a stopped recording whose room has been closed for ten minutes, as the system", async () => {
    const stopped = new Date(NOW.getTime() - 10 * 60_000);
    const closedRoom = row({ status: "PAUSED", stoppedAt: stopped, session: { endTime: SESSION_END, status: "COMPLETED" } });
    // The sweep's own read, then finish's.
    reads(closedRoom, closedRoom, row({ status: "FINISHING" }));
    expect(await keepRecordingInStep(at, NOW, true)).toBe("closed");
    expect(moves()).toEqual([{ where: { id: "r1", status: "PAUSED" }, data: { status: "FINISHING", stoppedAt: stopped, finishedAt: NOW } }]);
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({ reason: "room-closed", source: "worker" });
  });

  it("leaves it stopped within the ten minutes, and when the room was opened again", async () => {
    const recent = new Date(NOW.getTime() - 9 * 60_000);
    reads(row({ status: "PAUSED", stoppedAt: recent, session: { endTime: SESSION_END, status: "COMPLETED" } }));
    control.setPathRecording.mockResolvedValue({ ok: true, changed: false });
    expect(await keepRecordingInStep(at, NOW, true)).toBe("unchanged");
    reads(row({ status: "PAUSED", stoppedAt: new Date(NOW.getTime() - 60 * 60_000), session: { endTime: SESSION_END, status: "LIVE" } }));
    expect(await keepRecordingInStep(at, NOW, true)).toBe("unchanged");
    expect(moves()).toEqual([]);
  });

  it("reads the recording afresh and makes the stream server hold what it says", async () => {
    control.setPathRecording.mockResolvedValue({ ok: true, changed: false });
    reads(row({ status: "PAUSED" }));
    expect(await keepRecordingInStep(at, NOW, true)).toBe("unchanged");
    expect(control.setPathRecording).toHaveBeenCalledWith(KEY, false);
    expect(mockDb.streamRecording.findFirst).toHaveBeenCalled();
  });

  it("says so when it had to put the server right (a failed button press, or a restart)", async () => {
    reads(row());
    control.setPathRecording.mockResolvedValue({ ok: true, changed: true });
    expect(await keepRecordingInStep(at, NOW, true)).toBe("corrected");
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ status: "RECORDING" }), "stream-recording:server-setting-put-right");
  });

  it("a closed recording: its setting is removed, marked as confirmed, and that is not a correction", async () => {
    reads(row({ status: "FINISHING", finishedAt: NOW }));
    expect(await keepRecordingInStep(at, NOW, true)).toBe("unchanged");
    expect(control.clearPathRecording).toHaveBeenCalledWith(KEY);
    expect(clearedMarks()).toHaveLength(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  // Review of 7563027f7 (M3): it gave up after an hour, and a "record" setting could outlive its recording.
  it("a closed recording whose clear keeps failing is never marked, however old it is", async () => {
    reads(row({ status: "READY", finishedAt: new Date("2026-11-01T09:00:00Z") }));
    control.clearPathRecording.mockResolvedValue({ ok: false, code: "REFUSED" });
    expect(await keepRecordingInStep(at, NOW, true)).toBe("unchanged");
    expect(clearedMarks()).toEqual([]);
  });

  it("a closed recording already confirmed clear is not marked again", async () => {
    reads(row({ status: "READY", serverClearedAt: NOW }));
    await keepRecordingInStep(at, NOW, true);
    expect(clearedMarks()).toEqual([]);
  });

  it("closes a recording nobody finished, six hours after the webinar's end, as the system", async () => {
    const old = row({ lastStartedAt: new Date("2026-12-01T03:00:00Z"), session: { endTime: new Date("2026-12-01T03:00:00Z") } });
    reads(old, old, row({ status: "FINISHING" }));
    expect(await keepRecordingInStep(at, NOW, true)).toBe("closed");
    expect(moves()[0].data).toMatchObject({ status: "FINISHING", finishedAt: NOW });
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({ reason: "overran", source: "worker" });
    expect(control.clearPathRecording).toHaveBeenCalledWith(KEY);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.anything(), "stream-recording:closed-after-limit");
  });

  // Review of 7563027f7 (M2).
  it("armed hours before the webinar: left open while the webinar has not run its course", async () => {
    control.setPathRecording.mockResolvedValue({ ok: true, changed: false });
    reads(row({ startedAt: new Date("2026-12-01T01:00:00Z"), lastStartedAt: new Date("2026-12-01T01:00:00Z") }));
    expect(await keepRecordingInStep(at, NOW, true)).toBe("unchanged");
    expect(moves()).toEqual([]);
  });

  it("with no stream server to talk to it still closes an overrun recording, and asks the server nothing otherwise", async () => {
    reads(row());
    expect(await keepRecordingInStep(at, NOW, false)).toBe("unchanged");
    expect(control.setPathRecording).not.toHaveBeenCalled();
    const old = row({ lastStartedAt: new Date("2026-12-01T02:00:00Z"), session: { endTime: new Date("2026-12-01T02:00:00Z") } });
    reads(old, old, row({ status: "FINISHING" }));
    expect(await keepRecordingInStep(at, NOW, false)).toBe("closed");
  });

  it("a close that did not happen is not counted as one", async () => {
    const old = row({ lastStartedAt: new Date("2026-12-01T02:00:00Z"), session: { endTime: new Date("2026-12-01T02:00:00Z") } });
    // Read as open and overrun, then gone by the time finish reads it.
    reads(old, null);
    expect(await keepRecordingInStep(at, NOW, true)).toBe("unchanged");
    expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.anything(), "stream-recording:closed-after-limit");
  });

  it("an open recording whose session lost its partner stream is said once, not every minute", async () => {
    reads(row());
    streamSpy.mockResolvedValue(null);
    await keepRecordingInStep(at, NOW, true);
    await keepRecordingInStep(at, NOW, true);
    const said = mockLogger.warn.mock.calls.filter(([, msg]) => msg === "stream-recording:recording-without-partner-stream");
    expect(said).toHaveLength(1);
    expect(control.setPathRecording).not.toHaveBeenCalled();
  });

  it("no recording: nothing to do", async () => {
    reads(null);
    expect(await keepRecordingInStep(at, NOW, true)).toBe("unchanged");
    expect(streamSpy).not.toHaveBeenCalled();
  });
});

// Step 4 (Nov 25, 2026): the MP4's download link and deleting a recording.
describe("streamRecordingDownload", () => {
  const ready = () => row({ status: "READY", archivePath: "/uploads/recordings/ev1/s1/r1/recording.mp4", archiveBytes: BigInt(9) });

  it("a 5 minute link to the MP4, saved under the event's address, audited", async () => {
    reads(ready());
    const result = await streamRecordingDownload({ ...caller, eventSlug: "Improving β Outcomes!" });
    expect(result).toEqual({ ok: true, url: "https://bucket.example/signed", fileName: "Improving-Outcomes-recording.mp4" });
    expect(storage.signStoredFileDownload).toHaveBeenCalledWith({
      storedPath: "/uploads/recordings/ev1/s1/r1/recording.mp4",
      requirePrefix: "/uploads/recordings/",
      expiresSeconds: DOWNLOAD_LINK_SECONDS,
      contentDisposition: 'attachment; filename="Improving-Outcomes-recording.mp4"',
      contentType: "video/mp4",
    });
    expect(DOWNLOAD_LINK_SECONDS).toBe(300);
    expect(mockDb.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: "STREAM_RECORDING_DOWNLOADED", userId: "u1" });
  });

  it("no file: refused, nothing signed or audited", async () => {
    for (const r of [row({ status: "FINISHING" }), row({ status: "READY" }), row({ status: "FAILED" })]) {
      reads(r);
      expect(await streamRecordingDownload({ ...caller, eventSlug: "x" })).toMatchObject({ ok: false, code: "NO_FILE" });
    }
    expect(storage.signStoredFileDownload).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("deleteStreamRecording", () => {
  const PIECE_FILES = [
    { storedPath: "/uploads/recordings/ev1/s1/r1/1.ts", modifiedAt: NOW, sizeBytes: 1 },
    { storedPath: "/uploads/recordings/ev1/s1/r1/recording.mp4", modifiedAt: NOW, sizeBytes: 1 },
  ];

  it("deletes the row first, then every file in its folder, and audits it", async () => {
    reads(row({ status: "READY", serverClearedAt: NOW }));
    storage.listStoredFiles.mockResolvedValue(PIECE_FILES);
    expect(await deleteStreamRecording({ ...caller, reason: "staff" })).toEqual({ ok: true, filesLeft: 0 });
    expect(mockDb.streamRecording.deleteMany).toHaveBeenCalledWith({ where: { id: "r1", status: "READY" } });
    expect(storage.listStoredFiles).toHaveBeenCalledWith("recordings/ev1/s1/r1");
    expect(storage.deleteStoredFiles).toHaveBeenCalledWith(PIECE_FILES.map((f) => f.storedPath), "/uploads/recordings/");
    expect(mockDb.streamRecording.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(storage.deleteStoredFiles.mock.invocationCallOrder[0]);
    expect(mockDb.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: "STREAM_RECORDING_DELETED", changes: { reason: "staff", files: 2 } });
    // Already cleared on the stream server: not asked again.
    expect(control.clearPathRecording).not.toHaveBeenCalled();
  });

  it("removes the stream server's setting first when that was never confirmed", async () => {
    reads(row({ status: "FAILED", serverClearedAt: null }));
    await deleteStreamRecording({ ...caller, reason: "staff" });
    expect(control.clearPathRecording).toHaveBeenCalledWith(KEY);
  });

  it("an open recording is finished first, and one whose file is being made waits", async () => {
    for (const status of ["RECORDING", "PAUSED"]) {
      reads(row({ status }));
      expect(await deleteStreamRecording({ ...caller, reason: "staff" })).toMatchObject({ ok: false, code: "STILL_RECORDING" });
    }
    reads(row({ status: "FINISHING" }));
    expect(await deleteStreamRecording({ ...caller, reason: "staff" })).toMatchObject({ ok: false, code: "STILL_PREPARING" });
    expect(mockDb.streamRecording.deleteMany).not.toHaveBeenCalled();
  });

  it("files that could not be deleted are reported, for the daily sweep", async () => {
    reads(row({ status: "READY", serverClearedAt: NOW }));
    storage.listStoredFiles.mockResolvedValue(PIECE_FILES);
    storage.deleteStoredFiles.mockResolvedValue({ failed: 1 });
    expect(await deleteStreamRecording({ ...caller, userId: null, source: "worker", reason: "retention" })).toEqual({ ok: true, filesLeft: 1 });
  });

  // Review of 593a7f31a: the row was gone, the route answered 500 and nothing was audited.
  it("files that cannot even be listed: still a delete, audited, all files left to the daily sweep", async () => {
    reads(row({ status: "READY", serverClearedAt: NOW }));
    storage.listStoredFiles.mockRejectedValue(new Error("AccessDenied"));
    expect(await deleteStreamRecording({ ...caller, reason: "staff" })).toEqual({ ok: true, filesLeft: null });
    expect(storage.deleteStoredFiles).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ eventId: "ev1" }), "stream-recording:delete-files-unlisted");
    expect(mockDb.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: "STREAM_RECORDING_DELETED", changes: { files: null, filesLeft: null } });
  });

  it("someone else deleted it meanwhile: nothing of theirs is touched", async () => {
    reads(row({ status: "READY", serverClearedAt: NOW }));
    mockDb.streamRecording.deleteMany.mockResolvedValue({ count: 0 });
    expect(await deleteStreamRecording({ ...caller, reason: "staff" })).toMatchObject({ ok: false, code: "NOT_STARTED" });
    expect(storage.deleteStoredFiles).not.toHaveBeenCalled();
  });
});
