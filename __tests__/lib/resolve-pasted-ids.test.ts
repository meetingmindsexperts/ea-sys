/**
 * "Select by IDs" resolver — paste a CSV column of identifiers and select those
 * registrations for bulk email / tag / change-type. A token matches the full
 * id, the padded serial ("002"), the raw serial ("2"), or the attendee email.
 */
import { describe, it, expect } from "vitest";
import { resolvePastedIds } from "@/app/(dashboard)/events/[eventId]/registrations/resolve-pasted-ids";

const rows = [
  { id: "cuid_aaa", serialId: 2, attendee: { email: "Jane@Example.com" } },
  { id: "cuid_bbb", serialId: 5, attendee: { email: "bob@x.test" } },
  { id: "cuid_ccc", serialId: 12, attendee: { email: null } },
  { id: "cuid_ddd", serialId: null, attendee: { email: "noserial@x.test" } },
];

describe("resolvePastedIds", () => {
  it("matches padded serials ('002') and raw serials ('5')", () => {
    expect(resolvePastedIds("002\n5", rows).matched).toEqual(["cuid_aaa", "cuid_bbb"]);
  });

  it("matches full ids and emails (case-insensitive)", () => {
    const r = resolvePastedIds("cuid_ccc, JANE@example.com", rows);
    expect(r.matched).toEqual(["cuid_ccc", "cuid_aaa"]);
    expect(r.unmatched).toEqual([]);
  });

  it("splits on newlines, commas, semicolons, and whitespace", () => {
    const r = resolvePastedIds("002, 005;012\n5", rows);
    // 002→aaa, 005→bbb, 012→ccc, 5→bbb (dup) → [aaa, bbb, ccc]
    expect(r.matched).toEqual(["cuid_aaa", "cuid_bbb", "cuid_ccc"]);
  });

  it("de-dupes matched ids in first-seen order", () => {
    const r = resolvePastedIds("5 005 bob@x.test cuid_bbb", rows);
    expect(r.matched).toEqual(["cuid_bbb"]);
  });

  it("reports tokens that match nothing", () => {
    const r = resolvePastedIds("002, 999, ghost@x.test, cuid_zzz", rows);
    expect(r.matched).toEqual(["cuid_aaa"]);
    expect(r.unmatched).toEqual(["999", "ghost@x.test", "cuid_zzz"]);
  });

  it("matches an email-only row with no serial", () => {
    expect(resolvePastedIds("noserial@x.test", rows).matched).toEqual(["cuid_ddd"]);
  });

  it("handles empty / whitespace input", () => {
    expect(resolvePastedIds("", rows)).toEqual({ matched: [], unmatched: [] });
    expect(resolvePastedIds("   \n  ", rows)).toEqual({ matched: [], unmatched: [] });
  });
});
