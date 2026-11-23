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
  onHold: false,
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

// Owner, Nov 23, 2026 (author-payment-hold.ts): an abstract author's fee is not
// paid online until the organisers open it, and the checkout refuses the link.
describe("buildPaymentReminderVars: an abstract author on hold", () => {
  const held = buildPaymentReminderVars({
    ...base,
    onHold: true,
    originalPrice: 400,
    pricingTier: { price: 400, currency: "USD" },
    ticketType: { price: 0, currency: "USD" },
  });

  it("still says the amount", () => {
    expect(held.amount).toBe("USD 400.00");
  });

  it("carries no Pay Now and no link to the pay page", () => {
    expect(held.paymentBlock).not.toContain("Pay Now");
    expect(held.paymentBlock).not.toContain("<a ");
    expect(held.paymentBlock).not.toContain("/confirmation");
  });

  // Review of cb9ed4749: the reminder's own words ask for payment, so the line
  // must give the way that is open, not say the fee is still to be confirmed.
  it("points at the bank transfer on the quote, and does not say the fee is unconfirmed", () => {
    expect(held.paymentBlock).toContain("Online payment is not open for this registration");
    expect(held.paymentBlock).toContain("bank transfer using the quote");
    expect(held.paymentBlock).not.toContain("will confirm your registration fee");
  });
});
