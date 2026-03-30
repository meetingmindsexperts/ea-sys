import { describe, it, expect } from "vitest";
import { isZeroDecimalCurrency, toStripeAmount } from "@/lib/stripe";

// ── Tax calculation logic (mirrors checkout route) ───────────────────────────

/** Replicate the tax calculation from the checkout route */
function calculateTax(
  ticketPrice: number,
  taxRate: number | null | undefined,
  taxLabel?: string | null
) {
  const rate = Number(taxRate || 0);
  const label = taxLabel || "VAT";
  const taxAmount = ticketPrice * rate / 100;
  const total = ticketPrice + taxAmount;
  return { rate, label, taxAmount, total };
}

/** Build Stripe line items (mirrors checkout route logic) */
function buildStripeLineItems(
  eventName: string,
  ticketName: string,
  ticketPrice: number,
  currency: string,
  taxRate: number | null | undefined,
  taxLabel?: string | null
) {
  const { rate, label, taxAmount } = calculateTax(ticketPrice, taxRate, taxLabel);

  const ticketUnitAmount = isZeroDecimalCurrency(currency)
    ? Math.round(ticketPrice)
    : Math.round(ticketPrice * 100);

  const lineItems = [
    {
      price_data: {
        currency: currency.toLowerCase(),
        product_data: { name: `${eventName} — ${ticketName}` },
        unit_amount: ticketUnitAmount,
      },
      quantity: 1,
    },
  ];

  if (taxAmount > 0) {
    const taxUnitAmount = isZeroDecimalCurrency(currency)
      ? Math.round(taxAmount)
      : Math.round(taxAmount * 100);

    lineItems.push({
      price_data: {
        currency: currency.toLowerCase(),
        product_data: { name: `${label} (${rate}%)` },
        unit_amount: taxUnitAmount,
      },
      quantity: 1,
    });
  }

  return lineItems;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Tax calculation", () => {
  it("calculates tax with 5% rate (UAE VAT)", () => {
    const result = calculateTax(100, 5);
    expect(result.taxAmount).toBe(5);
    expect(result.total).toBe(105);
    expect(result.rate).toBe(5);
  });

  it("calculates tax with 15% rate (KSA VAT)", () => {
    const result = calculateTax(200, 15);
    expect(result.taxAmount).toBe(30);
    expect(result.total).toBe(230);
  });

  it("calculates tax with 0% rate (no tax)", () => {
    const result = calculateTax(100, 0);
    expect(result.taxAmount).toBe(0);
    expect(result.total).toBe(100);
  });

  it("calculates tax with null rate (no tax)", () => {
    const result = calculateTax(100, null);
    expect(result.taxAmount).toBe(0);
    expect(result.total).toBe(100);
    expect(result.rate).toBe(0);
  });

  it("calculates tax with undefined rate (no tax)", () => {
    const result = calculateTax(100, undefined);
    expect(result.taxAmount).toBe(0);
    expect(result.total).toBe(100);
  });

  it("calculates fractional tax amounts correctly", () => {
    const result = calculateTax(99.99, 5);
    expect(result.taxAmount).toBeCloseTo(4.9995, 4);
    expect(result.total).toBeCloseTo(104.9895, 4);
  });

  it("tax label defaults to 'VAT' when not provided", () => {
    const result = calculateTax(100, 5);
    expect(result.label).toBe("VAT");
  });

  it("tax label defaults to 'VAT' when null", () => {
    const result = calculateTax(100, 5, null);
    expect(result.label).toBe("VAT");
  });

  it("uses custom tax label when provided", () => {
    const result = calculateTax(100, 5, "GST");
    expect(result.label).toBe("GST");
  });
});

describe("Zero-decimal currency tax (JPY)", () => {
  it("calculates JPY tax correctly", () => {
    // ¥10000 ticket with 10% tax
    const result = calculateTax(10000, 10);
    expect(result.taxAmount).toBe(1000);
    expect(result.total).toBe(11000);
  });

  it("Stripe amount for JPY tax is not multiplied by 100", () => {
    // ¥10000 → 10000 (not 1000000)
    const stripeAmount = toStripeAmount(10000, "JPY");
    expect(stripeAmount).toBe(10000);
  });
});

describe("Stripe line items", () => {
  it("base + tax as separate items when tax > 0", () => {
    const items = buildStripeLineItems("Conference 2026", "Physician", 100, "USD", 5, "VAT");

    expect(items).toHaveLength(2);

    // Base item
    expect(items[0].price_data.unit_amount).toBe(10000); // $100 * 100
    expect(items[0].price_data.product_data.name).toBe("Conference 2026 — Physician");
    expect(items[0].price_data.currency).toBe("usd");

    // Tax item
    expect(items[1].price_data.unit_amount).toBe(500); // $5 * 100
    expect(items[1].price_data.product_data.name).toBe("VAT (5%)");
  });

  it("only base when no tax (rate = 0)", () => {
    const items = buildStripeLineItems("Webinar", "Standard", 50, "USD", 0);
    expect(items).toHaveLength(1);
    expect(items[0].price_data.unit_amount).toBe(5000);
  });

  it("only base when no tax (rate = null)", () => {
    const items = buildStripeLineItems("Webinar", "Standard", 50, "EUR", null);
    expect(items).toHaveLength(1);
    expect(items[0].price_data.unit_amount).toBe(5000);
  });

  it("zero-decimal currency line items (JPY)", () => {
    const items = buildStripeLineItems("Tokyo Conf", "VIP", 10000, "JPY", 10, "Tax");

    expect(items).toHaveLength(2);
    expect(items[0].price_data.unit_amount).toBe(10000); // ¥10000 as-is
    expect(items[0].price_data.currency).toBe("jpy");
    expect(items[1].price_data.unit_amount).toBe(1000); // ¥1000 tax as-is
    expect(items[1].price_data.product_data.name).toBe("Tax (10%)");
  });

  it("KSA 15% VAT with AED currency", () => {
    const items = buildStripeLineItems("Riyadh Summit", "Delegate", 500, "AED", 15, "VAT");

    expect(items).toHaveLength(2);
    expect(items[0].price_data.unit_amount).toBe(50000); // 500 * 100
    expect(items[1].price_data.unit_amount).toBe(7500); // 75 * 100
    expect(items[1].price_data.product_data.name).toBe("VAT (15%)");
  });
});
