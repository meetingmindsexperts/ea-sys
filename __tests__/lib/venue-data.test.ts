/** What the venue may store: shaped on the server, identity from the session, never the body. */
import { describe, it, expect } from "vitest";
import { shapeActivity, shapeFilter, shapeReport } from "@/lib/venue/venue-data";
import { venueDateRange } from "@/lib/venue/date-range";

describe("shapeActivity", () => {
  it("takes the uid from the session and the name only when the person shared it", () => {
    const a = shapeActivity({ uid: "someone-else", named: false, name: "Spoofed", sessions: 3, zones: { plenary: 120.4 } }, "u-1", "Wren Writer");
    expect(a).toMatchObject({ uid: "u-1", named: false, name: "", sessions: 3, zones: { plenary: 120 } });
    expect(shapeActivity({ named: true }, "u-1", "Wren Writer")).toMatchObject({ named: true, name: "Wren Writer" });
  });

  it("drops odd keys and clamps numbers", () => {
    const a = shapeActivity({ zones: { "<script>": 5, ok: -4 }, chats: 1e12, stands: { "booth-1": { visits: 2, sec: 9.6, opens: "x" } } }, "u-1", "");
    expect(a.zones).toEqual({ ok: 0 });
    expect(a.chats).toBe(100_000);
    expect(a.stands).toEqual({ "booth-1": { visits: 2, sec: 10, opens: 0 } });
  });
});

describe("shapeReport", () => {
  it("keeps a report with one of the page's reasons; the reporter is the session's", () => {
    const r = shapeReport({ reason: "Offensive language", note: "x".repeat(700), by: "spoof", who: { name: "Lina", guest: true }, said: ["a", { t: 1, text: "b" }, { t: 2, text: "c" }, "d", { t: 3 }, "e", { text: "f" }] }, "u-1");
    expect(r).toMatchObject({ reason: "Offensive language", by: "u-1", who: { name: "Lina", guest: true } });
    expect((r!.note as string).length).toBe(600);
    // the page's `{ t, text }` objects keep their text; an entry with none is dropped (review M2)
    expect(r!.said).toEqual([{ text: "b" }, { text: "c" }, { text: "d" }, { text: "e" }, { text: "f" }]);
  });

  it("refuses an unknown reason", () => {
    expect(shapeReport({ reason: "anything" }, "u-1")).toBeNull();
  });
});

describe("shapeFilter", () => {
  it("defaults to on and masking, and caps the word lists", () => {
    expect(shapeFilter({ mode: "explode", extra: ["  bad ", 5, ""] })).toEqual({ on: true, mode: "mask", extra: ["bad"], allow: [] });
    expect(shapeFilter({ on: false, mode: "hide" })).toMatchObject({ on: false, mode: "hide" });
  });
});

describe("venueDateRange", () => {
  const d = (s: string) => new Date(s);
  it.each([
    ["2026-04-09T20:00:00Z", "2026-04-12T19:59:00Z", "10 to 12 April 2026"],
    ["2026-09-03T20:00:00Z", "2026-09-04T19:59:00Z", "4 September 2026"],
    ["2026-03-29T20:00:00Z", "2026-04-02T19:59:00Z", "30 March to 2 April 2026"],
    ["2026-12-29T20:00:00Z", "2027-01-02T19:59:00Z", "30 December 2026 to 2 January 2027"],
  ])("%s to %s in Dubai is %s", (a, b, expected) => {
    expect(venueDateRange(d(a), d(b), "Asia/Dubai")).toBe(expected);
  });
});
