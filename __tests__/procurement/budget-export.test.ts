/**
 * The budget CSV builder is pure: a header block, one row per line in
 * sort order, then the totals; money at two decimals, an absent figure as an
 * empty cell, a description with a comma and a quote escaped, the
 * contingency line flagged, and the filename safe for a download. With
 * finance sight the revenue, planned revenue lines and margin follow; without
 * it one row says revenue was left out.
 */
import { describe, it, expect } from "vitest";
import { buildBudgetCsv, budgetCsvColumns, budgetExportFilename, type ExportBudget, type ExportLine, type ExportRevenue } from "@/procurement/lib/budget-export";
import { toCsvRow } from "@/lib/csv-escape";

function line(over: Partial<ExportLine>): ExportLine {
  return {
    lineKey: "k1",
    category: { code: "AV", name: "AV & Production" },
    product: null,
    description: "LED wall",
    qty: "2.0000",
    unitCost: "1500.0000",
    transactionCurrency: "AED",
    fxRateToReporting: "1",
    planned: "3000.0000",
    taxRatePercent: "5",
    taxAmountPlanned: "150.0000",
    approvedPlanned: null,
    committedOpen: "0.0000",
    committedTotal: "0.0000",
    actual: "0.0000",
    paid: "0.0000",
    remaining: "3000.0000",
    forecast: "3000.0000",
    forecastReason: null,
    varianceNote: null,
    notes: null,
    isContingency: false,
    sortOrder: 1,
    ...over,
  };
}

const budget: ExportBudget = {
  eventCode: "HM2026",
  versionNo: 2,
  status: "DRAFT",
  reportingCurrency: "AED",
  contingencyPercent: "10",
  contingencyAmount: "300.0000",
  plannedExpenseTotal: "3000.0000",
  taxTotalPlanned: "150.0000",
  forecastTotal: "3000.0000",
  expectedAttendance: 300,
  recordedAttendance: null,
  atRisk: false,
  naCategoryCodes: ["VENUE", "TRAVEL"],
  event: { name: "Hematology Meeting 2026" },
  lines: [
    line({ lineKey: "k9", sortOrder: 9, description: 'Contingency', isContingency: true, category: { code: "CONTINGENCY", name: "Contingency" }, planned: "300.0000", taxRatePercent: null, taxAmountPlanned: "0.0000" }),
    line({ lineKey: "k1", sortOrder: 1, description: 'Badges, "premium" lanyards', product: { sku: "500201", name: "Delegate Badges" } }),
  ],
};

describe("buildBudgetCsv", () => {
  const csv = buildBudgetCsv(budget, new Date("2026-09-14T11:00:00.000Z"));
  const rows = csv.split("\n");

  it("opens with the header block and the column row", () => {
    expect(rows[0]).toBe("Budget export");
    expect(rows[1]).toBe("Event,HM2026");
    expect(rows[2]).toBe("Event name,Hematology Meeting 2026");
    expect(rows[3]).toBe("Version,2");
    expect(rows[4]).toBe("Status,DRAFT");
    expect(rows[5]).toBe("Reporting currency,AED");
    expect(rows[6]).toBe("Contingency %,10");
    expect(rows[7]).toBe("Expected attendance,300");
    expect(rows[8]).toBe("Recorded attendance,");
    expect(rows[9]).toBe("Not applicable,VENUE; TRAVEL");
    expect(rows[10]).toBe("Exported at,2026-09-14T11:00:00.000Z");
    expect(rows[11]).toBe("");
    expect(rows[12]).toBe(toCsvRow(budgetCsvColumns("AED")));
    expect(rows[12]).toContain('"Planned (AED, ex-VAT)"');
  });

  it("lists the lines in sort order with money at two decimals, the SKU and the escaped description", () => {
    const first = rows[13];
    expect(first.startsWith("AV,AV & Production,500201,")).toBe(true);
    expect(first).toContain('"Badges, ""premium"" lanyards"');
    expect(first).toContain(",2.00,1500.00,AED,1,3000.00,5,150.00,,0.00,0.00,0.00,0.00,3000.00,3000.00,,,,");
    expect(first.endsWith(",")).toBe(true);
    const second = rows[14];
    expect(second.startsWith("CONTINGENCY,Contingency,,Contingency,")).toBe(true);
    expect(second.endsWith(",yes")).toBe(true);
  });

  it("closes with the totals block, planned plus contingency computed", () => {
    expect(rows[15]).toBe("");
    expect(rows[16]).toBe("Totals");
    expect(rows[17]).toBe('"Planned (AED, ex-VAT)",3000.00');
    expect(rows[18]).toBe("Tax (AED),150.00");
    expect(rows[19]).toBe("Contingency (10%),300.00");
    expect(rows[20]).toBe("Planned plus contingency (AED),3300.00");
    expect(rows[21]).toBe("Forecast (AED),3000.00");
    expect(rows[22]).toBe("At risk,no");
    expect(rows[23]).toBe("Lines,2");
  });

  it("never prints a gross figure: no column sums planned and tax", () => {
    expect(csv).not.toContain("3150.00");
  });

  it("copes with a budget that has no lines loaded", () => {
    const empty = buildBudgetCsv({ ...budget, lines: undefined, event: null }, new Date(0));
    expect(empty).toContain("Event name,\n");
    expect(empty).toContain("Lines,0");
  });
});

const revenue: ExportRevenue = {
  lines: [
    { lineKey: "r2", sortOrder: 2, category: { code: "430012", name: "In-House Sponsorship" }, description: "Gold sponsors", qty: "2.0000", unitAmount: "10000.0000", transactionCurrency: "USD", fxRateToReporting: "3.6725", planned: "73450.0000", notes: null },
    { lineKey: "r1", sortOrder: 1, category: { code: "430005", name: "In-House Delegate Sales" }, description: "Delegates, full rate", qty: "100.0000", unitAmount: "500.0000", transactionCurrency: "AED", fxRateToReporting: "1", planned: "50000.0000", notes: "early bird included" },
  ],
  accounts: [
    { code: "430005", name: "In-House Delegate Sales", planned: "50000.0000", actual: "12500.5000" },
    { code: "430012", name: "In-House Sponsorship", planned: "73450.0000", actual: "0.0000" },
  ],
  actuals: {
    notItemised: "-200.0000",
    noAccount: { amount: "700.0000", products: [{ productName: "Online Advertising" }, { productName: "Stage build" }] },
    notConverted: [{ from: "registrations", currency: "EUR", amount: "400.0000" }],
    total: "13000.5000",
    paidRegistrations: 25,
    wonDeals: 1,
  },
  margin: {
    plannedRevenue: "123450.0000", plannedCost: "3300.0000", plannedMargin: "120150.0000", plannedMarginPercent: "97.33",
    forecastRevenue: "123950.0000", forecastCost: "3300.0000", forecastMargin: "120650.0000", forecastMarginPercent: "97.34", belowTarget: false,
  },
  targetMarginPercent: "30",
};

describe("buildBudgetCsv revenue and margin", () => {
  const rows = buildBudgetCsv(budget, new Date(0), { revenue }).split("\n");
  const at = (label: string) => rows.indexOf(label);

  it("adds nothing after the totals when no revenue option is passed", () => {
    expect(buildBudgetCsv(budget, new Date(0))).not.toContain("Revenue");
  });

  it("lists planned and actual per income account with the gap, then what sits outside the accounts", () => {
    const start = at("Revenue");
    expect(start).toBeGreaterThan(at("Lines,2"));
    expect(rows[start + 1]).toBe('Income account,Account name,"Planned (AED, ex-VAT)","Actual (AED, ex-VAT)",Actual less planned (AED)');
    expect(rows[start + 2]).toBe("430005,In-House Delegate Sales,50000.00,12500.50,-37499.50");
    expect(rows[start + 3]).toBe("430012,In-House Sponsorship,73450.00,0.00,-73450.00");
    expect(rows[start + 4]).toBe(",Not itemised on won deals,,-200.00,");
    expect(rows[start + 5]).toBe(",Products with no income account,,700.00,Online Advertising; Stage build");
    expect(rows[start + 6]).toBe(",Total,123450.00,13000.50,");
    expect(rows[start + 7]).toBe('Counted from,"25 paid registrations, 1 won deal"');
    expect(rows[start + 8]).toBe('"Not counted, no fixed rate to AED",registrations,EUR 400.00');
  });

  it("lists the planned revenue lines in sort order", () => {
    const start = at("Planned revenue lines");
    expect(rows[start + 1]).toContain("Rate to AED");
    expect(rows[start + 2]).toBe('430005,In-House Delegate Sales,"Delegates, full rate",100.00,500.00,AED,1,50000.00,early bird included');
    expect(rows[start + 3]).toBe("430012,In-House Sponsorship,Gold sponsors,2.00,10000.00,USD,3.6725,73450.00,");
  });

  it("closes with planned and forecast margin against the target", () => {
    const start = at("Margin,Planned,Forecast");
    expect(rows[start + 1]).toBe('"Revenue (AED, ex-VAT)",123450.00,123950.00');
    expect(rows[start + 2]).toBe('"Cost (AED, ex-VAT, with contingency)",3300.00,3300.00');
    expect(rows[start + 3]).toBe("Margin (AED),120150.00,120650.00");
    expect(rows[start + 4]).toBe("Margin %,97.33,97.34");
    expect(rows[start + 5]).toBe("Target margin %,30");
    expect(rows[start + 6]).toBe("Forecast below target,no");
  });

  it("leaves the target cells empty when no target is set, and the percent empty when there is no revenue", () => {
    const none = buildBudgetCsv(budget, new Date(0), {
      revenue: { ...revenue, targetMarginPercent: null, margin: { ...revenue.margin, plannedMarginPercent: null, belowTarget: true } },
    }).split("\n");
    expect(none).toContain("Margin %,,97.34");
    expect(none).toContain("Target margin %,");
    expect(none).toContain("Forecast below target,");
  });

  it("says in one row that revenue was left out for a caller without finance sight", () => {
    const hidden = buildBudgetCsv(budget, new Date(0), { revenue: "hidden" });
    expect(hidden.trimEnd().endsWith("Revenue,Not included: revenue and margin need finance access")).toBe(true);
    expect(hidden).not.toContain("Margin");
  });
});

describe("budgetExportFilename", () => {
  it("keeps the code and version, replacing anything a filesystem dislikes", () => {
    expect(budgetExportFilename({ eventCode: "HM2026", versionNo: 2 })).toBe("budget-HM2026-v2.csv");
    expect(budgetExportFilename({ eventCode: 'A/B "C"', versionNo: 1 })).toBe("budget-A_B_C_-v1.csv");
  });
});
