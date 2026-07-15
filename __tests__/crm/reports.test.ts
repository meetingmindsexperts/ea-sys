/**
 * CRM report math.
 *
 * The one non-obvious rule: a REDACTED value (null, because the caller may not see
 * money) must stay null through every aggregation — never silently become 0. A
 * report that shows "$0 pipeline" to a MEMBER because it coerced nulls is lying;
 * it must show "—". These tests pin that.
 */
import { describe, it, expect } from "vitest";
import { sumValues, summarizePipeline, computeWinLoss, sortReps } from "@/crm/lib/reports";

describe("sumValues — nulls are redaction, not zero", () => {
  it("sums visible numbers", () => {
    expect(sumValues([10, 20, 30])).toBe(60);
  });

  it("returns null when everything is null (money redacted)", () => {
    expect(sumValues([null, null])).toBeNull();
  });

  it("treats a mix as visible-sum (partial data), not null", () => {
    // Some deals have a value, some are genuinely value-less (not redacted) — sum
    // what's there. Redaction is all-or-nothing per caller, so a mix means real
    // nulls, not hidden ones.
    expect(sumValues([10, null, 5])).toBe(15);
  });

  it("empty list is 0, not null", () => {
    expect(sumValues([])).toBe(0);
  });
});

describe("summarizePipeline", () => {
  const stages = [
    { stageId: "s1", stageName: "Prospect", isTerminal: false, count: 3, value: 300 },
    { stageId: "s2", stageName: "Negotiation", isTerminal: false, count: 2, value: 5000 },
    { stageId: "s3", stageName: "Won", isTerminal: true, count: 4, value: 40000 },
  ];

  it("open count/value exclude terminal stages", () => {
    const p = summarizePipeline(stages);
    expect(p.openCount).toBe(5); // 3 + 2, not the 4 won
    expect(p.openValue).toBe(5300); // 300 + 5000, not the 40000 won
  });

  it("openValue is null when values are redacted", () => {
    const redacted = stages.map((s) => ({ ...s, value: null }));
    expect(summarizePipeline(redacted).openValue).toBeNull();
  });
});

describe("computeWinLoss", () => {
  it("computes an integer win rate", () => {
    const w = computeWinLoss({ wonCount: 3, lostCount: 1, wonValue: 100, lostValue: 20 });
    expect(w.winRate).toBe(75);
  });

  it("rounds", () => {
    expect(computeWinLoss({ wonCount: 1, lostCount: 2, wonValue: null, lostValue: null }).winRate).toBe(33);
  });

  it("null win rate when nothing has closed (no divide-by-zero)", () => {
    expect(computeWinLoss({ wonCount: 0, lostCount: 0, wonValue: 0, lostValue: 0 }).winRate).toBeNull();
  });
});

describe("sortReps — leaderboard by won value", () => {
  it("orders by won value desc, nulls last", () => {
    const rows = [
      { ownerId: "a", ownerName: "A", openCount: 0, openValue: 0, wonCount: 1, wonValue: 100 },
      { ownerId: "b", ownerName: "B", openCount: 0, openValue: 0, wonCount: 5, wonValue: 900 },
      { ownerId: "c", ownerName: "C", openCount: 0, openValue: null, wonCount: 2, wonValue: null },
    ];
    const sorted = sortReps(rows).map((r) => r.ownerName);
    expect(sorted).toEqual(["B", "A", "C"]); // 900, 100, then the redacted/null one last
  });

  it("breaks ties on won count", () => {
    const rows = [
      { ownerId: "a", ownerName: "A", openCount: 0, openValue: 0, wonCount: 1, wonValue: 500 },
      { ownerId: "b", ownerName: "B", openCount: 0, openValue: 0, wonCount: 9, wonValue: 500 },
    ];
    expect(sortReps(rows)[0].ownerName).toBe("B");
  });
});
