/**
 * When may a registration's pricing tier be changed? Pure and client-safe, so
 * the server resolver (registration-repricing.ts) and the registration sheet
 * share one rule.
 *
 * Unpaid, pending or unassigned: the tier sets what they will pay.
 * Complimentary or sponsor-paid (Inclusive): nothing is owed, so the tier is a
 * label (which rate they came in on) and changing it charges no one (owner,
 * Oct 22, 2026). Payment reminders only chase the unpaid statuses, so a
 * re-stamped price is never billed.
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
