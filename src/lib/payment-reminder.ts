import { computeRegistrationFinancials, readRegistrationBasePrice } from "@/lib/registration-financials";

/**
 * Shared builder for the payment-reminder email's `{{amount}}` + `{{paymentBlock}}`
 * (the "Pay Now" button). Used by BOTH the single-send route
 * (`/registrations/[id]/email`) AND the bulk sender (`executeBulkEmail`) so a
 * reminder gets the same amount-due + link no matter which path sends it (the
 * bulk path previously rendered both tokens empty — no link).
 *
 * The amount is resolved the canonical way — `readRegistrationBasePrice`
 * (prefers the stamped `originalPrice`, falls back tier→ticket; virtual-aware)
 * → `computeRegistrationFinancials` (nets promo discount, adds tax) — so it's
 * NOT the tier-priced type's $0 base, and matches what Stripe actually charges.
 */
export interface PaymentReminderInput {
  registrationId: string;
  firstName: string;
  /** Public event slug (fall back to the event id if a slug isn't set). */
  eventSlug: string;
  originalPrice: unknown;
  discountAmount: unknown;
  pricingTier: { price: unknown; currency: string } | null;
  ticketType: { price: unknown; currency: string } | null;
  taxRate: number | null;
  taxLabel: string | null;
  /** Defaults to NEXT_PUBLIC_APP_URL. */
  appUrl?: string;
}

export function buildPaymentReminderVars(input: PaymentReminderInput): { amount: string; paymentBlock: string } {
  const currency = input.pricingTier?.currency || input.ticketType?.currency || "USD";
  const fin = computeRegistrationFinancials({
    subtotal: readRegistrationBasePrice({
      originalPrice: input.originalPrice,
      pricingTier: input.pricingTier,
      ticketType: input.ticketType,
    }),
    discount: input.discountAmount ? Number(input.discountAmount) : 0,
    taxRate: input.taxRate,
    taxLabel: input.taxLabel,
    currency,
    totalPaid: 0,
  });
  const amountDue = fin.total;

  const appUrl = input.appUrl || process.env.NEXT_PUBLIC_APP_URL || "https://events.meetingmindsgroup.com";
  const paymentLink =
    `${appUrl}/e/${input.eventSlug}/confirmation` +
    `?id=${input.registrationId}&name=${encodeURIComponent(input.firstName)}&price=${amountDue}&currency=${currency}`;

  return {
    amount: `${currency} ${amountDue.toFixed(2)}`,
    paymentBlock: `<div style="text-align: center; margin: 20px 0;">
        <a href="${paymentLink}" style="display: inline-block; background: #00aade; color: white; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: 500; font-size: 14px;">Pay Now</a>
      </div>`,
  };
}
