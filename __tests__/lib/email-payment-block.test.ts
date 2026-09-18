/**
 * buildRegistrationPaymentBlock: the ONE builder behind the confirmation
 * email's {{paymentBlock}} and the bulk Registration Confirmation resend
 * (September 18, 2026). Before it, bulk had no value for the token, so a
 * resend on the default template was refused by the unresolved-token guard
 * on every event still carrying it (23 of 29 on production).
 */
import { describe, it, expect } from "vitest";
import { buildRegistrationPaymentBlock, registrationPaymentLink } from "@/lib/email";

const LINK = "https://x.test/e/osh/confirmation?id=reg-1&name=Sara&price=100&currency=USD";

describe("buildRegistrationPaymentBlock", () => {
  it("renders nothing when no money is owed", () => {
    expect(buildRegistrationPaymentBlock({ ticketPrice: 0, paymentLink: LINK, quoteAttached: true })).toEqual({ html: "", text: "" });
    expect(buildRegistrationPaymentBlock({ ticketPrice: null, paymentLink: LINK, quoteAttached: false }).html).toBe("");
  });

  it("a group member gets the covered-by note with the payer escaped, never an amount", () => {
    const b = buildRegistrationPaymentBlock({ coveredByGroupPayerName: "Acme & Co", ticketPrice: 500, paymentLink: LINK, quoteAttached: true });
    expect(b.html).toContain("Registration covered by Acme &amp; Co");
    expect(b.html).not.toContain("Pay Now");
    expect(b.text).toContain("Registration covered by Acme & Co");
  });

  it("the confirmation (quote attached) says Payment Pending, points at the quote and offers Pay Now", () => {
    const b = buildRegistrationPaymentBlock({ ticketPrice: 100, ticketCurrency: "USD", paymentLink: LINK, quoteAttached: true });
    expect(b.html).toContain("Payment Pending");
    expect(b.html).toContain("Amount due: <strong>USD 100.00</strong>");
    expect(b.html).toContain("Please find attached the quote");
    expect(b.html).toContain(`href="${LINK.replace(/&/g, "&amp;")}"`);
    expect(b.text).toContain("Pay Now: " + LINK);
    expect(b.text).toContain("Please find attached the quote");
  });

  it("the bulk resend (no quote) drops the attachment sentence and keeps Pay Now and the settle line", () => {
    const b = buildRegistrationPaymentBlock({ ticketPrice: 100, ticketCurrency: "USD", paymentLink: LINK, quoteAttached: false });
    expect(b.html).toContain("Payment Pending");
    expect(b.html).not.toContain("Please find attached the quote");
    expect(b.html).toContain("Pay Now");
    expect(b.html).toContain("IMPORTANT:");
    expect(b.text).not.toContain("Please find attached the quote");
    expect(b.text).toContain("IMPORTANT: Kindly note");
  });

  it("itemises a promo discount and tax on the net, and suppressPayNow drops the call to action", () => {
    const b = buildRegistrationPaymentBlock({
      ticketPrice: 200, ticketCurrency: "AED", discountAmount: 50, promoCode: "EARLY", taxRate: 5, taxLabel: "VAT",
      paymentLink: LINK, quoteAttached: true, suppressPayNow: true,
    });
    expect(b.html).toContain("Subtotal: AED 200.00");
    expect(b.html).toContain("Promo EARLY: −AED 50.00");
    expect(b.html).toContain("VAT (5%): AED 7.50");
    expect(b.html).toContain("Total: AED 157.50");
    expect(b.html).toContain("Registration Fee");
    expect(b.html).not.toContain("Pay Now");
    expect(b.text).toContain("Total: AED 157.50");
  });

  it("accepts Decimal-shaped strings for the money fields", () => {
    const b = buildRegistrationPaymentBlock({ ticketPrice: "120.5", discountAmount: "20.5", paymentLink: LINK, quoteAttached: false });
    expect(b.html).toContain("Total: USD 100.00");
  });
});

describe("registrationPaymentLink", () => {
  it("builds the confirmation-page link with the name encoded", () => {
    expect(registrationPaymentLink({ eventSlug: "osh", registrationId: "r1", firstName: "Sara Al", price: 100, currency: "USD", appUrl: "https://x.test" }))
      .toBe("https://x.test/e/osh/confirmation?id=r1&name=Sara%20Al&price=100&currency=USD");
  });
});
