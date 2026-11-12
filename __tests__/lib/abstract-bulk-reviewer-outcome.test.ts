/**
 * The result line of a bulk reviewer change (Nov 12, 2026): how many were
 * assigned, how many already were, and WHICH were skipped and why, in words.
 */
import { describe, it, expect } from "vitest";
import {
  assignHeadline,
  describeBulkReviewerSkips,
  unassignHeadline,
  type BulkReviewerSkipRow,
} from "@/lib/abstract-bulk-reviewer-outcome";

const SERIALS: Record<string, number> = { ab12: 12, ab3: 3, ab40: 40 };
const NAMES: Record<string, string> = { u1: "Aisha Rahman", u2: "Omar Haddad" };
const lookups = {
  abstractSerial: (id: string) => SERIALS[id],
  reviewerName: (id: string) => NAMES[id],
};

describe("headlines", () => {
  it("says only what happened", () => {
    expect(assignHeadline({ assigned: 340, alreadyAssigned: 0, skipped: [] })).toBe("340 new assignments.");
    expect(assignHeadline({ assigned: 1, alreadyAssigned: 1, skipped: [{}] })).toBe("1 new assignment. 1 was already assigned. 1 skipped.");
    expect(assignHeadline({ assigned: 0, alreadyAssigned: 6, skipped: [] })).toBe("0 new assignments. 6 were already assigned.");
    expect(unassignHeadline({ removed: 12, notAssigned: 3, skipped: [{}] })).toBe(
      "Removed 12 assignments. 3 were not assigned in the first place. 1 kept.",
    );
    expect(unassignHeadline({ removed: 1, notAssigned: 0, skipped: [] })).toBe("Removed 1 assignment.");
  });
});

describe("describeBulkReviewerSkips", () => {
  it("one line per reason, naming the abstract, the person, or both, as the reason concerns", () => {
    const skipped: BulkReviewerSkipRow[] = [
      { abstractId: "ab40", reviewerUserId: "u1", reason: "NOT_REVIEWABLE" },
      { abstractId: "ab40", reviewerUserId: "u2", reason: "NOT_REVIEWABLE" },
      { abstractId: "ab12", reviewerUserId: "u1", reason: "OWN_ABSTRACT" },
      { abstractId: "ab3", reviewerUserId: "u2", reason: "NOT_ON_POOL" },
      { abstractId: "ab12", reviewerUserId: "u2", reason: "NOT_ON_POOL" },
    ];
    const lines = describeBulkReviewerSkips(skipped, lookups);
    expect(lines.map((l) => [l.reason, l.count, l.items])).toEqual([
      ["OWN_ABSTRACT", 1, ["A-012 (Aisha Rahman)"]],
      // The abstract is the reason: named once, however many reviewers it was skipped for.
      ["NOT_REVIEWABLE", 2, ["A-040"]],
      // The person is the reason: named once, however many abstracts.
      ["NOT_ON_POOL", 2, ["Omar Haddad"]],
    ]);
  });

  it("a kept assignment names both the abstract and the reviewer", () => {
    const lines = describeBulkReviewerSkips([{ abstractId: "ab3", reviewerUserId: "u2", reason: "HAS_REVIEW" }], lookups);
    expect(lines[0]).toMatchObject({ label: "Review already submitted, so the assignment was kept", items: ["A-003 (Omar Haddad)"] });
  });

  it("caps a long list and counts the rest", () => {
    const many: BulkReviewerSkipRow[] = Array.from({ length: 55 }, (_, i) => ({ abstractId: `x${i}`, reviewerUserId: "u1", reason: "OWN_ABSTRACT" }));
    const line = describeBulkReviewerSkips(many, { abstractSerial: (id) => Number(id.slice(1)) + 1, reviewerName: () => "Aisha Rahman" })[0];
    expect(line.count).toBe(55);
    expect(line.items).toHaveLength(40);
    expect(line.more).toBe(15);
  });

  it("nothing skipped is no lines", () => {
    expect(describeBulkReviewerSkips([], lookups)).toEqual([]);
  });
});
