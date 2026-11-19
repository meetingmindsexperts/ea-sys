/**
 * The words the bulk status dialog shows after a change (Nov 19, 2026). It
 * must NAME what was skipped, by reason, or the organiser has 165 rows to
 * hunt through.
 */
import { describe, it, expect } from "vitest";
import { describeBulkUpdate, unfinishedIds, type BulkUpdateTotals } from "@/lib/abstract-bulk-update-outcome";

const totals = (over: Partial<BulkUpdateTotals> = {}): BulkUpdateTotals => ({
  changed: [], unchanged: [], skipped: [], remaining: [], emailed: 0, emailFailed: 0, interrupted: null, ...over,
});
const numberOf = (id: string) => `A-${id}`;

describe("describeBulkUpdate", () => {
  it("a clean change is a success with nothing more to say", () => {
    expect(describeBulkUpdate(totals({ changed: ["1", "2"] }), numberOf)).toEqual({ level: "success", headline: "2 abstracts updated", lines: [] });
    expect(describeBulkUpdate(totals({ changed: ["1"] }), numberOf).headline).toBe("1 abstract updated");
  });

  it("names the skipped abstracts under each reason", () => {
    const report = describeBulkUpdate(
      totals({
        changed: ["1"],
        unchanged: ["9"],
        skipped: [
          { abstractId: "3", code: "INSUFFICIENT_REVIEWS" },
          { abstractId: "4", code: "ABSTRACT_WITHDRAWN" },
          { abstractId: "5", code: "INSUFFICIENT_REVIEWS" },
          { abstractId: "6", code: "SOMETHING_NEW" },
        ],
      }),
      numberOf,
    );
    expect(report.level).toBe("warning");
    expect(report.lines).toEqual([
      "1 was already as chosen, so nothing changed for it.",
      "Not enough scored reviews yet (2): A-3, A-5",
      "Withdrawn, which cannot be undone (1): A-4",
      "Could not be changed (1): A-6",
    ]);
  });

  it("says who was emailed, which emails failed and that a change stopped part-way", () => {
    const report = describeBulkUpdate(totals({ changed: ["1", "2", "3"], emailed: 2, emailFailed: 1, interrupted: "Bad gateway", remaining: ["7", "8"] }), numberOf);
    expect(report.level).toBe("warning");
    expect(report.lines).toEqual([
      "2 authors were emailed the decision.",
      "1 decision email could not be sent. The status changed all the same: resend from Communications.",
      "The change stopped before the end (Bad gateway). 2 abstracts were not reached.",
    ]);
  });

  it("nothing changed is said plainly, and a long list is cut with a count", () => {
    const many = Array.from({ length: 34 }, (_, i) => ({ abstractId: String(i + 1), code: "INSUFFICIENT_REVIEWS" }));
    const report = describeBulkUpdate(totals({ skipped: many }), numberOf);
    expect(report.headline).toBe("Nothing was changed");
    expect(report.lines[0]).toContain("A-30 and 4 more");
    expect(report.lines[0]).not.toContain("A-31");
  });
});

describe("unfinishedIds", () => {
  it("is what was skipped and what was not reached: the rows worth keeping ticked", () => {
    expect(unfinishedIds(totals({ changed: ["1"], unchanged: ["2"], skipped: [{ abstractId: "3", code: "x" }], remaining: ["4"] }))).toEqual(["3", "4"]);
  });
});
