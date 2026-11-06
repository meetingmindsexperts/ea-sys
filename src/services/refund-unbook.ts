import type { Prisma } from "@prisma/client";
import { round2 } from "@/lib/registration-financials";

/**
 * Taking a refund booking back out of the books, when the refund's money never
 * moved (security audit W0-1 follow-up, Nov 6, 2026).
 *
 * The ONE rollback, used by the refund service when a Stripe slice fails and by
 * the reconciliation sweep for attempts left PENDING or UNKNOWN. Two copies had
 * already drifted once.
 *
 * WHY NOT JUST SUBTRACT. A booking raises Registration.refundedAmount and the
 * payment's own counter before Stripe is called, and the charge.refunded
 * webhook decides "already counted" from that payment counter. A Stripe
 * Dashboard refund landing in that window is therefore skipped by its webhook
 * (the counter already looks high enough). Subtracting our slice afterwards
 * would erase it from the books for good, with no webhook left to redeliver.
 * So for a Stripe payment the counter is set from what Stripe says, plus our
 * own bookings still in flight that Stripe does not know about yet:
 *
 *   counter := Stripe's refunded total + other in-flight attempts on this payment
 *
 * Whatever that adds beyond the counter without our slice is a refund Stripe
 * made that we had not recorded ("absorbed"); it stays on the registration too,
 * and the caller records its credit note and tells the organisers.
 *
 * ALL OR NOTHING. Every write is optimistic on the value just read and the
 * whole thing runs in the caller's transaction; any surprise throws, which
 * rolls back everything already written. A throw is never a partial un-book.
 */

export interface UnbookSlice {
  attemptId: string;
  /** null: unattributed residue (a PAID registration with no payment rows). */
  paymentId: string | null;
  take: number;
  /** Whether this attempt's booking raised the payment counter (RefundAttempt.paymentBooked). */
  paymentBooked: boolean;
  /** Stripe's view of the payment's intent; null for manual payments and residue. */
  stripe: { refundedTotal: number; attemptIds: string[] } | null;
}

export interface UnbookResult {
  /** How much came off the registration's refunded total. */
  unbooked: number;
  /** Stripe refunds found on the way that the books did not hold. */
  absorbed: Array<{ paymentId: string; amount: number }>;
  registrationRefunded: number;
}

/** The counters moved under us (a concurrent refund or webhook). Retry later. */
export class UnbookRaced extends Error {}

/** The books hold more than Stripe and our in-flight attempts explain. A human decides. */
export class UnbookNeedsReview extends Error {}

export async function unbookRefund(
  tx: Prisma.TransactionClient,
  args: { registrationId: string; slices: UnbookSlice[]; flippedToRefunded: boolean },
): Promise<UnbookResult> {
  const { registrationId, slices } = args;
  const reg = await tx.registration.findUnique({
    where: { id: registrationId },
    select: { refundedAmount: true, paymentStatus: true },
  });
  if (!reg) throw new UnbookRaced(`registration ${registrationId} not found`);

  const unbookingIds = slices.map((s) => s.attemptId);
  const absorbed: UnbookResult["absorbed"] = [];
  let regDelta = 0;

  for (const s of slices) {
    if (!s.paymentId) {
      regDelta -= s.take;
      continue;
    }
    const pay = await tx.payment.findUnique({
      where: { id: s.paymentId },
      select: { refundedAmount: true, amount: true },
    });
    if (!pay) throw new UnbookRaced(`payment ${s.paymentId} not found`);

    const counter = Number(pay.refundedAmount);
    const amount = Number(pay.amount);
    // The counter as it would stand without this slice's own booking.
    const base = round2(counter - (s.paymentBooked ? s.take : 0));
    let target = base;

    if (s.stripe) {
      // Our other bookings on this payment that have not reached Stripe yet:
      // they are in the counter and not in Stripe's total, so keep them.
      const inFlight = await tx.refundAttempt.findMany({
        where: {
          paymentId: s.paymentId,
          status: { in: ["PENDING", "UNKNOWN"] },
          paymentBooked: true,
          id: { notIn: unbookingIds },
        },
        select: { id: true, amount: true },
      });
      const known = new Set(s.stripe.attemptIds);
      const pending = inFlight.filter((a) => !known.has(a.id)).reduce((sum, a) => sum + Number(a.amount), 0);
      target = round2(Math.min(amount, s.stripe.refundedTotal + pending));
      if (target < base - 0.005) {
        // The counter claims refunds that neither Stripe nor any attempt of ours
        // accounts for. Guessing which number is wrong could erase real money.
        throw new UnbookNeedsReview(
          `payment ${s.paymentId}: counter without this slice ${base}, Stripe and in-flight ${target}`,
        );
      }
    }
    if (base < -0.005) throw new UnbookNeedsReview(`payment ${s.paymentId}: counter ${counter} below this slice ${s.take}`);

    const written = await tx.payment.updateMany({
      where: { id: s.paymentId, refundedAmount: pay.refundedAmount },
      data: {
        refundedAmount: target,
        status: target >= amount - 0.005 ? "REFUNDED" : "PAID",
      },
    });
    if (written.count === 0) throw new UnbookRaced(`payment ${s.paymentId} moved`);

    const found = round2(target - base);
    if (found > 0.005) absorbed.push({ paymentId: s.paymentId, amount: found });
    regDelta += -s.take + found;
  }

  const registrationRefunded = round2(Number(reg.refundedAmount) + regDelta);
  if (registrationRefunded < -0.005) {
    throw new UnbookNeedsReview(`registration ${registrationId}: refunded total would go to ${registrationRefunded}`);
  }

  // Whether it is still fully refunded is read from the money, not assumed: a
  // refund absorbed on the way can leave it full even though ours failed.
  let paymentStatus: "PAID" | "REFUNDED" | undefined;
  if (reg.paymentStatus === "PAID" || reg.paymentStatus === "REFUNDED") {
    const paid = await tx.payment.aggregate({
      where: { registrationId, status: { in: ["PAID", "REFUNDED"] } },
      _sum: { amount: true },
    });
    const paidTotal = paid._sum.amount == null ? null : Number(paid._sum.amount);
    if (paidTotal != null && paidTotal > 0) {
      paymentStatus = registrationRefunded >= paidTotal - 0.005 ? "REFUNDED" : "PAID";
    } else if (args.flippedToRefunded) {
      // No payment rows (a registration hand-flipped to PAID): the booking's own flag decides.
      paymentStatus = "PAID";
    }
  }

  const regWritten = await tx.registration.updateMany({
    where: { id: registrationId, refundedAmount: reg.refundedAmount },
    data: { refundedAmount: registrationRefunded, ...(paymentStatus ? { paymentStatus } : {}) },
  });
  if (regWritten.count === 0) throw new UnbookRaced(`registration ${registrationId} moved`);

  return { unbooked: round2(-regDelta), absorbed, registrationRefunded };
}
