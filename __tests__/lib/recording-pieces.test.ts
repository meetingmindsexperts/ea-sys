/**
 * The pieces a recording is made of, as the stream server leaves them (Nov 24,
 * 2026; docs/PARTNER_STREAM_RECORDING_PLAN.md §4.2). Names, times and rules
 * are from pieces a real MediaMTX 1.17.1 wrote on the throwaway server.
 */
import { describe, it, expect } from "vitest";
import {
  BREAK_AFTER_MS,
  FALLBACK_PIECE_MAX_MS,
  fallbackPieceMs,
  finishedPieces,
  PIECE_SETTLED_MS,
  pieceStart,
  pieceWanted,
  startsBreak,
} from "@/lib/webinar/recording-pieces";

describe("pieceStart", () => {
  it("reads the start from the name, and writes it exactly as the stream server's API does", () => {
    // The pair seen on the throwaway server: the file 1795512296-718063.ts was listed as this start.
    const start = pieceStart("1795512296-718063.ts");
    expect(start?.iso).toBe("2026-11-24T09:24:56.718063Z");
    expect(start?.at.toISOString()).toBe("2026-11-24T09:24:56.718Z");
  });

  it("keeps leading zeros in the microseconds (the delete is refused without them)", () => {
    expect(pieceStart("1795512296-000042.ts")?.iso).toBe("2026-11-24T09:24:56.000042Z");
  });

  it.each(["1795512296-718063.mp4", "1795512296.ts", "abc-718063.ts", "../1795512296-718063.ts", "2026-11-24_08-42-29-483623.ts", ""])(
    "%j is not a piece",
    (name) => {
      expect(pieceStart(name)).toBeNull();
    },
  );
});

describe("finishedPieces", () => {
  const now = new Date("2026-11-24T09:30:00Z");
  const file = (name: string, ageMs: number) => ({ name, bytes: 2_000_000, modifiedAt: new Date(now.getTime() - ageMs) });

  it("every piece but the newest, oldest first, while the newest is still being written", () => {
    const files = [file("1795512302-614902.ts", 30_000), file("1795512308-519732.ts", 1_000), file("1795512296-718063.ts", 40_000)];
    expect(finishedPieces(files, now).map((f) => f.name)).toEqual(["1795512296-718063.ts", "1795512302-614902.ts"]);
  });

  it("the newest too, once it has not changed for a while: the stream or the recording stopped", () => {
    const files = [file("1795512296-718063.ts", 60_000), file("1795512302-614902.ts", PIECE_SETTLED_MS)];
    expect(finishedPieces(files, now)).toHaveLength(2);
    expect(finishedPieces([file("1795512302-614902.ts", PIECE_SETTLED_MS - 1)], now)).toEqual([]);
  });

  it("orders by the time in the name, not by the text", () => {
    const files = [file("999999999-000000.ts", 60_000), file("1000000000-000000.ts", 60_000)];
    expect(finishedPieces(files, now).map((f) => f.name)).toEqual(["999999999-000000.ts", "1000000000-000000.ts"]);
  });

  // Review of 9592d2151: a sender that stalls without disconnecting leaves the open piece unchanged.
  it("never the newest while the stream is live and recording, however long it has not changed", () => {
    const files = [file("1795512296-718063.ts", 60_000), file("1795512302-614902.ts", 60_000)];
    expect(finishedPieces(files, now, { newestMayBeOpen: true }).map((f) => f.name)).toEqual(["1795512296-718063.ts"]);
  });

  it("leaves out anything that is not a piece", () => {
    expect(finishedPieces([file("notes.txt", 60_000), file(".DS_Store", 60_000)], now)).toEqual([]);
  });
});

describe("startsBreak", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 24, 9, 0, 0) + s * 1000);

  it("a piece that starts where the last ended follows on", () => {
    expect(startsBreak({ startedAt: at(0), durationMs: 6064 }, at(6.064))).toBe(false);
    expect(startsBreak({ startedAt: at(0), durationMs: 6064 }, new Date(at(6.064).getTime() + BREAK_AFTER_MS))).toBe(false);
  });

  // Seen on the throwaway server: a 1.3 second piece before a stop, the next 13.4 seconds after it began.
  it("a piece after a stop or a drop starts a break", () => {
    expect(startsBreak({ startedAt: at(0), durationMs: 1297 }, at(13.4))).toBe(true);
  });

  it("the first piece follows nothing", () => {
    expect(startsBreak(null, at(0))).toBe(false);
  });
});

describe("pieceWanted", () => {
  const t = (m: number) => new Date(Date.UTC(2026, 10, 24, 9, m, 0));
  const rec = (extra: Partial<{ startedAt: Date; finishedAt: Date | null; pauses: { from: Date; to: Date | null }[] }> = {}) => ({
    startedAt: t(0),
    finishedAt: null,
    pauses: [],
    ...extra,
  });

  it("everything recorded while recording, with nothing paused", () => {
    expect(pieceWanted(rec(), t(30))).toBe(true);
  });

  it("not a piece begun inside an open pause (stopped, not started again)", () => {
    const paused = rec({ pauses: [{ from: t(20), to: null }] });
    expect(pieceWanted(paused, t(19))).toBe(true);
    expect(pieceWanted(paused, new Date(t(20).getTime() + 1_000))).toBe(true);
    expect(pieceWanted(paused, t(21))).toBe(false);
    expect(pieceWanted(paused, t(59))).toBe(false);
  });

  it("not a piece begun inside a pause that has ended; what came after it is wanted again", () => {
    const resumed = rec({ pauses: [{ from: t(20), to: t(30) }] });
    expect(pieceWanted(resumed, t(25))).toBe(false);
    expect(pieceWanted(resumed, t(10))).toBe(true);
    expect(pieceWanted(resumed, t(31))).toBe(true);
  });

  // Review of 9592d2151: with only the last pause known, an earlier pause's footage became wanted after a later Stop.
  it("EVERY pause counts, not only the last", () => {
    const twice = rec({ pauses: [{ from: t(10), to: t(20) }, { from: t(40), to: null }] });
    expect(pieceWanted(twice, t(15))).toBe(false);
    expect(pieceWanted(twice, t(30))).toBe(true);
    expect(pieceWanted(twice, t(45))).toBe(false);
  });

  it("not a piece begun after the recording was finished", () => {
    const finished = rec({ finishedAt: t(50) });
    expect(pieceWanted(finished, t(49))).toBe(true);
    expect(pieceWanted(finished, t(51))).toBe(false);
  });

  // Review of 9592d2151: a Finish after a Stop forgot the pause, and its footage was shipped.
  it("finished while paused: the pause still runs to the end", () => {
    const finishedPaused = rec({ finishedAt: t(50), pauses: [{ from: t(20), to: null }] });
    expect(pieceWanted(finishedPaused, t(30))).toBe(false);
    expect(pieceWanted(finishedPaused, t(19))).toBe(true);
  });

  it("not a piece older than the recording itself: a leftover under the same key", () => {
    const late = rec({ startedAt: t(30) });
    expect(pieceWanted(late, t(10))).toBe(false);
    expect(pieceWanted(late, t(31))).toBe(true);
  });
});

describe("fallbackPieceMs", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 24, 9, 0, 0) + s * 1000);
  it("the gap to the next piece, at most ten seconds; nothing without a next piece", () => {
    expect(fallbackPieceMs(at(0), at(6))).toBe(6000);
    expect(fallbackPieceMs(at(0), at(40))).toBe(FALLBACK_PIECE_MAX_MS);
    expect(fallbackPieceMs(at(0), null)).toBe(0);
    expect(fallbackPieceMs(at(6), at(0))).toBe(0);
  });
});
