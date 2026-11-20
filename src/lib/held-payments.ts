/**
 * Money collected on a registration and not yet returned (Nov 20, 2026;
 * review of 66969977). Pure, so the two places that must agree share it:
 * Make Faculty's own read before its dialog (make-faculty-service.ts) and the
 * read behind the row lock inside the update (registration-service.ts).
 */

/** A cent of tolerance, as the financials use (rounding across partial captures). */
export const HELD_PAYMENT_TOLERANCE = 0.01;

/**
 * Each settled payment's amount less what was refunded FROM IT. A fully refunded payment is
 * a REFUNDED row and counts for nothing; the registration's own running
 * refund total is not subtracted again (review of 66969977: doing both let a
 * second, still-held payment pass). THE sum Make Faculty refuses on, before
 * its dialog and again behind the row lock.
 */
export function heldPaymentSum(payments: readonly { amount: unknown; refundedAmount: unknown; status: string }[]): number {
  return payments
    .filter((p) => p.status === "PAID" || p.status === "REFUNDED")
    .reduce((sum, p) => sum + Math.max(0, Number(p.amount) - Number(p.refundedAmount ?? 0)), 0);
}
