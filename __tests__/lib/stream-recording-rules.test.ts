/**
 * The rules of recording a partner's stream (Nov 24, 2026;
 * docs/PARTNER_STREAM_RECORDING_PLAN.md, step 1). Pure, so tested as arithmetic.
 */
import { describe, it, expect } from "vitest";
import {
  isRecordingOpen,
  RECORDING_MAX_MS,
  recordingDeleteAfter,
  recordingOverran,
  recordingStoragePrefix,
  recordingTransition,
  pausesAfterStart,
  pausesAfterStop,
  PAUSES_MAX,
  readPauses,
  serverSetting,
  type RecordingStatus,
  finishesAfterRoomClosed,
  ROOM_CLOSED_FINISH_GRACE_MS,
} from "@/lib/webinar/stream-recording";

const CLOSED: RecordingStatus[] = ["FINISHING", "READY", "FAILED"];

describe("recordingTransition", () => {
  it("only Start makes a recording", () => {
    expect(recordingTransition(null, "start")).toEqual({ ok: true, next: "RECORDING", changed: true });
    expect(recordingTransition(null, "stop")).toEqual({ ok: false, code: "NOT_STARTED" });
    expect(recordingTransition(null, "finish")).toEqual({ ok: false, code: "NOT_STARTED" });
  });

  it("Start and Stop move between RECORDING and PAUSED, and pressing twice changes nothing", () => {
    expect(recordingTransition("RECORDING", "stop")).toEqual({ ok: true, next: "PAUSED", changed: true });
    expect(recordingTransition("PAUSED", "start")).toEqual({ ok: true, next: "RECORDING", changed: true });
    expect(recordingTransition("RECORDING", "start")).toEqual({ ok: true, next: "RECORDING", changed: false });
    expect(recordingTransition("PAUSED", "stop")).toEqual({ ok: true, next: "PAUSED", changed: false });
  });

  it("Finish closes an open recording from either state", () => {
    expect(recordingTransition("RECORDING", "finish")).toEqual({ ok: true, next: "FINISHING", changed: true });
    expect(recordingTransition("PAUSED", "finish")).toEqual({ ok: true, next: "FINISHING", changed: true });
  });

  it("Finish twice is not an error: the room closing and a person can both arrive", () => {
    expect(recordingTransition("FINISHING", "finish")).toEqual({ ok: true, next: "FINISHING", changed: false });
  });

  it.each(CLOSED)("a %s recording is never recorded into again", (status) => {
    expect(recordingTransition(status, "start")).toEqual({ ok: false, code: "ALREADY_FINISHED" });
    expect(recordingTransition(status, "stop")).toEqual({ ok: false, code: "ALREADY_FINISHED" });
  });

  it("READY and FAILED do not go back to FINISHING", () => {
    expect(recordingTransition("READY", "finish")).toEqual({ ok: false, code: "ALREADY_FINISHED" });
    expect(recordingTransition("FAILED", "finish")).toEqual({ ok: false, code: "ALREADY_FINISHED" });
  });
});

describe("serverSetting", () => {
  it("the stream server records only while RECORDING", () => {
    expect(serverSetting("RECORDING")).toBe("record");
    expect(serverSetting("PAUSED")).toBe("hold");
  });

  it.each(CLOSED)("a %s recording leaves no setting on the stream server", (status) => {
    expect(serverSetting(status)).toBe("none");
  });

  it("open means RECORDING or PAUSED", () => {
    expect(isRecordingOpen("RECORDING")).toBe(true);
    expect(isRecordingOpen("PAUSED")).toBe(true);
    for (const status of CLOSED) expect(isRecordingOpen(status)).toBe(false);
  });
});

describe("limits", () => {
  const start = new Date("2026-12-01T09:00:00Z");
  const sessionEnd = new Date("2026-12-01T10:00:00Z");
  const hours = (h: number) => new Date(sessionEnd.getTime() + h * 60 * 60 * 1000);

  it("a recording nobody finished is closed six hours after the webinar's scheduled end, not before", () => {
    const recording = { lastStartedAt: start, sessionEndTime: sessionEnd };
    expect(recordingOverran(recording, new Date(hours(6).getTime() - 1))).toBe(false);
    expect(recordingOverran(recording, hours(6))).toBe(true);
    expect(RECORDING_MAX_MS).toBe(6 * 60 * 60 * 1000);
  });

  // Review of 7563027f7: counted from when the recording was made, arming at nine closed it at three.
  it("armed in the morning for an afternoon webinar: still open when the webinar runs", () => {
    const armed = { lastStartedAt: new Date("2026-12-01T05:00:00Z"), sessionEndTime: new Date("2026-12-01T13:00:00Z") };
    expect(recordingOverran(armed, new Date("2026-12-01T12:30:00Z"))).toBe(false);
    expect(recordingOverran(armed, new Date("2026-12-01T18:59:00Z"))).toBe(false);
    expect(recordingOverran(armed, new Date("2026-12-01T19:00:00Z"))).toBe(true);
  });

  it("a Start pressed after the scheduled end counts from that Start", () => {
    const late = { lastStartedAt: hours(5), sessionEndTime: sessionEnd };
    expect(recordingOverran(late, hours(10))).toBe(false);
    expect(recordingOverran(late, hours(11))).toBe(true);
  });

  it("kept for twelve months from the day it began", () => {
    expect(recordingDeleteAfter(start).toISOString()).toBe("2027-12-01T09:00:00.000Z");
    // The input is not changed.
    expect(start.toISOString()).toBe("2026-12-01T09:00:00.000Z");
  });
});

describe("recordingStoragePrefix", () => {
  it("is the private recordings folder, by event, session and recording", () => {
    expect(recordingStoragePrefix({ eventId: "ev1", sessionId: "s1", recordingId: "0b7c-9e" })).toBe("/uploads/recordings/ev1/s1/0b7c-9e");
  });

  it.each(["../x", "a/b", "", "a b", "x".repeat(65)])("refuses an id that could steer the path: %j", (bad) => {
    expect(() => recordingStoragePrefix({ eventId: bad, sessionId: "s1", recordingId: "r1" })).toThrow();
    expect(() => recordingStoragePrefix({ eventId: "ev1", sessionId: bad, recordingId: "r1" })).toThrow();
    expect(() => recordingStoragePrefix({ eventId: "ev1", sessionId: "s1", recordingId: bad })).toThrow();
  });
});

describe("the pause list (review of 9592d2151: every pause, not only the last)", () => {
  const at = (m: number) => new Date(Date.UTC(2026, 11, 1, 9, m, 0));

  it("a Stop opens a pause, a Start closes it, and every pause is kept", () => {
    let list: unknown = [];
    list = pausesAfterStop(list, at(10));
    list = pausesAfterStart(list, at(20));
    list = pausesAfterStop(list, at(40));
    expect(list).toEqual([
      { from: at(10).toISOString(), to: at(20).toISOString() },
      { from: at(40).toISOString(), to: null },
    ]);
    expect(readPauses(list)).toEqual([
      { from: at(10), to: at(20) },
      { from: at(40), to: null },
    ]);
  });

  it("a Start with no pause open changes nothing", () => {
    const closed = [{ from: at(10).toISOString(), to: at(20).toISOString() }];
    expect(pausesAfterStart(closed, at(30))).toEqual(closed);
    expect(pausesAfterStart([], at(30))).toEqual([]);
  });

  it("reads what is stored defensively: anything that is not a pause is left out", () => {
    expect(readPauses(null)).toEqual([]);
    expect(readPauses("x")).toEqual([]);
    expect(readPauses([{ from: "not a date" }, { to: at(1).toISOString() }, 7, { from: at(2).toISOString(), to: "bad" }])).toEqual([
      { from: at(2), to: null },
    ]);
  });

  it("keeps at most PAUSES_MAX, the newest", () => {
    const many = Array.from({ length: PAUSES_MAX + 5 }, (_, i) => ({ from: new Date(i * 1000).toISOString(), to: new Date(i * 1000 + 500).toISOString() }));
    const kept = readPauses(many);
    expect(kept).toHaveLength(PAUSES_MAX);
    expect(kept[0].from.getTime()).toBe(5000);
  });
});


// Review of be8511218 (HIGH): closing the room stops the recording; the sweep finishes it after a grace.
describe("finishesAfterRoomClosed", () => {
  const now = new Date("2026-12-01T12:00:00Z");
  const stoppedAgo = (ms: number) => new Date(now.getTime() - ms);
  const closed = { status: "PAUSED" as const, stoppedAt: stoppedAgo(ROOM_CLOSED_FINISH_GRACE_MS), sessionStatus: "COMPLETED" };

  it("finishes a stopped recording once its room has been closed for the grace", () => {
    expect(finishesAfterRoomClosed(closed, now)).toBe(true);
    expect(finishesAfterRoomClosed({ ...closed, stoppedAt: stoppedAgo(ROOM_CLOSED_FINISH_GRACE_MS - 1) }, now)).toBe(false);
  });

  it("not when the room was opened again, or closed as a rehearsal", () => {
    expect(finishesAfterRoomClosed({ ...closed, sessionStatus: "LIVE" }, now)).toBe(false);
    expect(finishesAfterRoomClosed({ ...closed, sessionStatus: "SCHEDULED" }, now)).toBe(false);
  });

  it("not a recording someone started again, or one already finished", () => {
    expect(finishesAfterRoomClosed({ ...closed, status: "RECORDING" }, now)).toBe(false);
    expect(finishesAfterRoomClosed({ ...closed, status: "FINISHING" }, now)).toBe(false);
    expect(finishesAfterRoomClosed({ ...closed, stoppedAt: null }, now)).toBe(false);
  });
});
