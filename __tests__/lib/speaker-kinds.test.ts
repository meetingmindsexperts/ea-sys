/**
 * The Speakers page tabs (owner, Oct 27) and who "Email" reaches from them (review HIGHs, Oct 27).
 */
import { describe, it, expect } from "vitest";
import { canEmailListed, emailRecipientIds, isSubmitter, matchesKind } from "@/lib/speaker-kinds";

const invited = { id: "a", _count: { abstracts: 0 } };
const submitter = { id: "b", _count: { abstracts: 2 } };

describe("speaker kinds", () => {
  it("a speaker with an abstract is a submitter; the tabs split on that", () => {
    expect(isSubmitter(submitter)).toBe(true);
    expect(isSubmitter(invited)).toBe(false);
    expect([invited, submitter].filter((s) => matchesKind(s, "invited")).map((s) => s.id)).toEqual(["a"]);
    expect([invited, submitter].filter((s) => matchesKind(s, "submitters")).map((s) => s.id)).toEqual(["b"]);
    expect([invited, submitter].filter((s) => matchesKind(s, "all"))).toHaveLength(2);
  });
});

describe("who Email reaches", () => {
  it("ticked speakers first, else everyone listed on a tab, else the status-wide audience (no ids)", () => {
    expect(emailRecipientIds(new Set(["x"]), true, [invited])).toEqual(["x"]);
    expect(emailRecipientIds(new Set(), true, [invited, submitter])).toEqual(["a", "b"]);
    expect(emailRecipientIds(new Set(), false, [invited, submitter])).toEqual([]);
  });

  it("offers no send from an empty tab, where no ids would mean every speaker of the status", () => {
    expect(canEmailListed(0, true, 0, 136)).toBe(false);
    expect(canEmailListed(0, true, 3, 136)).toBe(true);
    expect(canEmailListed(2, true, 0, 136)).toBe(true);
    expect(canEmailListed(0, false, 0, 136)).toBe(true);
    expect(canEmailListed(0, false, 0, 0)).toBe(false);
  });
});
