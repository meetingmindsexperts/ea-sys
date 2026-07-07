/**
 * buildPaymentReminderVars — the shared {{amount}} + {{paymentBlock}} (Pay Now)
 * builder used by BOTH the single-send route and the bulk sender. Pins the
 * tier/discount/tax-aware amount (NOT the $0 tier base) and the Pay Now link.
 */
import { describe, it, expect } from "vitest";
import { buildPaymentReminderVars } from "@/lib/payment-reminder";

const base = {
  registrationId: "reg1",
  firstName: "Jane",
  eventSlug: "my-event",
  appUrl: "https://x.test",
  taxRate: null as number | null,
  taxLabel: null as string | null,
  discountAmount: null as unknown,
};

describe("buildPaymentReminderVars", () => {
  it("uses the tier price (not the $0 ticket-type base) + adds tax", () => {
    const r = buildPaymentReminderVars({
      ...base,
      originalPrice: 400,
      pricingTier: { price: 400, currency: "USD" },
      ticketType: { price: 0, currency: "USD" }, // tier-priced type: $0 base
      taxRate: 5,
      taxLabel: "VAT",
    });
    expect(r.amount).toBe("USD 420.00"); // 400 + 5%
    expect(r.paymentBlock).toContain("Pay Now");
    expect(r.paymentBlock).toContain("https://x.test/e/my-event/confirmation?id=reg1&name=Jane");
    expect(r.paymentBlock).toContain("price=420");
    expect(r.paymentBlock).toContain("currency=USD");
  });

  it("recovers a $0-stamped originalPrice from the positively-priced tier", () => {
    const r = buildPaymentReminderVars({
      ...base,
      originalPrice: 0, // un-restamped
      pricingTier: { price: 300, currency: "USD" },
      ticketType: { price: 0, currency: "USD" },
    });
    expect(r.amount).toBe("USD 300.00");
    expect(r.paymentBlock).toContain("price=300");
  });

  it("nets the discount before tax", () => {
    const r = buildPaymentReminderVars({
      ...base,
      originalPrice: 400,
      discountAmount: 100,
      pricingTier: { price: 400, currency: "USD" },
      ticketType: { price: 0, currency: "USD" },
      taxRate: 5,
      taxLabel: "VAT",
    });
    expect(r.amount).toBe("USD 315.00"); // (400 - 100) + 5%
    expect(r.paymentBlock).toContain("price=315");
  });

  it("falls back to the ticket-type price + currency when there's no tier", () => {
    const r = buildPaymentReminderVars({
      ...base,
      originalPrice: null,
      pricingTier: null,
      ticketType: { price: 150, currency: "EUR" },
    });
    expect(r.amount).toBe("EUR 150.00");
    expect(r.paymentBlock).toContain("currency=EUR");
  });
});
