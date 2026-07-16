/**
 * CRM report math.
 *
 * The one non-obvious rule: a REDACTED value (null, because the caller may not see
 * money) must stay null through every aggregation — never silently become 0. A
 * report that shows "$0 pipeline" to a MEMBER because it coerced nulls is lying;
 * it must show "—". These tests pin that.
 */
import { describe, it, expect } from "vitest";
import { sumValues, summarizePipeline, computeWinLoss, sortReps, foldMoney } from "@/crm/lib/reports";

/** Stage fixture — single-currency USD unless overridden. */
function bucket(over: Partial<Parameters<typeof summarizePipeline>[0][number]>) {
  return {
    stageId: "s",
    stageName: "Stage",
    isTerminal: false,
    count: 0,
    value: 0,
    currency: "USD" as string | null,
    mixed: false,
    ...over,
  };
}

/** Rep fixture with the currency fields defaulted. */
function rep(over: Record<string, unknown>) {
  return {
    ownerId: "x",
    ownerName: "X",
    openCount: 0,
    openValue: 0 as number | null,
    openCurrency: "USD" as string | null,
    openMixed: false,
    wonCount: 0,
    wonValue: 0 as number | null,
    wonCurrency: "USD" as string | null,
    wonMixed: false,
    ...over,
  };
}

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
    bucket({ stageId: "s1", stageName: "Prospect", count: 3, value: 300 }),
    bucket({ stageId: "s2", stageName: "Negotiation", count: 2, value: 5000 }),
    bucket({ stageId: "s3", stageName: "Won", isTerminal: true, count: 4, value: 40000 }),
  ];

  it("open count/value exclude terminal stages", () => {
    const p = summarizePipeline(stages);
    expect(p.openCount).toBe(5); // 3 + 2, not the 4 won
    expect(p.openValue).toBe(5300); // 300 + 5000, not the 40000 won
    expect(p.openCurrency).toBe("USD");
    expect(p.openMixed).toBe(false);
  });

  it("openValue is null when values are redacted", () => {
    const redacted = stages.map((s) => ({ ...s, value: null, currency: null }));
    expect(summarizePipeline(redacted).openValue).toBeNull();
  });

  it("two open stages in DIFFERENT currencies make the open total mixed, not a fake sum (H2)", () => {
    const p = summarizePipeline([
      bucket({ stageId: "s1", count: 1, value: 500000, currency: "AED" }),
      bucket({ stageId: "s2", count: 1, value: 50000, currency: "USD" }),
    ]);
    // AED 500k + USD 50k must never render as "$550,000".
    expect(p.openValue).toBeNull();
    expect(p.openMixed).toBe(true);
  });

  it("a mixed stage bucket poisons the open total", () => {
    const p = summarizePipeline([
      bucket({ stageId: "s1", count: 2, value: null, currency: null, mixed: true }),
      bucket({ stageId: "s2", count: 1, value: 100, currency: "USD" }),
    ]);
    expect(p.openValue).toBeNull();
    expect(p.openMixed).toBe(true);
  });
});

describe("foldMoney — per-currency aggregate rows → one honest total", () => {
  it("sums a single currency and reports it", () => {
    expect(foldMoney([{ currency: "AED", amount: 100 }, { currency: "AED", amount: 50 }]))
      .toEqual({ amount: 150, currency: "AED", mixed: false });
  });

  it("refuses to sum across currencies — null + mixed", () => {
    expect(foldMoney([{ currency: "AED", amount: 500000 }, { currency: "USD", amount: 50000 }]))
      .toEqual({ amount: null, currency: null, mixed: true });
  });

  it("an empty bucket is a genuine zero (no deals), not a redaction null", () => {
    expect(foldMoney([])).toEqual({ amount: 0, currency: null, mixed: false });
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
      rep({ ownerId: "a", ownerName: "A", wonCount: 1, wonValue: 100 }),
      rep({ ownerId: "b", ownerName: "B", wonCount: 5, wonValue: 900 }),
      rep({ ownerId: "c", ownerName: "C", openValue: null, wonCount: 2, wonValue: null, wonCurrency: null }),
    ];
    const sorted = sortReps(rows).map((r) => r.ownerName);
    expect(sorted).toEqual(["B", "A", "C"]); // 900, 100, then the redacted/null one last
  });

  it("breaks ties on won count", () => {
    const rows = [
      rep({ ownerId: "a", ownerName: "A", wonCount: 1, wonValue: 500 }),
      rep({ ownerId: "b", ownerName: "B", wonCount: 9, wonValue: 500 }),
    ];
    expect(sortReps(rows)[0].ownerName).toBe("B");
  });
});
