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
  serverSetting,
  type RecordingStatus,
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

  it("a recording is closed by the sweep at six hours, not before", () => {
    expect(recordingOverran(start, new Date(start.getTime() + RECORDING_MAX_MS - 1))).toBe(false);
    expect(recordingOverran(start, new Date(start.getTime() + RECORDING_MAX_MS))).toBe(true);
    expect(RECORDING_MAX_MS).toBe(6 * 60 * 60 * 1000);
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
