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

const { mockDb, mockLogger, control, streamSpy } = vi.hoisted(() => ({
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
    streamRecording: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/webinar/mediamtx-control", () => control);
vi.mock("@/lib/webinar/session-stream", () => ({ sessionStream: streamSpy }));

import {
  convergeStreamRecordings,
  finishStreamRecording,
  getStreamRecording,
  resetStreamRecordingSweep,
  startStreamRecording,
  stopStreamRecording,
  streamRecordingAvailable,
} from "@/services/stream-recording-service";

const KEY = "0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-12-01T09:00:00Z");
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
  finishedAt: null,
  segmentCount: 0,
  totalBytes: BigInt(0),
  durationMs: 0,
  archivePath: null,
  archiveBytes: null,
  error: null,
  deleteAfter: null,
  ...extra,
});

/** The row the service reads: `before` on the first read, `after` on every later one. */
function reads(before: unknown, after: unknown = before) {
  mockDb.streamRecording.findFirst.mockReset();
  mockDb.streamRecording.findFirst.mockResolvedValueOnce(before).mockResolvedValue(after);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStreamRecordingSweep();
  process.env.STREAM_RECORDING_ENABLED = "true";
  control.isMediamtxControlConfigured.mockReturnValue(true);
  control.setPathRecording.mockResolvedValue({ ok: true, changed: true });
  control.clearPathRecording.mockResolvedValue({ ok: true, changed: true });
  streamSpy.mockResolvedValue({ source: "external", streamKey: KEY, streamStatus: "ACTIVE" });
  mockDb.streamRecording.updateMany.mockResolvedValue({ count: 1 });
  mockDb.streamRecording.findMany.mockResolvedValue([]);
  mockDb.auditLog.create.mockResolvedValue({});
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

  it("carries on a paused recording without asking for the agreement again", async () => {
    reads(row({ status: "PAUSED" }), row());
    const result = await startStreamRecording({ ...caller, now: NOW });
    expect(result).toMatchObject({ ok: true, recording: { status: "RECORDING" } });
    expect(mockDb.streamRecording.updateMany).toHaveBeenCalledWith({
      where: { id: "r1", status: "PAUSED" },
      data: { status: "RECORDING", lastStartedAt: NOW },
    });
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

  it.each(["FINISHING", "READY", "FAILED"])("a %s recording is never recorded into again", async (status) => {
    reads(row({ status }));
    expect(await startStreamRecording({ ...caller, partnerAgreed: true, now: NOW })).toMatchObject({ ok: false, code: "ALREADY_FINISHED" });
    expect(control.setPathRecording).not.toHaveBeenCalled();
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
  it("pauses, and tells the stream server not to record", async () => {
    reads(row(), row({ status: "PAUSED", stoppedAt: NOW }));
    const result = await stopStreamRecording({ ...caller, now: NOW });
    expect(result).toMatchObject({ ok: true, recording: { status: "PAUSED", stoppedAt: NOW } });
    expect(mockDb.streamRecording.updateMany).toHaveBeenCalledWith({ where: { id: "r1", status: "RECORDING" }, data: { status: "PAUSED", stoppedAt: NOW } });
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
    expect(mockDb.streamRecording.updateMany).toHaveBeenCalledWith({
      where: { id: "r1", status: "RECORDING" },
      data: { status: "FINISHING", stoppedAt: NOW, finishedAt: NOW },
    });
    expect(control.clearPathRecording).toHaveBeenCalledWith(KEY);
    expect(mockDb.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: "STREAM_RECORDING_FINISHED", changes: { reason: "staff" } });
  });

  it("keeps the time it was stopped when it was already paused", async () => {
    const stopped = new Date("2026-12-01T08:30:00Z");
    reads(row({ status: "PAUSED", stoppedAt: stopped }), row({ status: "FINISHING" }));
    await finishStreamRecording({ ...caller, reason: "room-closed", now: NOW });
    expect(mockDb.streamRecording.updateMany.mock.calls[0][0].data).toEqual({ status: "FINISHING", stoppedAt: stopped, finishedAt: NOW });
  });

  it("twice is not an error, and is not written or audited twice", async () => {
    reads(row({ status: "FINISHING", finishedAt: NOW }));
    const result = await finishStreamRecording({ ...caller, reason: "room-closed", now: NOW });
    expect(result).toMatchObject({ ok: true, recording: { status: "FINISHING" } });
    expect(mockDb.streamRecording.updateMany).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
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
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.anything(), "stream-recording:no-partner-stream-to-tell");
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
});

describe("convergeStreamRecordings (the minute sweep)", () => {
  it("does nothing, and asks nothing, while the stream server cannot be reached by us", async () => {
    control.isMediamtxControlConfigured.mockReturnValue(false);
    expect(await convergeStreamRecordings(NOW)).toEqual({ checked: 0, corrected: 0, closed: 0 });
    expect(mockDb.streamRecording.findMany).not.toHaveBeenCalled();
  });

  it("makes the stream server hold what each recording says", async () => {
    mockDb.streamRecording.findMany.mockResolvedValue([
      row({ id: "r1", sessionId: "s1" }),
      row({ id: "r2", sessionId: "s2", status: "PAUSED" }),
      row({ id: "r3", sessionId: "s3", status: "FINISHING", finishedAt: NOW }),
    ]);
    control.setPathRecording.mockResolvedValue({ ok: true, changed: false });
    control.clearPathRecording.mockResolvedValue({ ok: true, changed: false });
    const report = await convergeStreamRecordings(NOW);
    expect(report).toEqual({ checked: 3, corrected: 0, closed: 0 });
    expect(control.setPathRecording.mock.calls).toEqual([
      [KEY, true],
      [KEY, false],
    ]);
    expect(control.clearPathRecording).toHaveBeenCalledTimes(1);
    expect(streamSpy.mock.calls).toEqual([
      ["s1", "ev1"],
      ["s2", "ev1"],
      ["s3", "ev1"],
    ]);
  });

  it("says so when it had to put the server right (a failed button press, or a restart)", async () => {
    mockDb.streamRecording.findMany.mockResolvedValue([row()]);
    control.setPathRecording.mockResolvedValue({ ok: true, changed: true });
    expect(await convergeStreamRecordings(NOW)).toEqual({ checked: 1, corrected: 1, closed: 0 });
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ status: "RECORDING" }), "stream-recording:server-setting-put-right");
  });

  it("looks at open recordings, and at ones closed within the hour only", async () => {
    await convergeStreamRecordings(NOW);
    const where = mockDb.streamRecording.findMany.mock.calls[0][0].where;
    expect(where.OR[0]).toEqual({ status: { in: ["RECORDING", "PAUSED"] } });
    expect(where.OR[1]).toEqual({
      status: { in: ["FINISHING", "READY", "FAILED"] },
      finishedAt: { gte: new Date("2026-12-01T08:00:00Z") },
    });
  });

  it("closes a recording nobody finished after six hours, as the system", async () => {
    const old = row({ startedAt: new Date("2026-12-01T03:00:00Z") });
    mockDb.streamRecording.findMany.mockResolvedValue([old]);
    reads(old, row({ status: "FINISHING" }));
    expect(await convergeStreamRecordings(NOW)).toEqual({ checked: 1, corrected: 0, closed: 1 });
    expect(mockDb.streamRecording.updateMany.mock.calls[0][0].data).toMatchObject({ status: "FINISHING", finishedAt: NOW });
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({ reason: "overran", source: "worker" });
    expect(control.clearPathRecording).toHaveBeenCalledWith(KEY);
  });

  it("a recording whose session lost its partner stream is said once, not every minute", async () => {
    mockDb.streamRecording.findMany.mockResolvedValue([row()]);
    streamSpy.mockResolvedValue(null);
    await convergeStreamRecordings(NOW);
    await convergeStreamRecordings(NOW);
    const said = mockLogger.warn.mock.calls.filter(([, msg]) => msg === "stream-recording:recording-without-partner-stream");
    expect(said).toHaveLength(1);
    expect(control.setPathRecording).not.toHaveBeenCalled();
  });

  it("one recording's failure never stops the others", async () => {
    mockDb.streamRecording.findMany.mockResolvedValue([row({ id: "r1", sessionId: "s1" }), row({ id: "r2", sessionId: "s2" })]);
    streamSpy.mockRejectedValueOnce(new Error("lookup failed"));
    control.setPathRecording.mockResolvedValue({ ok: true, changed: false });
    expect(await convergeStreamRecordings(NOW)).toEqual({ checked: 2, corrected: 0, closed: 0 });
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1" }), "stream-recording:sweep-failed");
    expect(control.setPathRecording).toHaveBeenCalledTimes(1);
  });

  it("a stream server that fails mid-sweep is logged and not counted as put right", async () => {
    mockDb.streamRecording.findMany.mockResolvedValue([row()]);
    control.setPathRecording.mockResolvedValue({ ok: false, code: "UNREACHABLE" });
    expect(await convergeStreamRecordings(NOW)).toEqual({ checked: 1, corrected: 0, closed: 0 });
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ code: "UNREACHABLE" }), "stream-recording:server-not-told");
  });
});
