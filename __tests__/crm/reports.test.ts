/**
 * CRM report math.
 *
 * The one non-obvious rule: a REDACTED value (null, because the caller may not see
 * money) must stay null through every aggregation — never silently become 0. A
 * report that shows "$0 pipeline" to a MEMBER because it coerced nulls is lying;
 * it must show "—". These tests pin that.
 */
import { describe, it, expect } from "vitest";
import {
  sumValues,
  summarizePipeline,
  computeWinLoss,
  sortReps,
  foldMoney,
  bucketDeals,
  parseReportDimension,
  isLostOnlyDimension,
  NONE_KEY,
  CRM_REPORT_DIMENSIONS,
  type BreakdownDealRow,
} from "@/crm/lib/reports";

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

// ── Breakdown by one dimension ───────────────────────────────────────────────

/** A deal row fixture: open, USD 100, nothing set unless overridden. */
function deal(over: Partial<BreakdownDealRow>): BreakdownDealRow {
  return {
    status: "OPEN",
    currency: "USD",
    dealValue: 100,
    pipeline: null,
    ownerId: null,
    eventId: null,
    dealTypeId: null,
    lostReason: null,
    expectedClose: null,
    wonAt: null,
    lostAt: null,
    ...over,
  };
}

const SEE = { canSeeValues: true };

describe("parseReportDimension", () => {
  it("accepts every dimension and nothing else", () => {
    for (const d of CRM_REPORT_DIMENSIONS) expect(parseReportDimension(d)).toBe(d);
    expect(parseReportDimension("stage")).toBeNull();
    expect(parseReportDimension("Pipeline")).toBeNull();
    expect(parseReportDimension("")).toBeNull();
    expect(parseReportDimension(null)).toBeNull();
  });

  it("only the lost-reason view is lost-only", () => {
    expect(isLostOnlyDimension("lostReason")).toBe(true);
    expect(isLostOnlyDimension("pipeline")).toBe(false);
  });
});

describe("bucketDeals — categorical dimensions", () => {
  const rows = [
    deal({ pipeline: "CORPORATE", status: "OPEN", dealValue: 100 }),
    deal({ pipeline: "CORPORATE", status: "WON", dealValue: 50, wonAt: new Date("2026-08-02T10:00:00Z") }),
    deal({ pipeline: "CONFERENCE", status: "LOST", currency: "AED", dealValue: 30, lostAt: new Date("2026-09-01T10:00:00Z") }),
    deal({ pipeline: null, status: "OPEN", dealValue: 7 }),
  ];
  const labels = { pipeline: new Map([["CORPORATE", "Corporate"], ["CONFERENCE", "Conference"]]) };

  it("groups by pipeline with per-status counts, values and a win rate per bucket", () => {
    const out = bucketDeals(rows, "pipeline", { ...SEE, labels });
    expect(out.map((r) => r.label)).toEqual(["Corporate", "Conference", "No pipeline"]);
    const corp = out[0]!;
    expect(corp).toMatchObject({ totalCount: 2, openCount: 1, openValue: 100, openCurrency: "USD", wonCount: 1, wonValue: 50, lostCount: 0, winRate: 100 });
    const conf = out[1]!;
    expect(conf).toMatchObject({ totalCount: 1, lostCount: 1, lostValue: 30, lostCurrency: "AED", winRate: 0 });
    // Nothing in the "not set" bucket has closed → no rate, not 0%.
    expect(out[2]).toMatchObject({ key: NONE_KEY, openCount: 1, winRate: null });
  });

  it("orders by deal count, then label, and keeps 'not set' last even when it is the biggest", () => {
    const many = [deal({}), deal({}), deal({}), deal({ pipeline: "CONFERENCE" }), deal({ pipeline: "CORPORATE" })];
    const out = bucketDeals(many, "pipeline", { ...SEE, labels });
    expect(out.map((r) => r.label)).toEqual(["Conference", "Corporate", "No pipeline"]);
  });

  it("resolves owner names, labels the unassigned, and never guesses an unknown id", () => {
    const out = bucketDeals(
      [deal({ ownerId: "u1" }), deal({ ownerId: "u1" }), deal({ ownerId: "ghost" }), deal({})],
      "owner",
      { ...SEE, labels: { owner: new Map([["u1", "Ada Lovelace"]]) } },
    );
    expect(out.map((r) => r.label)).toEqual(["Ada Lovelace", "(unknown)", "Unassigned"]);
  });

  it("labels events and deal types the same way", () => {
    // Two deals on the named one so the count, not the label, decides the order.
    const ev = bucketDeals([deal({ eventId: "e1" }), deal({ eventId: "e1" }), deal({ eventId: "e9" }), deal({})], "event", {
      ...SEE,
      labels: { event: new Map([["e1", "HEMNET 2026"]]) },
    });
    expect(ev.map((r) => r.label)).toEqual(["HEMNET 2026", "(unknown event)", "No event"]);
    const dt = bucketDeals([deal({ dealTypeId: "t1" }), deal({ dealTypeId: "t1" }), deal({ dealTypeId: "t9" }), deal({})], "dealType", {
      ...SEE,
      labels: { dealType: new Map([["t1", "Sponsorship"]]) },
    });
    expect(dt.map((r) => r.label)).toEqual(["Sponsorship", "(unknown type)", "No deal type"]);
  });

  it("a bucket mixing currencies reports mixed, never a summed number (H2)", () => {
    const out = bucketDeals(
      [deal({ pipeline: "CORPORATE", currency: "USD", dealValue: 50000 }), deal({ pipeline: "CORPORATE", currency: "AED", dealValue: 500000 })],
      "pipeline",
      { ...SEE, labels },
    );
    expect(out[0]).toMatchObject({ openCount: 2, openValue: null, openCurrency: null, openMixed: true });
  });

  it("redacts every value for a caller who may not see money, keeping the counts", () => {
    const out = bucketDeals(rows, "pipeline", { canSeeValues: false, labels });
    for (const r of out) {
      expect([r.openValue, r.wonValue, r.lostValue]).toEqual([null, null, null]);
      expect([r.openCurrency, r.wonCurrency, r.lostCurrency]).toEqual([null, null, null]);
      expect([r.openMixed, r.wonMixed, r.lostMixed]).toEqual([false, false, false]);
    }
    expect(out[0]).toMatchObject({ totalCount: 2, openCount: 1, wonCount: 1, winRate: 100 });
  });
});

describe("bucketDeals — lost reason", () => {
  it("counts LOST deals only; open and won deals never land in a 'no reason' bucket", () => {
    const out = bucketDeals(
      [
        deal({ status: "LOST", lostReason: "Budget" }),
        deal({ status: "LOST", lostReason: "  Budget " }),
        deal({ status: "LOST", lostReason: "" }),
        deal({ status: "OPEN" }),
        deal({ status: "WON" }),
      ],
      "lostReason",
      SEE,
    );
    expect(out.map((r) => [r.label, r.lostCount, r.totalCount])).toEqual([
      ["Budget", 2, 2],
      ["No reason given", 1, 1],
    ]);
    expect(out.every((r) => r.openCount === 0 && r.wonCount === 0)).toBe(true);
  });
});

describe("bucketDeals — month dimensions", () => {
  it("buckets expected close by UTC month, ascending, with undated deals last", () => {
    const out = bucketDeals(
      [
        deal({ expectedClose: new Date("2026-11-15T09:00:00Z") }),
        deal({ expectedClose: new Date("2026-09-03T09:00:00Z") }),
        // 22:00Z on Sep 30 is already October in Dubai; the date FILTERS cut at
        // UTC day boundaries, so the bucket must agree with them: September.
        deal({ expectedClose: new Date("2026-09-30T22:00:00Z") }),
        deal({ expectedClose: null }),
      ],
      "expectedCloseMonth",
      SEE,
    );
    expect(out.map((r) => [r.key, r.label, r.totalCount])).toEqual([
      ["2026-09", "Sep 2026", 2],
      ["2026-11", "Nov 2026", 1],
      [NONE_KEY, "No expected close", 1],
    ]);
  });

  it("buckets closed deals by the month they closed, and leaves open deals out", () => {
    const out = bucketDeals(
      [
        deal({ status: "WON", wonAt: new Date("2026-07-20T00:00:00Z"), dealValue: 10 }),
        deal({ status: "LOST", lostAt: new Date("2026-07-05T00:00:00Z"), dealValue: 20 }),
        deal({ status: "WON", wonAt: new Date("2026-08-01T00:00:00Z"), dealValue: 30 }),
        deal({ status: "OPEN", expectedClose: new Date("2026-07-01T00:00:00Z") }),
      ],
      "closedMonth",
      SEE,
    );
    expect(out.map((r) => [r.label, r.wonCount, r.lostCount, r.winRate])).toEqual([
      ["Jul 2026", 1, 1, 50],
      ["Aug 2026", 1, 0, 100],
    ]);
    expect(out.reduce((n, r) => n + r.totalCount, 0)).toBe(3);
  });
});
