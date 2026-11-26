/**
 * Recording a partner's stream with the room (Nov 26, 2026; owner: "when the
 * organiser goes live, that time recording"). The database, the settings
 * writer and the stream server are stand-ins; the rules are real.
 *
 * What matters: switching it on needs the partner's agreement, and that
 * agreement (not the person opening the room) is what the recording carries;
 * a room opened more than 30 minutes early records nothing; a close before the
 * start only pauses, and only when the room drives the recording; the sweep
 * starts a recording for a room left open since too early, and never carries
 * on one that staff stopped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDb, mockLogger, control, streamSpy, diskSpy, settingsSpy } = vi.hoisted(() => ({
  diskSpy: vi.fn(),
  settingsSpy: vi.fn(),
  control: {
    isMediamtxControlConfigured: vi.fn(),
    setPathRecording: vi.fn(),
    clearPathRecording: vi.fn(),
    CONTROL_FAILURE_MESSAGE: { NOT_CONFIGURED: "not set up", UNREACHABLE: "no answer", REFUSED: "refused", BAD_ANSWER: "bad" },
  },
  streamSpy: vi.fn(),
  mockDb: {
    streamRecording: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    event: { findFirst: vi.fn() },
    eventSession: { findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/webinar/mediamtx-control", () => control);
vi.mock("@/lib/webinar/session-stream", () => ({ sessionStream: streamSpy }));
vi.mock("@/lib/webinar/recording-disk", () => ({ freeDiskBytes: diskSpy, RECORDING_MIN_FREE_BYTES: 6 * 1024 ** 3 }));
vi.mock("@/lib/webinar/stream-timeline", () => ({ recordStreamEvent: vi.fn() }));
vi.mock("@/lib/storage", () => ({ signStoredFileDownload: vi.fn(), listStoredFiles: vi.fn(), deleteStoredFiles: vi.fn() }));
vi.mock("@/lib/event-settings", () => ({ updateEventSettings: settingsSpy }));

import {
  earlyRoomDue,
  recordWithRoomView,
  setRecordWithRoom,
  startRecordingForEarlyRoom,
  startRecordingOnRoomOpen,
  stopRecordingOnRehearsalClose,
} from "@/services/stream-recording-service";
import { readRecordWithRoom, roomOpenedTooEarlyToRecord, RECORD_WITH_ROOM_EARLIEST_MS } from "@/lib/webinar/stream-recording";

const KEY = "0123456789abcdef0123456789abcdef";
const START = new Date("2026-12-01T09:00:00Z");
const AGREED = "2026-11-30T15:00:00.000Z";
const MIN = 60_000;
const caller = { organizationId: "org1", eventId: "ev1", sessionId: "s1", userId: "u1", source: "rest" as const };
const withRoom = (extra: Record<string, unknown> = {}) => ({
  webinar: { sessionId: "s1", source: "external", recordWithRoom: { agreedAt: AGREED, agreedByUserId: "agreer" }, ...extra },
});

const row = (extra: Record<string, unknown> = {}) => ({
  id: "r1",
  sessionId: "s1",
  eventId: "ev1",
  organizationId: "org1",
  status: "RECORDING",
  partnerAgreedAt: new Date(AGREED),
  startedAt: START,
  lastStartedAt: START,
  stoppedAt: null,
  pauses: [],
  finishedAt: null,
  serverClearedAt: null,
  storagePrefix: "/uploads/recordings/ev1/s1/r1",
  session: { endTime: new Date(START.getTime() + 60 * MIN), status: "LIVE" },
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

/** The recording as the service reads it, read by read; the last one given answers every later read. */
function reads(...sequence: unknown[]) {
  mockDb.streamRecording.findFirst.mockReset();
  sequence.slice(0, -1).forEach((r) => mockDb.streamRecording.findFirst.mockResolvedValueOnce(r));
  mockDb.streamRecording.findFirst.mockResolvedValue(sequence[sequence.length - 1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STREAM_RECORDING_ENABLED = "true";
  control.isMediamtxControlConfigured.mockReturnValue(true);
  control.setPathRecording.mockResolvedValue({ ok: true, changed: true });
  control.clearPathRecording.mockResolvedValue({ ok: true, changed: true });
  streamSpy.mockResolvedValue({ source: "external", streamKey: KEY, streamStatus: "ACTIVE" });
  diskSpy.mockResolvedValue(18 * 1024 ** 3);
  settingsSpy.mockResolvedValue({});
  // No recording yet; once one is made, it is what every later read finds.
  reads(null, row());
  mockDb.streamRecording.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data));
  mockDb.streamRecording.updateMany.mockResolvedValue({ count: 1 });
  mockDb.eventSession.findFirst.mockResolvedValue({ startTime: START, status: "LIVE" });
  mockDb.event.findFirst.mockResolvedValue({ settings: withRoom() });
  mockDb.auditLog.create.mockResolvedValue({});
});
afterEach(() => {
  delete process.env.STREAM_RECORDING_ENABLED;
});

/** What the settings writer would store, from the patch function it was handed. */
function storedWebinar(current: Record<string, unknown> = { webinar: { sessionId: "s1", chat: { on: true } } }) {
  const patch = settingsSpy.mock.calls[0][1] as (c: Record<string, unknown>) => Record<string, unknown>;
  return patch(current).webinar as Record<string, unknown>;
}

describe("the rules", () => {
  it("reads the choice from the webinar's settings, and anything malformed as off", () => {
    expect(readRecordWithRoom(withRoom())).toEqual({ agreedAt: new Date(AGREED), agreedByUserId: "agreer" });
    expect(readRecordWithRoom({ webinar: {} })).toBeNull();
    expect(readRecordWithRoom({ webinar: { recordWithRoom: { agreedAt: "not a date" } } })).toBeNull();
    expect(readRecordWithRoom(null)).toBeNull();
  });

  it("too early is more than 30 minutes before the start", () => {
    expect(roomOpenedTooEarlyToRecord(START, new Date(START.getTime() - RECORD_WITH_ROOM_EARLIEST_MS - 1))).toBe(true);
    expect(roomOpenedTooEarlyToRecord(START, new Date(START.getTime() - RECORD_WITH_ROOM_EARLIEST_MS))).toBe(false);
    expect(roomOpenedTooEarlyToRecord(START, new Date(START.getTime() + MIN))).toBe(false);
  });

  it("the console sees only when the agreement was confirmed", () => {
    expect(recordWithRoomView(withRoom())).toEqual({ agreedAt: new Date(AGREED) });
    expect(recordWithRoomView({})).toBeNull();
  });
});

describe("setRecordWithRoom", () => {
  it("on needs the partner's agreement, and writes nothing without it", async () => {
    const res = await setRecordWithRoom({ ...caller, on: true });
    expect(res).toMatchObject({ ok: false, code: "AGREEMENT_REQUIRED" });
    expect(settingsSpy).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ code: "AGREEMENT_REQUIRED" }), "stream-recording:record-with-room-refused");
  });

  it("on stores who confirmed the agreement and when, beside the webinar's other settings, and audits it", async () => {
    const now = new Date(AGREED);
    mockDb.eventSession.findFirst.mockResolvedValue({ startTime: START, status: "SCHEDULED" });
    const res = await setRecordWithRoom({ ...caller, on: true, partnerAgreed: true, now });
    expect(res).toEqual({ ok: true, recordWithRoom: { agreedAt: now }, recording: "off" });
    expect(mockDb.streamRecording.create).not.toHaveBeenCalled();
    expect(settingsSpy).toHaveBeenCalledWith("ev1", expect.any(Function), { organizationId: "org1" });
    expect(storedWebinar()).toEqual({ sessionId: "s1", chat: { on: true }, recordWithRoom: { agreedAt: AGREED, agreedByUserId: "u1" } });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "STREAM_RECORDING_WITH_ROOM_ON", entityType: "Event", entityId: "ev1", userId: "u1" }),
    });
  });

  it("off removes it, and is allowed with the owner's switch off", async () => {
    delete process.env.STREAM_RECORDING_ENABLED;
    const res = await setRecordWithRoom({ ...caller, on: false });
    expect(res).toEqual({ ok: true, recordWithRoom: null, recording: "off" });
    expect(storedWebinar({ webinar: { sessionId: "s1", recordWithRoom: { agreedAt: AGREED } } })).toEqual({ sessionId: "s1" });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "STREAM_RECORDING_WITH_ROOM_OFF" }) });
  });

  // Review of 392f9a92f (MED): switched on with the room already open, the opening has passed.
  it("on with the room already open starts the recording now, with the agreement just given", async () => {
    const now = new Date(START.getTime() - 5 * MIN);
    // Read by the "already open" check, then by the start.
    reads(null, null, row());
    const res = await setRecordWithRoom({ ...caller, on: true, partnerAgreed: true, now });
    expect(res).toMatchObject({ ok: true, recording: "started" });
    expect(mockDb.streamRecording.create.mock.calls[0][0].data).toMatchObject({ status: "RECORDING", startedByUserId: "u1" });
  });

  it("on with the room open leaves a recording staff stopped as it is", async () => {
    reads(row({ status: "PAUSED" }));
    const res = await setRecordWithRoom({ ...caller, on: true, partnerAgreed: true, now: START });
    expect(res).toMatchObject({ ok: true, recording: "off" });
    expect(mockDb.streamRecording.updateMany).not.toHaveBeenCalled();
  });

  it("on is refused on a server not set up for recording, and on a webinar with no partner stream", async () => {
    delete process.env.STREAM_RECORDING_ENABLED;
    expect(await setRecordWithRoom({ ...caller, on: true, partnerAgreed: true })).toMatchObject({ ok: false, code: "NOT_AVAILABLE" });
    process.env.STREAM_RECORDING_ENABLED = "true";
    streamSpy.mockResolvedValue({ source: "zoom", streamKey: KEY });
    expect(await setRecordWithRoom({ ...caller, on: true, partnerAgreed: true })).toMatchObject({ ok: false, code: "NOT_PARTNER_STREAM" });
    expect(settingsSpy).not.toHaveBeenCalled();
  });
});

describe("startRecordingOnRoomOpen", () => {
  const opener = { organizationId: "org1", eventId: "ev1", sessionId: "s1", userId: "opener" };

  it("off: nothing is asked or written", async () => {
    expect(await startRecordingOnRoomOpen({ ...opener, settings: { webinar: {} }, now: START })).toBe("off");
    expect(mockDb.eventSession.findFirst).not.toHaveBeenCalled();
    expect(mockDb.streamRecording.create).not.toHaveBeenCalled();
  });

  it("starts the recording with the agreement given when it was switched on, not the opener's", async () => {
    expect(await startRecordingOnRoomOpen({ ...opener, settings: withRoom(), now: START })).toBe("started");
    const data = mockDb.streamRecording.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ partnerAgreedAt: new Date(AGREED), partnerAgreedByUserId: "agreer", startedByUserId: "opener", status: "RECORDING" });
    expect(control.setPathRecording).toHaveBeenCalled();
    expect(mockDb.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "STREAM_RECORDING_STARTED", changes: expect.objectContaining({ reason: "room-opened", source: "room" }) }),
    });
  });

  it("carries on a recording the room closing had stopped", async () => {
    reads(row({ status: "PAUSED", stoppedAt: START, pauses: [{ from: START.toISOString(), to: null }] }), row());
    expect(await startRecordingOnRoomOpen({ ...opener, settings: withRoom(), now: new Date(START.getTime() + 5 * MIN) })).toBe("started");
    expect(mockDb.streamRecording.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "RECORDING" }) }));
  });

  it("within 30 minutes of the start it records; earlier it is a rehearsal and records nothing", async () => {
    const early = new Date(START.getTime() - RECORD_WITH_ROOM_EARLIEST_MS - MIN);
    expect(await startRecordingOnRoomOpen({ ...opener, settings: withRoom(), now: early })).toBe("too-early");
    expect(mockDb.streamRecording.create).not.toHaveBeenCalled();
    const inWindow = new Date(START.getTime() - 20 * MIN);
    expect(await startRecordingOnRoomOpen({ ...opener, settings: withRoom(), now: inWindow })).toBe("started");
  });

  it("a stream server that did not take it is said, not hidden behind a success", async () => {
    control.setPathRecording.mockResolvedValue({ ok: false, code: "UNREACHABLE" });
    expect(await startRecordingOnRoomOpen({ ...opener, settings: withRoom(), now: START })).toBe("server-not-told");
  });

  it("a recording already finished is said as such", async () => {
    reads(row({ status: "READY" }));
    expect(await startRecordingOnRoomOpen({ ...opener, settings: withRoom(), now: START })).toBe("finished");
  });

  it("a refusal (the disk short of room) is said as not started, never thrown", async () => {
    diskSpy.mockResolvedValue(1024);
    expect(await startRecordingOnRoomOpen({ ...opener, settings: withRoom(), now: START })).toBe("not-started");
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ code: "DISK_LOW" }), "stream-recording:start-refused");
  });

  it("a database error is logged and said as not started: the room is already open", async () => {
    mockDb.eventSession.findFirst.mockRejectedValue(new Error("db down"));
    expect(await startRecordingOnRoomOpen({ ...opener, settings: withRoom(), now: START })).toBe("not-started");
    expect(mockLogger.error).toHaveBeenCalledWith(expect.anything(), "stream-recording:start-on-room-open-failed");
  });
});

describe("stopRecordingOnRehearsalClose", () => {
  const closer = { organizationId: "org1", eventId: "ev1", sessionId: "s1", userId: "u1" };

  it("with the room driving it: a close before the start pauses the recording, never finishes it", async () => {
    // Read by the close's own check, then by the stop.
    reads(row(), row(), row({ status: "PAUSED" }));
    await stopRecordingOnRehearsalClose({ ...closer, settings: withRoom() });
    const moved = mockDb.streamRecording.updateMany.mock.calls.map(([a]) => a.data.status);
    expect(moved).toEqual(["PAUSED"]);
    expect(mockDb.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "STREAM_RECORDING_STOPPED", changes: expect.objectContaining({ reason: "rehearsal-closed" }) }),
    });
  });

  it("no recording (the ordinary day-before test) or a stopped one: nothing is stopped and nothing warned", async () => {
    reads(null);
    await stopRecordingOnRehearsalClose({ ...closer, settings: withRoom() });
    reads(row({ status: "PAUSED" }));
    await stopRecordingOnRehearsalClose({ ...closer, settings: withRoom() });
    expect(mockDb.streamRecording.updateMany).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("a recording staff started by hand is left as it is", async () => {
    reads(row());
    await stopRecordingOnRehearsalClose({ ...closer, settings: { webinar: {} } });
    expect(mockDb.streamRecording.findFirst).not.toHaveBeenCalled();
    expect(mockDb.streamRecording.updateMany).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    mockDb.streamRecording.findFirst.mockReset();
    mockDb.streamRecording.findFirst.mockRejectedValue(new Error("db down"));
    await expect(stopRecordingOnRehearsalClose({ ...closer, settings: withRoom() })).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.anything(), "stream-recording:stop-on-rehearsal-close-failed");
  });
});

describe("a room opened too early and left open", () => {
  const OPENED_EARLY_AT = new Date(START.getTime() - 60 * MIN).toISOString();
  const openedEarly = withRoom({ roomOpenedAt: OPENED_EARLY_AT });
  const at = { organizationId: "org1", eventId: "ev1", sessionId: "s1" };

  it("earlyRoomDue: opened before the window, from 30 minutes before the start to 15 after", () => {
    expect(earlyRoomDue(openedEarly, START, new Date(START.getTime() - 31 * MIN))).toBe(false);
    expect(earlyRoomDue(openedEarly, START, new Date(START.getTime() - 30 * MIN))).toBe(true);
    expect(earlyRoomDue(openedEarly, START, new Date(START.getTime() + 15 * MIN))).toBe(true);
    expect(earlyRoomDue(openedEarly, START, new Date(START.getTime() + 16 * MIN))).toBe(false);
    // Opened inside the window: opening it started the recording already.
    expect(earlyRoomDue(withRoom({ roomOpenedAt: new Date(START.getTime() - 10 * MIN).toISOString() }), START, START)).toBe(false);
    expect(earlyRoomDue({ webinar: { roomOpenedAt: OPENED_EARLY_AT } }, START, START)).toBe(false);
  });

  it("the sweep's start: a recording with the agreement, by the system", async () => {
    mockDb.event.findFirst.mockResolvedValue({ settings: openedEarly });
    // Read by the sweep's own check, then by the start.
    reads(null, null, row());
    expect(await startRecordingForEarlyRoom(at, START)).toBe(true);
    expect(mockDb.streamRecording.create.mock.calls[0][0].data).toMatchObject({ partnerAgreedByUserId: "agreer", startedByUserId: null });
    expect(mockLogger.info).toHaveBeenCalledWith(expect.anything(), "stream-recording:started-for-early-room");
  });

  it("never carries on a recording staff stopped, and never starts one once the room is closed", async () => {
    mockDb.event.findFirst.mockResolvedValue({ settings: openedEarly });
    reads(row({ status: "PAUSED" }));
    expect(await startRecordingForEarlyRoom(at, START)).toBe(false);
    reads(null);
    mockDb.eventSession.findFirst.mockResolvedValue({ startTime: START, status: "COMPLETED" });
    expect(await startRecordingForEarlyRoom(at, START)).toBe(false);
    expect(mockDb.streamRecording.create).not.toHaveBeenCalled();
    expect(mockDb.streamRecording.updateMany).not.toHaveBeenCalled();
  });

  it("the choice switched off meanwhile: nothing", async () => {
    mockDb.event.findFirst.mockResolvedValue({ settings: { webinar: { roomOpenedAt: OPENED_EARLY_AT } } });
    expect(await startRecordingForEarlyRoom(at, START)).toBe(false);
  });
});
