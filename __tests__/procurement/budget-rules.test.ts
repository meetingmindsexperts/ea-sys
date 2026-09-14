import { describe, it, expect } from "vitest";
import { cloneLineForNewVersion, missingForSubmission, reallocationAuthority } from "@/procurement/lib/budget-rules";

const cats = [
  { id: "c-venue", code: "VENUE", depth: 0, isActive: true },
  { id: "c-fnb", code: "FNB", depth: 0, isActive: true },
  { id: "c-cont", code: "CONTINGENCY", depth: 0, isActive: true },
  { id: "c-old", code: "OLD", depth: 0, isActive: false },
  { id: "c-sub", code: "VENUE.AV", depth: 1, isActive: true },
];
const line = (categoryId: string, over: Partial<{ isContingency: boolean; deletedAt: Date | null; transactionCurrency: string; fxRateToReporting: string }> = {}) => ({
  categoryId, isContingency: false, deletedAt: null, transactionCurrency: "AED", fxRateToReporting: "1", ...over,
});
const ok = { reportingCurrency: "AED", expectedAttendance: 120, contingencyPercent: 10, naCategoryCodes: ["FNB"] };

describe("missingForSubmission (spec §6a completeness)", () => {
  it("is empty when every top-level category has a line or is marked not applicable", () => {
    expect(missingForSubmission(ok, [line("c-venue"), line("c-cont", { isContingency: true })], cats, "CONTINGENCY")).toEqual([]);
  });
  it("names each gap, ignores inactive and child categories and the contingency category, and ignores deleted lines", () => {
    const m = missingForSubmission(
      { reportingCurrency: null, expectedAttendance: 0, contingencyPercent: null, naCategoryCodes: [] },
      [line("c-venue", { deletedAt: new Date() }), line("c-cont", { isContingency: true })],
      cats,
      "CONTINGENCY",
    );
    expect(m).toEqual([
      "Reporting currency is not set.",
      "Contingency percent is not set.",
      "Expected attendance is required at submission.",
      "The budget has no lines.",
      "Category VENUE has no lines and is not marked not applicable.",
      "Category FNB has no lines and is not marked not applicable.",
    ]);
  });
  it("requires a rate on a foreign-currency line", () => {
    expect(missingForSubmission(ok, [line("c-venue", { transactionCurrency: "USD", fxRateToReporting: "0" })], cats, "CONTINGENCY")).toEqual(["A USD line has no exchange rate."]);
  });
});

describe("cloneLineForNewVersion", () => {
  it("keeps the lineKey and every figure, resets the version-scoped fields", () => {
    const c = cloneLineForNewVersion({
      lineKey: "k1", templateLineId: "t1", categoryId: "c-venue", description: "Hall", qty: "2", unitCost: "1000.5", transactionCurrency: "USD",
      fxRateToReporting: "3.6725", fxRateSource: "manual", fxRateAsOf: null, planned: "7347.0525", committedOpen: "1000", committedTotal: "1000", actual: "0", paid: "0",
      taxCode: "SR", taxRatePercent: "5", taxAmountPlanned: "367.3526", forecastFinalAmount: null, forecastReason: null, serviceStart: null, serviceEnd: null,
      notes: null, isContingency: false, sortOrder: 3,
    });
    expect(c.lineKey).toBe("k1");
    expect(c.committedOpen).toBe("1000.0000");
    expect(c.planned).toBe("7347.0525");
    expect(c.approvedPlanned).toBeNull();
    expect(c.reallocatedOut).toBe("0.0000");
  });
});

describe("reallocationAuthority (spec §6a, 10% per version, cumulative)", () => {
  it("owner within 10% of the approved base, approval beyond it; falls back to planned on a draft base", () => {
    expect(reallocationAuthority({ approvedPlanned: "10000", planned: "9000", reallocatedOut: "0" }, "1000")).toBe("OWNER");
    expect(reallocationAuthority({ approvedPlanned: "10000", planned: "9000", reallocatedOut: "0" }, "1000.01")).toBe("APPROVAL_REQUIRED");
    expect(reallocationAuthority({ approvedPlanned: "10000", planned: "9000", reallocatedOut: "900" }, "100.01")).toBe("APPROVAL_REQUIRED");
    expect(reallocationAuthority({ approvedPlanned: null, planned: "5000", reallocatedOut: "0" }, "500")).toBe("OWNER");
  });
});
