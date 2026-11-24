/**
 * The pieces a recording is made of, as the stream server leaves them (Nov 24,
 * 2026; docs/PARTNER_STREAM_RECORDING_PLAN.md §4.2). Names, times and rules
 * are from pieces a real MediaMTX 1.17.1 wrote on the throwaway server.
 */
import { describe, it, expect } from "vitest";
import { BREAK_AFTER_MS, finishedPieces, PIECE_SETTLED_MS, pieceStart, pieceWanted, startsBreak } from "@/lib/webinar/recording-pieces";

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
  const base = { lastStartedAt: t(0), stoppedAt: null, finishedAt: null };

  it("everything recorded while recording, with nothing paused in between", () => {
    expect(pieceWanted({ ...base, status: "RECORDING" }, t(30))).toBe(true);
  });

  it("not a piece begun after a Stop, while it is still stopped", () => {
    const paused = { ...base, status: "PAUSED" as const, stoppedAt: t(20) };
    expect(pieceWanted(paused, t(19))).toBe(true);
    expect(pieceWanted(paused, new Date(t(20).getTime() + 1_000))).toBe(true);
    expect(pieceWanted(paused, t(21))).toBe(false);
  });

  it("not a piece begun inside the last pause of a recording started again", () => {
    const resumed = { status: "RECORDING" as const, stoppedAt: t(20), lastStartedAt: t(30), finishedAt: null };
    expect(pieceWanted(resumed, t(25))).toBe(false);
    expect(pieceWanted(resumed, t(10))).toBe(true);
    expect(pieceWanted(resumed, t(31))).toBe(true);
  });

  it("not a piece begun after the recording was finished", () => {
    const finished = { ...base, status: "FINISHING" as const, stoppedAt: t(50), finishedAt: t(50) };
    expect(pieceWanted(finished, t(49))).toBe(true);
    expect(pieceWanted(finished, t(51))).toBe(false);
  });

  it("a Stop from before the last Start does not make a recording that is running unwanted", () => {
    const running = { status: "RECORDING" as const, stoppedAt: t(20), lastStartedAt: t(10), finishedAt: null };
    expect(pieceWanted(running, t(25))).toBe(true);
  });
});
