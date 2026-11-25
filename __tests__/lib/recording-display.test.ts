/**
 * What the console says about a partner stream's recording (Nov 25, 2026;
 * docs/PARTNER_STREAM_RECORDING_PLAN.md step 3).
 */
import { describe, it, expect } from "vitest";
import { PIECES_LATE_MS, piecesLateMinutes, recordedLength, recordedSize, recordingState } from "@/lib/webinar/recording-display";

describe("recordedLength", () => {
  it("minutes and seconds, then hours", () => {
    expect(recordedLength(0)).toBe("0:00");
    expect(recordedLength(42_900)).toBe("0:42");
    expect(recordedLength(725_000)).toBe("12:05");
    expect(recordedLength(3_729_000)).toBe("1:02:09");
    expect(recordedLength(-5)).toBe("0:00");
  });
});

describe("recordedSize", () => {
  it("MB below a GB, then GB with one decimal", () => {
    expect(recordedSize(0)).toBe("0 MB");
    expect(recordedSize(450 * 1024 * 1024)).toBe("450 MB");
    expect(recordedSize(1.25 * 1024 * 1024 * 1024)).toBe("1.3 GB");
  });
});

describe("recordingState", () => {
  it("recording with video arriving is the red REC mark", () => {
    expect(recordingState("RECORDING", "receiving", null)).toEqual({ label: "Recording", live: true, hint: null });
  });

  it("recording with no video arriving is armed, not shown as recording", () => {
    const s = recordingState("RECORDING", "not-receiving", null);
    expect(s.live).toBe(false);
    expect(s.label).toBe("Ready to record");
  });

  // Review of be8511218 (MED): a stream server that did not answer is not the calm "armed".
  it("recording with the signal not known says so, never 'Ready to record'", () => {
    const s = recordingState("RECORDING", "unknown", null);
    expect(s.label).toBe("Recording, stream not confirmed");
    expect(s.live).toBe(false);
  });

  it("a failed recording shows its error, or a fallback", () => {
    expect(recordingState("FAILED", "not-receiving", "Storage refused the file").hint).toBe("Storage refused the file");
    expect(recordingState("FAILED", "not-receiving", null).hint).toMatch(/developer/);
  });

  it("stopped, finished and ready are never live, even with video arriving", () => {
    for (const status of ["PAUSED", "FINISHING", "READY"] as const) expect(recordingState(status, "receiving", null).live).toBe(false);
  });
});

describe("piecesLateMinutes", () => {
  const now = Date.parse("2027-01-21T10:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const base = { status: "RECORDING" as const, lastStartedAt: ago(60 * 60_000), lastPieceAt: ago(PIECES_LATE_MS + 60_000) };
  const receiving = { signal: "receiving" as const, lastConnectionAt: ago(60 * 60_000) };

  it("says how late when recording, receiving and nothing new for over three minutes", () => {
    expect(piecesLateMinutes(base, receiving, now)).toBe(4);
  });

  it("nothing to say within three minutes of the newest piece", () => {
    expect(piecesLateMinutes({ ...base, lastPieceAt: ago(PIECES_LATE_MS) }, receiving, now)).toBeNull();
  });

  it("nothing to say when the partner's video is not arriving, or the recording is not running", () => {
    expect(piecesLateMinutes(base, { ...receiving, signal: "not-receiving" }, now)).toBeNull();
    expect(piecesLateMinutes({ ...base, status: "PAUSED" }, receiving, now)).toBeNull();
  });

  it("still says it when the signal is not known: the stream server may be the thing in trouble (review of be8511218)", () => {
    expect(piecesLateMinutes(base, { ...receiving, signal: "unknown" }, now)).toBe(4);
  });

  it("a recording armed an hour early is not late the moment the partner connects", () => {
    const armed = { ...base, lastPieceAt: null };
    expect(piecesLateMinutes(armed, { signal: "receiving", lastConnectionAt: ago(30_000) }, now)).toBeNull();
    expect(piecesLateMinutes(armed, { signal: "receiving", lastConnectionAt: ago(PIECES_LATE_MS + 120_000) }, now)).toBe(5);
  });

  it("counts from a later Start after a stop", () => {
    expect(piecesLateMinutes({ ...base, lastStartedAt: ago(60_000) }, receiving, now)).toBeNull();
  });
});
