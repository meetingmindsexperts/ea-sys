/**
 * When may a registration's pricing tier be changed? Pure and client-safe, so
 * the server resolver (registration-repricing.ts) and the registration sheet
 * share one rule.
 *
 * Unpaid, pending or unassigned: the tier sets what they will pay.
 * Complimentary or sponsor-paid (Inclusive): nothing is owed, so the tier is a
 * label (which rate they came in on) and changing it charges no one (owner,
 * Oct 22, 2026). What guarantees that: checkout refuses both statuses, the
 * registrant portal hides Pay for them, and payment reminders skip them. If
 * staff later switch one to Unpaid, the price of the tier then set is owed.
 * Paid (and refunded or failed): locked, money moved at the old price.
 */
export const UNPAID_TIER_STATUSES = ["UNASSIGNED", "UNPAID", "PENDING"] as const;
export const NO_BALANCE_TIER_STATUSES = ["COMPLIMENTARY", "INCLUSIVE"] as const;

export function tierChangeAllowed(paymentStatus: string): boolean {
  return (
    (UNPAID_TIER_STATUSES as readonly string[]).includes(paymentStatus) ||
    (NO_BALANCE_TIER_STATUSES as readonly string[]).includes(paymentStatus)
  );
}
