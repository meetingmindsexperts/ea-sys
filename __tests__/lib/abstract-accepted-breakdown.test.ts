/**
 * The Accepted card's split by presentation type (owner, Nov 20, 2026).
 *
 * MUTATIONS: count every status and "only accepted abstracts" fails; drop the
 * untyped entry and "the parts add up" fails.
 */
import { describe, it, expect } from "vitest";
import { acceptedByPresentationType, NO_PRESENTATION_TYPE_LABEL } from "@/lib/abstract-accepted-breakdown";

const a = (status: string, presentationType: string | null) => ({ status, presentationType });

describe("acceptedByPresentationType", () => {
  it("counts only accepted abstracts, oral and poster apart", () => {
    const rows = [a("ACCEPTED", "ORAL"), a("ACCEPTED", "ORAL"), a("ACCEPTED", "POSTER"), a("REJECTED", "ORAL"), a("SUBMITTED", "POSTER")];
    expect(acceptedByPresentationType(rows)).toEqual([
      { type: "ORAL", label: "Oral", count: 2 },
      { type: "POSTER", label: "Poster", count: 1 },
    ]);
  });

  it("the parts add up to the accepted total: other types and abstracts with no type are listed too", () => {
    const rows = [a("ACCEPTED", "POSTER"), a("ACCEPTED", "ORAL_POSTER"), a("ACCEPTED", null), a("ACCEPTED", ""), a("ACCEPTED", "VIDEO"), a("ACCEPTED", "ORAL")];
    const out = acceptedByPresentationType(rows);
    // The picker's order, then the untyped last.
    expect(out.map((t) => `${t.label} ${t.count}`)).toEqual(["Oral 1", "Poster 1", "Oral or Poster 1", "Video 1", `${NO_PRESENTATION_TYPE_LABEL} 2`]);
    expect(out.reduce((n, t) => n + t.count, 0)).toBe(rows.length);
  });

  it("lists nothing when nothing is accepted, and keeps a type it does not know under its own name", () => {
    expect(acceptedByPresentationType([a("SUBMITTED", "ORAL")])).toEqual([]);
    expect(acceptedByPresentationType([a("ACCEPTED", "LIGHTNING")])).toEqual([{ type: "LIGHTNING", label: "LIGHTNING", count: 1 }]);
  });
});
