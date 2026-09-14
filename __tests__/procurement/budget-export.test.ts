/**
 * The budget CSV builder is pure: a header block, one row per line in
 * sort order, then the totals; money at two decimals, an absent figure as an
 * empty cell, a description with a comma and a quote escaped, the
 * contingency line flagged, and the filename safe for a download.
 */
import { describe, it, expect } from "vitest";
import { buildBudgetCsv, budgetCsvColumns, budgetExportFilename, type ExportBudget, type ExportLine } from "@/procurement/lib/budget-export";
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

describe("budgetExportFilename", () => {
  it("keeps the code and version, replacing anything a filesystem dislikes", () => {
    expect(budgetExportFilename({ eventCode: "HM2026", versionNo: 2 })).toBe("budget-HM2026-v2.csv");
    expect(budgetExportFilename({ eventCode: 'A/B "C"', versionNo: 1 })).toBe("budget-A_B_C_-v1.csv");
  });
});
