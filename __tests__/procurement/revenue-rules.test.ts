/**
 * Revenue and margin rules (spec §6b; owner decisions of 17 September 2026):
 * a paid registration counts at its price after discount and net of refunds,
 * without VAT, under Delegate Sales; a won deal is split by its products per
 * income account with the rest of its value "not itemised"; a product with no
 * account and an amount with no fixed rate are shown apart, never guessed;
 * forecast margin takes the larger of plan and actual per account.
 */
import { describe, it, expect } from "vitest";
import { aggregateActuals, marginView, pegRate, registrationRevenue, type WonDeal } from "@/procurement/lib/revenue-rules";
import { INCOME_ACCOUNTS, incomeAccountForCrmProduct } from "@/procurement/lib/income-accounts";

describe("pegRate", () => {
  it("is 1 within a currency and the peg ratio between pegged currencies", () => {
    expect(pegRate("EUR", "EUR")?.toString()).toBe("1");
    expect(pegRate("USD", "AED")?.toString()).toBe("3.6725");
    expect(pegRate("AED", "USD")?.toFixed(6)).toBe("0.272294");
  });
  it("is null where no fixed rate exists", () => {
    expect(pegRate("EUR", "AED")).toBeNull();
    expect(pegRate("AED", "GBP")).toBeNull();
  });
});

describe("registrationRevenue", () => {
  it("takes the price less the discount, without VAT", () => {
    expect(registrationRevenue({ basePrice: 1500, discountAmount: "150", refundedAmount: "0", currency: "USD" }, "5").toFixed(2)).toBe("1350.00");
  });
  it("nets a gross refund back out of VAT before taking it off", () => {
    // 1050 refunded with 5% VAT is 1000 of revenue returned.
    expect(registrationRevenue({ basePrice: 1500, discountAmount: null, refundedAmount: "1050", currency: "USD" }, "5").toFixed(2)).toBe("500.00");
  });
  it("never goes below zero", () => {
    expect(registrationRevenue({ basePrice: 100, discountAmount: "200", refundedAmount: "0", currency: "USD" }, null).toFixed(2)).toBe("0.00");
    expect(registrationRevenue({ basePrice: 100, discountAmount: null, refundedAmount: "500", currency: "USD" }, null).toFixed(2)).toBe("0.00");
  });
});

const deal = (over: Partial<WonDeal>): WonDeal => ({ dealValue: null, currency: "USD", products: [], ...over });
const product = (name: string, source: "IN_HOUSE" | "OUTSOURCED" | null, category: string | null, unitPrice: string, quantity = 1, currency = "USD") => ({ productName: name, source, category, unitPrice, quantity, currency });

describe("aggregateActuals", () => {
  it("puts paid registrations under Delegate Sales in the reporting currency", () => {
    const a = aggregateActuals({ reportingCurrency: "AED", taxRatePercent: "5", registrations: [{ basePrice: 1000, discountAmount: null, refundedAmount: "0", currency: "USD" }, { basePrice: 500, discountAmount: null, refundedAmount: "0", currency: "USD" }], deals: [] });
    expect(a.byAccount).toEqual({ "430005": "5508.7500" });
    expect(a.total).toBe("5508.7500");
    expect(a.paidRegistrations).toBe(2);
  });
  it("splits a won deal by its products and shows the rest of its value as not itemised", () => {
    const a = aggregateActuals({
      reportingCurrency: "USD",
      taxRatePercent: null,
      registrations: [],
      deals: [deal({ dealValue: "50000", products: [product("Gold sponsorship", "IN_HOUSE", "Sponsorship", "30000"), product("Venue hire", "OUTSOURCED", "Venue Hire", "5000", 2)] })],
    });
    expect(a.byAccount).toEqual({ "430012": "30000.0000", "440011": "10000.0000" });
    expect(a.notItemised).toBe("10000.0000");
    expect(a.total).toBe("50000.0000");
  });
  it("shows products that add up to more than the deal value as a negative gap, and a deal with no value as none", () => {
    const over = aggregateActuals({ reportingCurrency: "USD", taxRatePercent: null, registrations: [], deals: [deal({ dealValue: "1000", products: [product("Design", "IN_HOUSE", "Design", "1200")] })] });
    expect(over.notItemised).toBe("-200.0000");
    expect(over.total).toBe("1000.0000");
    const noValue = aggregateActuals({ reportingCurrency: "USD", taxRatePercent: null, registrations: [], deals: [deal({ dealValue: null, products: [product("Design", "IN_HOUSE", "Design", "1200")] })] });
    expect(noValue.notItemised).toBe("0.0000");
    expect(noValue.total).toBe("1200.0000");
  });
  it("keeps a product whose pair has no income account apart, naming it", () => {
    const a = aggregateActuals({ reportingCurrency: "USD", taxRatePercent: null, registrations: [], deals: [deal({ dealValue: "700", products: [product("Online Advertising", "OUTSOURCED", "Communication", "700")] })] });
    expect(a.byAccount).toEqual({});
    expect(a.noAccount).toEqual({ amount: "700.0000", products: [{ productName: "Online Advertising", source: "OUTSOURCED", category: "Communication", amount: "700.0000" }] });
    expect(a.notItemised).toBe("0.0000");
  });
  it("converts an AED product on a USD deal at the peg", () => {
    const a = aggregateActuals({ reportingCurrency: "USD", taxRatePercent: null, registrations: [], deals: [deal({ dealValue: "1000", products: [product("CME", "IN_HOUSE", "CME", "3672.5", 1, "AED")] })] });
    expect(a.byAccount).toEqual({ "430001": "1000.0000" });
    expect(a.notItemised).toBe("0.0000");
  });
  it("leaves out and lists what has no fixed rate: a registration, a deal, a product", () => {
    const a = aggregateActuals({
      reportingCurrency: "AED",
      taxRatePercent: null,
      registrations: [{ basePrice: 400, discountAmount: null, refundedAmount: "0", currency: "EUR" }],
      deals: [
        deal({ dealValue: "9000", currency: "GBP", products: [product("Gold", "IN_HOUSE", "Sponsorship", "9000", 1, "GBP")] }),
        deal({ dealValue: "3672.5", currency: "AED", products: [product("Design", "IN_HOUSE", "Design", "3672.5", 1, "AED"), product("Print", "IN_HOUSE", "Design", "100", 1, "EUR")] }),
      ],
    });
    expect(a.byAccount).toEqual({ "430006": "3672.5000" });
    expect(a.notConverted).toEqual([
      { from: "registrations", currency: "EUR", amount: "400.0000" },
      { from: "deals", currency: "GBP", amount: "9000.0000" },
      { from: "deals", currency: "EUR", amount: "100.0000" },
    ]);
    expect(a.total).toBe("3672.5000");
  });
});

describe("marginView", () => {
  const base = { plannedExpenseTotal: "60000", contingencyAmount: "6000", forecastExpenseTotal: "66000", targetMarginPercent: null };
  const actuals = (byAccount: Record<string, string>, notItemised = "0", noAccount = "0") => ({ byAccount, notItemised, noAccount: { amount: noAccount, products: [] } });

  it("plans revenue against planned expense plus contingency", () => {
    const m = marginView({ ...base, plannedByAccount: { "430005": "80000", "430012": "20000" }, actuals: actuals({}) });
    expect(m.plannedRevenue).toBe("100000.0000");
    expect(m.plannedCost).toBe("66000.0000");
    expect(m.plannedMargin).toBe("34000.0000");
    expect(m.plannedMarginPercent).toBe("34.00");
  });
  it("forecasts the larger of plan and actual per account, plus what sits outside the accounts", () => {
    const m = marginView({ ...base, plannedByAccount: { "430005": "80000", "430012": "20000" }, actuals: actuals({ "430005": "30000", "430012": "25000", "440011": "5000" }, "1000", "500") });
    // 80000 + 25000 + 5000 + 1000 + 500
    expect(m.forecastRevenue).toBe("111500.0000");
    expect(m.forecastMargin).toBe("45500.0000");
  });
  it("never forecasts cost below the plan, and takes an overrun", () => {
    expect(marginView({ ...base, forecastExpenseTotal: "50000", plannedByAccount: {}, actuals: actuals({}) }).forecastCost).toBe("66000.0000");
    expect(marginView({ ...base, forecastExpenseTotal: "90000", plannedByAccount: {}, actuals: actuals({}) }).forecastCost).toBe("90000.0000");
  });
  it("flags below target only when a target is set", () => {
    const plan = { "430005": "100000" };
    expect(marginView({ ...base, plannedByAccount: plan, actuals: actuals({}) }).belowTarget).toBe(false);
    expect(marginView({ ...base, targetMarginPercent: "40", plannedByAccount: plan, actuals: actuals({}) }).belowTarget).toBe(true);
    expect(marginView({ ...base, targetMarginPercent: "30", plannedByAccount: plan, actuals: actuals({}) }).belowTarget).toBe(false);
  });
  it("counts cost with no revenue as below any target, and shows no percent", () => {
    const m = marginView({ ...base, targetMarginPercent: "10", plannedByAccount: {}, actuals: actuals({}) });
    expect(m.forecastMarginPercent).toBeNull();
    expect(m.belowTarget).toBe(true);
  });
});

describe("income accounts", () => {
  it("are the chart's 24 income accounts, unique", () => {
    expect(INCOME_ACCOUNTS).toHaveLength(24);
    expect(new Set(INCOME_ACCOUNTS.map((a) => a.code)).size).toBe(24);
    for (const a of INCOME_ACCOUNTS) expect(a.code).toMatch(/^4[34]00\d\d$/);
  });
  it("map every In-House and Out-Sourced category the CRM catalogue uses, ignoring case and spaces", () => {
    const inHouse = ["Abstract Management", "CME", "Communication", "Content", "Delegate Sales", "Design", "Event Management", "Exhibition", "Finance", "Hospitality", "Project Management", "Sponsorship", "Virtual"];
    const outSourced = ["CME", "Endorsements", "F&B", "Giveaways", "Misc", "Permits", "Production", "Setup & Build", "Staffing", "Travel", "Venue Hire"];
    const codes = new Set(INCOME_ACCOUNTS.map((a) => a.code));
    for (const c of inHouse) expect(codes.has(incomeAccountForCrmProduct("IN_HOUSE", c) ?? ""), c).toBe(true);
    for (const c of outSourced) expect(codes.has(incomeAccountForCrmProduct("OUTSOURCED", c) ?? ""), c).toBe(true);
    expect(incomeAccountForCrmProduct("IN_HOUSE", "  venue hire ")).toBeNull();
    expect(incomeAccountForCrmProduct("OUTSOURCED", "  VENUE HIRE ")).toBe("440011");
  });
  it("leave the four pairs the chart has no account for unmapped, and an unknown source unmapped", () => {
    expect(incomeAccountForCrmProduct("IN_HOUSE", "Setup & Build")).toBeNull();
    expect(incomeAccountForCrmProduct("OUTSOURCED", "Communication")).toBeNull();
    expect(incomeAccountForCrmProduct("OUTSOURCED", "Content")).toBeNull();
    expect(incomeAccountForCrmProduct("OUTSOURCED", "Event Management")).toBeNull();
    expect(incomeAccountForCrmProduct(null, "Sponsorship")).toBeNull();
  });
});
