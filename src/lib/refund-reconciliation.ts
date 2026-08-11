import { db, dbOperator } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { getStripe } from "@/lib/stripe";
import { notifyEventAdmins } from "@/lib/notifications";

/**
 * Refund-attempt reconciliation (review H4/H5, July 10 2026).
 *
 * `refundRegistration` books the refund (bumps `refundedAmount`) and persists a
 * `RefundAttempt` row BEFORE calling Stripe. If the process dies mid-flight, or
 * Stripe's SDK throws on a refund that actually went through (timeouts), the
 * books and Stripe can disagree. Every Stripe refund we create carries
 * `metadata.refundAttemptId`, which makes the disagreement RESOLVABLE:
 *
 *  - `findStripeRefundForAttempt` — the ground-truth check ("did attempt X
 *    actually produce a refund at Stripe?"), used inline by the service's
 *    error path and by the sweep here.
 *  - `resolveStaleRefundAttempts` — the sweep. Runs from the reconciliation
 *    worker tick (every 10 min, alongside the invoice reconciliation) and
 *    settles any PENDING/UNKNOWN attempt older than 10 minutes:
 *      refund exists at Stripe → mark SUCCEEDED (booking already correct);
 *      refund provably absent   → roll the booking back + mark FAILED + alert;
 *      Stripe unreachable       → leave for the next tick.
 */

const STALE_AFTER_MS = 10 * 60 * 1000;

export type StripeRefundVerification =
  | { verified: true; found: boolean; refundId: string | null }
  | { verified: false };

/**
 * Ground-truth check against Stripe: does a refund tagged with this attempt id
 * exist? `organizationId` picks the Stripe account to ask (per-org keys) —
 * pass the registration's org; null falls back to the env account, which is
 * correct for every pre-feature row.
 */
export async function findStripeRefundForAttempt(
  paymentIntentId: string,
  attemptId: string,
  organizationId: string | null,
): Promise<StripeRefundVerification> {
  try {
    const stripe = await getStripe(organizationId);
    const refunds = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100 });
    const match = refunds.data.find((r) => r.metadata?.refundAttemptId === attemptId);
    return { verified: true, found: !!match, refundId: match?.id ?? null };
  } catch (err) {
    apiLogger.warn({ err, msg: "refund-verify:stripe-list-failed", paymentIntentId, attemptId });
    return { verified: false };
  }
}

export interface RefundSweepResult {
  scanned: number;
  confirmed: number;
  rolledBack: number;
  needsReview: number;
  unverifiable: number;
}

/**
 * Settle stale refund attempts. Per-attempt try/catch — one bad row can't kill
 * the tick. Every outcome logs; rollbacks and manual-review cases also notify
 * event admins (over-alerting on money is deliberate).
 */
export async function resolveStaleRefundAttempts(limit = 25): Promise<RefundSweepResult> {
  // Privileged lane (item 5, wired Aug 11 2026 after review H2). Missed in the
  // first pass because the surface list was built job by job and this is a
  // SIBLING inside invoice-reconciliation, whose main module was found.
  //
  // This is the worst place for that miss: the sweep exists to catch money that
  // got stuck, and an empty lane returns zero stale attempts, which is
  // indistinguishable from nothing being stuck. Refunds would sit PENDING
  // forever, never settle, never roll back, never raise manual review, and the
  // tick would log success. Per-attempt work below is already inside the row's
  // own tenant lane.
  const stale = await dbOperator.refundAttempt.findMany({
    where: {
      status: { in: ["PENDING", "UNKNOWN"] },
      createdAt: { lt: new Date(Date.now() - STALE_AFTER_MS) },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    include: {
      registration: {
        select: {
          eventId: true,
          organizationId: true,
          attendee: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });

  const result: RefundSweepResult = { scanned: stale.length, confirmed: 0, rolledBack: 0, needsReview: 0, unverifiable: 0 };

  for (const attempt of stale) {
    try {
      // Per-row tenant context (multi-tenancy sweep): org resolved from the row itself — the candidate sweep stays org-blind (worker precondition, see MULTI_TENANCY.md §13).
      // Prefer the attempt's own denormalized organizationId, falling back to its
      // registration's; a NULL org (pre-backfill row) processes WITHOUT a wrap so
      // flag-off master behavior is unchanged. `continue` became `return` inside
      // the closure (same per-attempt control flow).
      const attemptOrg = attempt.organizationId ?? attempt.registration.organizationId ?? null;
      const processAttempt = async () => {
      // Manual/offline refunds move no Stripe money — the booking IS the
      // record; a stale PENDING just means the process died before the
      // status update. Confirm it.
      if (attempt.kind === "manual") {
        await db.refundAttempt.update({ where: { id: attempt.id }, data: { status: "SUCCEEDED" } });
        apiLogger.info({ msg: "refund-sweep:manual-confirmed", attemptId: attempt.id, registrationId: attempt.registrationId });
        result.confirmed++;
        return;
      }

      if (!attempt.stripePaymentIntentId) {
        // Shouldn't exist (stripe-kind attempts always carry the intent) —
        // terminal so it can't churn every tick; a human decides.
        await db.refundAttempt.update({
          where: { id: attempt.id },
          data: { status: "FAILED", error: "No payment intent on a stripe-kind attempt — review manually (booking NOT rolled back)" },
        });
        apiLogger.error({ msg: "refund-sweep:stripe-attempt-missing-intent", attemptId: attempt.id, registrationId: attempt.registrationId });
        result.needsReview++;
        return;
      }

      const outcome = await findStripeRefundForAttempt(attempt.stripePaymentIntentId, attempt.id, attemptOrg);
      if (!outcome.verified) {
        // Stripe unreachable — try again next tick.
        result.unverifiable++;
        return;
      }

      if (outcome.found) {
        // The refund went through; the booking was already correct.
        await db.refundAttempt.update({
          where: { id: attempt.id },
          data: { status: "SUCCEEDED", stripeRefundId: outcome.refundId },
        });
        apiLogger.info({ msg: "refund-sweep:confirmed-at-stripe", attemptId: attempt.id, registrationId: attempt.registrationId, stripeRefundId: outcome.refundId });
        result.confirmed++;
        return;
      }

      // Provably no refund at Stripe → the booking overstates by this
      // attempt's amount. Un-book via a GUARDED DECREMENT (not a set-back):
      // sibling slices of the same refund — or webhook reconciliations of
      // other charges — may have legitimately moved the total in the
      // meantime; we only remove the portion THIS attempt booked.
      const rolledBack = await db.registration.updateMany({
        where: { id: attempt.registrationId, refundedAmount: { gte: Number(attempt.amount) } },
        data: {
          refundedAmount: { decrement: Number(attempt.amount) },
          ...(attempt.flippedToRefunded ? { paymentStatus: "PAID" as const } : {}),
        },
      });

      if (rolledBack.count === 0) {
        // Something else already moved the registration's money state
        // (another refund, webhook reconcile). Don't guess — terminal +
        // human review.
        await db.refundAttempt.update({
          where: { id: attempt.id },
          data: { status: "FAILED", error: "No refund at Stripe but registration state moved on — booking NOT rolled back, review manually" },
        });
        apiLogger.error({ msg: "refund-sweep:rollback-state-moved-on", attemptId: attempt.id, registrationId: attempt.registrationId });
        notifyAdminsSafe(attempt.registration.eventId, {
          title: "⚠ Refund attempt needs manual review",
          message: `A crashed refund attempt for ${attendeeName(attempt)} could not be auto-reconciled — verify the refund state in Stripe and the registration's Billing tab.`,
        });
        result.needsReview++;
        return;
      }

      await db.refundAttempt.update({
        where: { id: attempt.id },
        data: { status: "FAILED", error: "No matching refund at Stripe — booking rolled back by sweep" },
      });
      apiLogger.error({
        msg: "refund-sweep:rolled-back",
        attemptId: attempt.id,
        registrationId: attempt.registrationId,
        amount: Number(attempt.amount),
      });
      notifyAdminsSafe(attempt.registration.eventId, {
        title: "⚠ Refund did not complete",
        message: `A refund attempt for ${attendeeName(attempt)} died before reaching Stripe — the books were corrected automatically. Retry the refund from the registration's Billing tab.`,
      });
      result.rolledBack++;
      };
      if (attemptOrg) {
        await runWithTenant(attemptOrg, processAttempt);
      } else {
        await processAttempt();
      }
    } catch (err) {
      apiLogger.error({ err, msg: "refund-sweep:attempt-failed", attemptId: attempt.id });
    }
  }

  if (result.scanned > 0) {
    apiLogger.info({ msg: "refund-sweep:tick", ...result });
  }
  return result;
}

function attendeeName(attempt: { registration: { attendee: { firstName: string; lastName: string } } }): string {
  return `${attempt.registration.attendee.firstName} ${attempt.registration.attendee.lastName}`;
}

function notifyAdminsSafe(eventId: string, args: { title: string; message: string }) {
  notifyEventAdmins(eventId, {
    type: "PAYMENT",
    title: args.title,
    message: args.message,
    link: `/events/${eventId}/registrations`,
  }).catch((err) => apiLogger.error({ err, msg: "refund-sweep:notify-failed", eventId }));
}
