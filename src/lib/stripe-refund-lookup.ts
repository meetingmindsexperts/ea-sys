import { apiLogger } from "@/lib/logger";
import { fromStripeAmount, getStripe } from "@/lib/stripe";

/**
 * What Stripe says about one payment intent's refunds (review H4/H5, July 10
 * 2026; refundedTotal added Nov 6, 2026, security audit W0-1 follow-up).
 *
 * Its own module so both the refund service and the reconciliation sweep can
 * use it without importing each other.
 *
 * - `found` / `refundId`: did attempt X produce a refund that moved money? Every
 *   refund we create carries `metadata.refundAttemptId`. A failed or canceled
 *   one does not count (it used to: such a refund was booked as a success).
 * - `refundedTotal`: what Stripe has refunded on this intent so far, in display
 *   units. A rollback sets the payment's counter from this, not from our own
 *   arithmetic, because a Stripe Dashboard refund can land while ours is booked
 *   and its webhook then sees nothing new to record.
 * - `attemptIds`: our attempts Stripe knows about, so an in-flight attempt that
 *   is already inside `refundedTotal` is not counted a second time.
 *
 * Counted statuses: succeeded, pending and requires_action (money that has
 * left or is leaving). failed and canceled refunds returned nothing.
 */
export type StripeRefundVerification =
  | { verified: true; found: boolean; refundId: string | null; refundedTotal: number; attemptIds: string[] }
  | { verified: false };

const MOVING = new Set(["succeeded", "pending", "requires_action"]);

/**
 * `organizationId` picks the Stripe account to ask (per-org keys); null falls
 * back to the env account, which is correct for every pre-feature row.
 */
export async function findStripeRefundForAttempt(
  paymentIntentId: string,
  attemptId: string,
  organizationId: string | null,
): Promise<StripeRefundVerification> {
  try {
    const stripe = await getStripe(organizationId);
    const refunds = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100 });
    if (refunds.has_more) {
      // A total from a partial list would be wrong, and 100 refunds on one
      // registration's charge is not a real case. Refuse rather than guess.
      apiLogger.warn({ msg: "refund-verify:too-many-refunds", paymentIntentId, attemptId });
      return { verified: false };
    }
    // A failed or canceled refund moved no money, so it does not count as found.
    const match = refunds.data.find((r) => r.metadata?.refundAttemptId === attemptId && !!r.status && MOVING.has(r.status));
    let minor = 0;
    let currency = "usd";
    const attemptIds: string[] = [];
    for (const r of refunds.data) {
      if (!r.status || !MOVING.has(r.status)) continue;
      minor += r.amount;
      currency = r.currency;
      const id = r.metadata?.refundAttemptId;
      if (id) attemptIds.push(id);
    }
    return {
      verified: true,
      found: !!match,
      refundId: match?.id ?? null,
      refundedTotal: fromStripeAmount(minor, currency),
      attemptIds,
    };
  } catch (err) {
    apiLogger.warn({ err, msg: "refund-verify:stripe-list-failed", paymentIntentId, attemptId });
    return { verified: false };
  }
}
