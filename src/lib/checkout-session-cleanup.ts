import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getStripe } from "@/lib/stripe";

/**
 * Expire a cancelled registration's still-open Stripe Checkout session
 * (payments review H2 sub-item, July 10 2026).
 *
 * Checkout sessions live ~24h at a frozen price. Cancelling a registration
 * used to leave the attendee's open payment tab fully functional — the
 * webhook guard records + alerts if they pay anyway (money truth), but the
 * right outcome is that the tab simply dies. The session id is stored on
 * `Registration.stripeCheckoutSessionId` at session create and cleared on
 * completion/expiry; this helper is the ONE cancel-side consumer, called
 * post-commit (fire-and-forget) by every cancel path — cancelRegistration,
 * the REST PUT status flip, and the MCP single/bulk updates — so the logic
 * can't drift across callers.
 *
 * NEVER throws: a cancel must not fail because Stripe is unreachable, and
 * expiring an already-completed/expired session is a benign Stripe error.
 */
export async function expireOpenCheckoutSessionOnCancel(
  registrationId: string,
  ctx: string,
): Promise<void> {
  try {
    const row = await db.registration.findUnique({
      where: { id: registrationId },
      select: { stripeCheckoutSessionId: true },
    });
    const sessionId = row?.stripeCheckoutSessionId;
    if (!sessionId) return;

    try {
      const stripe = getStripe();
      await stripe.checkout.sessions.expire(sessionId);
      apiLogger.info({ msg: "checkout-session:expired-on-cancel", registrationId, sessionId, ctx });
    } catch (err) {
      // Already completed/expired sessions throw — benign; anything else is
      // still non-fatal (the webhook guard covers a later payment).
      apiLogger.warn({ err, msg: "checkout-session:expire-failed", registrationId, sessionId, ctx });
    }

    await db.registration
      .update({ where: { id: registrationId }, data: { stripeCheckoutSessionId: null } })
      .catch((err) => apiLogger.warn({ err, msg: "checkout-session:clear-failed", registrationId }));
  } catch (err) {
    apiLogger.warn({ err, msg: "checkout-session:cleanup-failed", registrationId, ctx });
  }
}
