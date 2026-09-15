/**
 * CRM quote rules: numbering, dates, money and the input contract.
 *
 * The totals test uses the owner's sample quote (Abbott, Diamond sponsorship,
 * 95,000 USD at 5% VAT = 99,750 USD), so the arithmetic is pinned to a document
 * a person has already signed off, not to numbers invented for the test.
 */
import { describe, expect, it } from "vitest";
import {
  addDaysToDateString,
  computeQuoteTotals,
  formatQuoteDate,
  formatQuoteMoney,
  formatQuoteNumber,
  formatTaxRate,
  isQuoteCurrency,
  isValidDateString,
  quoteInputSchema,
  quoteYear,
  readCrmQuoteDefaults,
  todayInQuoteTimezone,
} from "@/crm/lib/quote-rules";

const validInput = {
  title: "Abbott Quote - MEHFC 2026",
  currency: "USD",
  quoteDate: "2026-09-15",
  validUntil: "2026-10-15",
  preparedFor: "Abbott",
  lines: [{ name: "Sponsorship - Diamond", quantity: 1, unitPrice: 95000 }],
};

describe("numbering", () => {
  it("formats a yearly, zero-padded number", () => {
    expect(formatQuoteNumber(2026, 3)).toBe("Q-2026-0003");
  });

  it("keeps counting past four digits rather than wrapping", () => {
    expect(formatQuoteNumber(2026, 12345)).toBe("Q-2026-12345");
  });

  it("takes the year in Dubai, so a quote issued on the evening of 31 December UTC counts for the new year", () => {
    // 21:00 UTC on 31 Dec is 01:00 on 1 Jan in Dubai.
    expect(quoteYear(new Date("2026-12-31T21:00:00.000Z"))).toBe(2027);
    expect(quoteYear(new Date("2026-12-31T19:00:00.000Z"))).toBe(2026);
  });
});

describe("dates", () => {
  it("reads today in the quote timezone", () => {
    expect(todayInQuoteTimezone(new Date("2026-09-14T22:30:00.000Z"))).toBe("2026-09-15");
  });

  it("refuses dates that Date.UTC would silently roll over", () => {
    expect(isValidDateString("2026-02-31")).toBe(false);
    expect(isValidDateString("2026-13-01")).toBe(false);
    expect(isValidDateString("2028-02-29")).toBe(true);
    expect(isValidDateString("15/09/2026")).toBe(false);
  });

  it("adds days across a month and a year boundary", () => {
    expect(addDaysToDateString("2026-12-20", 30)).toBe("2027-01-19");
  });

  it("prints day-first like the invoices and receipts", () => {
    expect(formatQuoteDate("2026-09-05")).toBe("05/09/2026");
  });
});

describe("money", () => {
  it("reproduces the sample quote: 95,000 USD at 5% VAT is 99,750 USD", () => {
    const totals = computeQuoteTotals([{ quantity: 1, unitPrice: 95000 }], 5);
    expect(totals).toEqual({ amounts: [95000], subtotal: 95000, taxRate: 5, taxAmount: 4750, total: 99750 });
    expect(formatQuoteMoney(totals.total, "USD")).toBe("99,750.00 USD");
  });

  it("rounds each line to cents before summing, so the stored parts add up to the total", () => {
    const totals = computeQuoteTotals(
      [
        { quantity: 3, unitPrice: 33.335 },
        { quantity: 1, unitPrice: 0.1 },
      ],
      5,
    );
    expect(totals.amounts).toEqual([100.01, 0.1]);
    expect(totals.subtotal).toBe(100.11);
    expect(totals.taxAmount).toBe(5.01);
    expect(totals.total).toBe(105.12);
  });

  it("charges no tax when the rate is absent, zero or negative", () => {
    for (const rate of [null, undefined, 0, -5]) {
      const totals = computeQuoteTotals([{ quantity: 2, unitPrice: 50 }], rate);
      expect(totals.taxRate).toBeNull();
      expect(totals.taxAmount).toBe(0);
      expect(totals.total).toBe(100);
    }
  });

  it("prints a tax rate without trailing zeros", () => {
    expect(formatTaxRate(5)).toBe("5");
    expect(formatTaxRate(5.5)).toBe("5.5");
  });
});

describe("currencies and defaults", () => {
  it("offers exactly the owner's currency list", () => {
    expect(isQuoteCurrency("USD")).toBe(true);
    expect(isQuoteCurrency("AED")).toBe(true);
    expect(isQuoteCurrency("JPY")).toBe(false);
    expect(isQuoteCurrency(null)).toBe(false);
  });

  it("reads the org default terms: saved empty means none, missing or corrupt means unconfigured", () => {
    expect(readCrmQuoteDefaults({ crmQuote: { terms: "Our terms" } })).toEqual({ configured: true, terms: "Our terms" });
    expect(readCrmQuoteDefaults({ crmQuote: { terms: "   " } })).toEqual({ configured: true, terms: null });
    expect(readCrmQuoteDefaults({ crmQuote: { terms: null } })).toEqual({ configured: true, terms: null });
    expect(readCrmQuoteDefaults({ crmQuote: {} })).toEqual({ configured: false, terms: null });
    expect(readCrmQuoteDefaults({ crmQuote: { terms: 42 } })).toEqual({ configured: false, terms: null });
    expect(readCrmQuoteDefaults({ crmQuote: "nonsense" })).toEqual({ configured: false, terms: null });
    expect(readCrmQuoteDefaults(null)).toEqual({ configured: false, terms: null });
  });
});

describe("quoteInputSchema", () => {
  it("accepts a complete quote", () => {
    expect(quoteInputSchema.safeParse(validInput).success).toBe(true);
  });

  it("refuses a valid-until date before the quote date", () => {
    const res = quoteInputSchema.safeParse({ ...validInput, validUntil: "2026-09-01" });
    expect(res.success).toBe(false);
  });

  it("refuses a currency outside the list, a quote with no lines, and a fractional quantity", () => {
    expect(quoteInputSchema.safeParse({ ...validInput, currency: "JPY" }).success).toBe(false);
    expect(quoteInputSchema.safeParse({ ...validInput, lines: [] }).success).toBe(false);
    expect(
      quoteInputSchema.safeParse({ ...validInput, lines: [{ name: "X", quantity: 1.5, unitPrice: 10 }] }).success,
    ).toBe(false);
  });

  it("refuses a line with no price rather than guessing one", () => {
    const res = quoteInputSchema.safeParse({
      ...validInput,
      lines: [{ name: "Booth", quantity: 1, unitPrice: null }],
    });
    expect(res.success).toBe(false);
  });
});
