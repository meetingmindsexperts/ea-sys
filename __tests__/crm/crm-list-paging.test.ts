/**
 * The cursor rules behind the paged CRM lists (Oct 29, 2026).
 */
import { describe, it, expect } from "vitest";
import { decodeListCursor, encodeListCursor, keysetAfter, parseSortDir } from "@/crm/lib/crm-list-paging";

describe("list cursors", () => {
  it("round-trips a keyset and an offset cursor", () => {
    const k = encodeListCursor({ m: "k", s: "name", d: "asc", v: ["O'Brien | Jr", "Ana", "c1"] });
    expect(decodeListCursor(k, "name", "asc")).toEqual({ m: "k", s: "name", d: "asc", v: ["O'Brien | Jr", "Ana", "c1"] });
    const o = encodeListCursor({ m: "o", s: "deals", d: "desc", o: 200 });
    expect(decodeListCursor(o, "deals", "desc")).toEqual({ m: "o", s: "deals", d: "desc", o: 200 });
  });

  it("refuses a cursor minted for another sort or direction, and junk", () => {
    const k = encodeListCursor({ m: "k", s: "name", d: "asc", v: ["a", "b", "c"] });
    expect(decodeListCursor(k, "score", "asc")).toBeNull();
    expect(decodeListCursor(k, "name", "desc")).toBeNull();
    expect(decodeListCursor("not-base64-json", "name", "asc")).toBeNull();
    expect(decodeListCursor(encodeListCursor({ m: "o", s: "deals", d: "asc", o: -5 }), "deals", "asc")).toBeNull();
    const objects = Buffer.from(JSON.stringify({ m: "k", s: "name", d: "asc", v: [{ $gt: 1 }] })).toString("base64url");
    expect(decodeListCursor(objects, "name", "asc")).toBeNull();
  });

  it("builds 'after this row' across every sort column, id last", () => {
    expect(keysetAfter(["lastName", "firstName", "id"], ["Doe", "Jane", "c9"], "asc")).toEqual({
      OR: [
        { lastName: { gt: "Doe" } },
        { lastName: "Doe", firstName: { gt: "Jane" } },
        { lastName: "Doe", firstName: "Jane", id: { gt: "c9" } },
      ],
    });
    expect(keysetAfter(["score", "id"], [40, "c9"], "desc")).toEqual({
      OR: [{ score: { lt: 40 } }, { score: 40, id: { lt: "c9" } }],
    });
    expect(keysetAfter(["name", "id"], ["x"], "asc")).toBeNull();
  });

  it("defaults the direction to ascending", () => {
    expect(parseSortDir("desc")).toBe("desc");
    expect(parseSortDir(null)).toBe("asc");
    expect(parseSortDir("sideways")).toBe("asc");
  });
});
