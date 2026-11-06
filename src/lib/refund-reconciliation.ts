import { db, dbOperator, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { notifyEventAdmins } from "@/lib/notifications";
import { findStripeRefundForAttempt } from "@/lib/stripe-refund-lookup";
import { recordAbsorbedRefunds } from "@/services/payment-service";
import { unbookRefund, UnbookAttemptMoved, UnbookNeedsReview, UnbookRaced, REFUND_IN_FLIGHT_LIMIT_MS, type UnbookSlice } from "@/services/refund-unbook";

// Moved to its own module (Nov 6, 2026) so the service and this sweep share it
// without importing each other; re-exported for existing callers.
export { findStripeRefundForAttempt, type StripeRefundVerification } from "@/lib/stripe-refund-lookup";

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
 *    and for manual attempts: PENDING (the process died before the status
 *    write) is confirmed; UNKNOWN (a rollback that did not apply) is rolled back.
 *    Every rollback goes through src/services/refund-unbook.ts, which sets a
 *    Stripe payment's counter from Stripe's own figure.
 */

const STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * A rollback the books refuse ("needs review") is retried for this long before
 * it goes final (third review, Nov 6 2026): the refusal is often a moment's
 * race, e.g. another refund of ours settling between the Stripe read and the
 * in-flight count. Final means the payment's counter stays raised for a human.
 */
const REVIEW_AFTER_MS = 60 * 60 * 1000;

/** Prefixes the note on an attempt already reported as stuck, so it is reported once. */
const STUCK_MARK = "STUCK:";

export interface RefundSweepResult {
  scanned: number;
  confirmed: number;
  rolledBack: number;
  needsReview: number;
  unverifiable: number;
  /** Touched by the refund service (or another sweep) since this tick read it: left alone. */
  moved: number;
  /** Not settled this tick on purpose (a race, a young refusal, waiting on Stripe siblings): noted and retried. Stripe unreachable counts as unverifiable. */
  retried: number;
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
      // Untouched for 10 minutes, not merely created 10 minutes ago: the refund
      // service touches each attempt just before sending it to Stripe, so a
      // refund still working through its slices is never mistaken for a dead one.
      updatedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) },
    },
    // Oldest TOUCH first: every attempt left unsettled gets a note (which touches
    // it), so a handful that cannot be settled never starve the rest of the queue.
    orderBy: { updatedAt: "asc" },
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

  const result: RefundSweepResult = { scanned: stale.length, confirmed: 0, rolledBack: 0, needsReview: 0, unverifiable: 0, moved: 0, retried: 0 };

  for (const attempt of stale) {
    try {
      // Per-row tenant context (multi-tenancy sweep): org resolved from the row itself — the candidate sweep stays org-blind (worker precondition, see MULTI_TENANCY.md §13).
      // Prefer the attempt's own denormalized organizationId, falling back to its
      // registration's; a NULL org (pre-backfill row) processes WITHOUT a wrap so
      // flag-off master behavior is unchanged. `continue` became `return` inside
      // the closure (same per-attempt control flow).
      const attemptOrg = attempt.organizationId ?? attempt.registration.organizationId ?? null;
      // Every status write is guarded on the attempt being exactly as this tick
      // read it, so the sweep can never settle an attempt the refund service is
      // still working on, nor reopen one already settled.
      // Leave the attempt unsettled, with a note saying why. The note touches
      // it, which sends it to the back of the queue and keeps it out of the
      // next 10 minutes' ticks.
      // Returns false when the attempt moved since this tick read it (then it is
      // counted as moved, not retried). A stuck attempt keeps its STUCK mark, so
      // the organisers are told once however many notes follow.
      const note = async (error: string) => {
        const keep = attempt.error?.startsWith(STUCK_MARK) && !error.startsWith(STUCK_MARK);
        const written = await db.refundAttempt.updateMany({
          where: { id: attempt.id, status: { in: ["PENDING", "UNKNOWN"] }, updatedAt: attempt.updatedAt },
          data: { error: keep ? `${STUCK_MARK} ${error}`.slice(0, 500) : error },
        });
        if (written.count === 0) result.moved++;
        return written.count > 0;
      };
      const ageMs = Date.now() - attempt.createdAt.getTime();
      const settle = async (data: { status: "SUCCEEDED" | "FAILED"; error?: string; stripeRefundId?: string | null }) => {
        const written = await db.refundAttempt.updateMany({
          where: { id: attempt.id, status: { in: ["PENDING", "UNKNOWN"] }, updatedAt: attempt.updatedAt },
          data,
        });
        if (written.count === 0) {
          apiLogger.info({ msg: "refund-sweep:attempt-moved — left alone", attemptId: attempt.id });
          result.moved++;
        }
        return written.count > 0;
      };
      // The money never moved: take this attempt's booking back out. One shared
      // rollback (src/services/refund-unbook.ts) for the service and the sweep;
      // it sets a Stripe payment's counter from Stripe's figure, so a Dashboard
      // refund that landed meanwhile is kept rather than erased, and it writes
      // everything or nothing.
      const rollBack = async (stripe: UnbookSlice["stripe"], failureNote: string) => {
      const amount = Number(attempt.amount);
      const unbooked = await tenantTransaction((tx) =>
        unbookRefund(tx, {
          registrationId: attempt.registrationId,
          slices: [{
            attemptId: attempt.id, paymentId: attempt.paymentId, take: amount, paymentBooked: attempt.paymentBooked, stripe,
            failureNote,
            expectedUpdatedAt: attempt.updatedAt,
          }],
          flippedToRefunded: attempt.flippedToRefunded,
        }),
      ).catch((err: unknown) => {
        // Settled or touched since this tick read it: not ours to judge.
        if (err instanceof UnbookAttemptMoved) return "moved" as const;
        if (err instanceof UnbookRaced || err instanceof UnbookNeedsReview) {
          apiLogger.warn({ msg: "refund-sweep:rollback-refused", attemptId: attempt.id, reason: err.message, ageMs });
          // A race settles itself; so, usually, does "needs review" within the
          // hour. Only an old refusal is final.
          if (err instanceof UnbookRaced || ageMs < REVIEW_AFTER_MS) return { retry: err.message };
          return null;
        }
        throw err;
      });

      if (typeof unbooked === "object" && unbooked !== null && "retry" in unbooked) {
        if (await note(`Rollback refused, retrying: ${unbooked.retry}`.slice(0, 500))) result.retried++;
        return;
      }

      if (unbooked === "moved") {
        apiLogger.info({ msg: "refund-sweep:attempt-moved — left alone", attemptId: attempt.id });
        result.moved++;
        return;
      }
      if (!unbooked) {
        // Something else already moved the registration's money state
        // (another refund, webhook reconcile). Don't guess — terminal +
        // human review.
        if (!(await settle({ status: "FAILED", error: "No refund at Stripe but registration state moved on — booking NOT rolled back, review manually" }))) return;
        apiLogger.error({ msg: "refund-sweep:rollback-state-moved-on", attemptId: attempt.id, registrationId: attempt.registrationId });
        notifyAdminsSafe(attempt.registration.eventId, {
          title: "⚠ Refund attempt needs manual review",
          message: `A crashed refund attempt for ${attendeeName(attempt)} could not be auto-reconciled — verify the refund state in Stripe and the registration's Billing tab.`,
        });
        result.needsReview++;
        return;
      }

      // The rollback marked the attempt FAILED in its own transaction.
      apiLogger.error({
        msg: "refund-sweep:rolled-back",
        attemptId: attempt.id,
        registrationId: attempt.registrationId,
        amount,
        unbooked: unbooked.unbooked,
        absorbed: unbooked.absorbed,
      });
      notifyAdminsSafe(attempt.registration.eventId, {
        title: "⚠ Refund did not complete",
        message: `A refund attempt for ${attendeeName(attempt)} died before reaching Stripe — the books were corrected automatically. Retry the refund from the registration's Billing tab.`,
      });
      if (unbooked.absorbed.length > 0 && !attemptOrg) {
        // Kept on both counters, but no organisation to issue the credit note under.
        apiLogger.error({ msg: "refund-sweep:absorbed-without-org — issue the credit note manually", attemptId: attempt.id, absorbed: unbooked.absorbed });
      }
      if (unbooked.absorbed.length > 0 && attemptOrg) {
        const payment = await db.payment.findUnique({ where: { id: unbooked.absorbed[0].paymentId }, select: { currency: true } });
        recordAbsorbedRefunds({
          registrationId: attempt.registrationId,
          eventId: attempt.registration.eventId,
          organizationId: attemptOrg,
          currency: (payment?.currency ?? "USD").toUpperCase(),
          absorbed: unbooked.absorbed,
          attendee: attempt.registration.attendee,
        });
      }
      result.rolledBack++;
      };
      const processAttempt = async () => {
      // Manual/offline refunds move no Stripe money: the booking IS the record.
      // A stale PENDING means the process died before the status write, so
      // confirm it. UNKNOWN is different: the refund service sets it on every
      // attempt left behind by a rollback that did not apply, so the booking
      // still holds money that never moved. Take it back.
      if (attempt.kind === "manual" && attempt.status === "PENDING") {
        // A refund still sending its Stripe slices leaves its manual attempt
        // PENDING too, so "stale" alone does not mean "the process died after
        // recording it". Confirm only once every Stripe sibling succeeded; wait
        // while any is unsettled; if one failed, the refund did not complete, so
        // take the manual part back like any other unsent attempt.
        const siblings = attempt.bookingId
          ? await db.refundAttempt.findMany({
              where: { bookingId: attempt.bookingId, kind: "stripe" },
              select: { status: true },
            })
          : [];
        if (siblings.some((x) => x.status === "PENDING" || x.status === "UNKNOWN")) {
          apiLogger.info({ msg: "refund-sweep:manual-waiting-for-stripe-siblings", attemptId: attempt.id });
          if (await note("Waiting for this refund's Stripe parts to settle")) result.retried++;
          return;
        }
        if (siblings.some((x) => x.status === "FAILED")) {
          return rollBack(null, "A Stripe part of this refund failed — manual part rolled back by sweep");
        }
        if (!(await settle({ status: "SUCCEEDED" }))) return;
        apiLogger.info({ msg: "refund-sweep:manual-confirmed", attemptId: attempt.id, registrationId: attempt.registrationId });
        result.confirmed++;
        return;
      }

      let stripe: UnbookSlice["stripe"] = null;
      if (attempt.kind !== "manual") {
        if (!attempt.stripePaymentIntentId) {
          // Shouldn't exist (stripe-kind attempts always carry the intent) —
          // terminal so it can't churn every tick; a human decides.
          if (!(await settle({ status: "FAILED", error: "No payment intent on a stripe-kind attempt — review manually (booking NOT rolled back)" }))) return;
          apiLogger.error({ msg: "refund-sweep:stripe-attempt-missing-intent", attemptId: attempt.id, registrationId: attempt.registrationId });
          result.needsReview++;
          return;
        }

        const outcome = await findStripeRefundForAttempt(attempt.stripePaymentIntentId, attempt.id, attemptOrg);
        if (!outcome.verified) {
          // Stripe could not be asked (unreachable, or this org's key no longer
          // reaches the charge's account). Retry next tick; past the in-flight
          // limit, tell the organisers once, because the webhook stops waiting
          // for it then and only a human can settle it.
          result.unverifiable++;
          const stuck = ageMs > REFUND_IN_FLIGHT_LIMIT_MS;
          const alreadyReported = attempt.error?.startsWith(STUCK_MARK) ?? false;
          if (stuck && !alreadyReported) {
            apiLogger.error({ msg: "refund-sweep:attempt-stuck — Stripe cannot be asked, review manually", attemptId: attempt.id, registrationId: attempt.registrationId, ageMs });
            notifyAdminsSafe(attempt.registration.eventId, {
              title: "⚠ Refund stuck: Stripe cannot confirm it",
              message: `A refund attempt for ${attendeeName(attempt)} has not been confirmed with Stripe for over six hours. Check the refund in the Stripe Dashboard and the registration's Billing tab; the books may hold a refund that never happened.`,
            });
          }
          const message = stuck ? `${STUCK_MARK} Stripe cannot confirm this refund; organisers notified` : "Stripe could not be asked; retrying";
          await note(alreadyReported ? (attempt.error ?? message) : message);
          return;
        }

        if (outcome.found) {
          // The refund went through; the booking was already correct.
          if (!(await settle({ status: "SUCCEEDED", stripeRefundId: outcome.refundId }))) return;
          apiLogger.info({ msg: "refund-sweep:confirmed-at-stripe", attemptId: attempt.id, registrationId: attempt.registrationId, stripeRefundId: outcome.refundId });
          result.confirmed++;
          return;
        }
        stripe = { refundedTotal: outcome.refundedTotal, attemptIds: outcome.attemptIds };
      }

      return rollBack(
        stripe,
        attempt.kind === "manual"
          ? "Never recorded (left UNKNOWN by the refund) — rolled back by sweep"
          : "No matching refund at Stripe — booking rolled back by sweep",
      );
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
