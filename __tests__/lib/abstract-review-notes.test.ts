/**
 * consolidateReviewNotes — the author-facing decision-email notes block.
 *
 * Review H9 (July 13, 2026): this block used to prefix each note with the
 * reviewer's NAME, so every multi-reviewer decision email broke blind review
 * — while the submissions GET deliberately stripped reviewer identity from
 * the author's dashboard view. These tests pin the anonymized format so a
 * future edit can't quietly reintroduce attribution.
 */
import { describe, it, expect, vi } from "vitest";

// abstract-review imports db for the aggregate helpers; consolidateReviewNotes
// itself is pure — mock db so the module loads without a client.
vi.mock("@/lib/db", () => ({ db: {} }));

import { consolidateReviewNotes } from "@/lib/abstract-review";

const sub = (reviewerName: string, reviewNotes: string | null) =>
  ({ reviewerName, reviewNotes }) as never;

describe("consolidateReviewNotes — anonymized for the author (H9)", () => {
  it("returns null when no submission has notes", () => {
    expect(consolidateReviewNotes([sub("Dr. A", null), sub("Dr. B", "  ")])).toBeNull();
  });

  it("a single note is returned bare (no attribution needed)", () => {
    expect(consolidateReviewNotes([sub("Dr. A", "Tighten the abstract.")])).toBe(
      "Tighten the abstract.",
    );
  });

  it("multiple notes are numbered — NEVER named", () => {
    const out = consolidateReviewNotes([
      sub("Dr. Alice Chen", "Strong methods."),
      sub("Prof. Bob Idris", null),
      sub("Dr. Carol Wu", "Discussion is thin."),
    ]);
    expect(out).toBe("— Reviewer 1:\nStrong methods.\n\n— Reviewer 2:\nDiscussion is thin.");
    // The blind-review property itself:
    expect(out).not.toContain("Alice");
    expect(out).not.toContain("Chen");
    expect(out).not.toContain("Carol");
    expect(out).not.toContain("Wu");
  });
});
