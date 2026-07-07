import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getStripe, toStripeAmount } from "@/lib/stripe";
import { notifyEventAdmins } from "@/lib/notifications";
import { computeRegistrationFinancials, readRegistrationBasePrice } from "@/lib/registration-financials";
import { refreshEventStats } from "@/lib/event-stats";

const round2 = (n: number) => Math.round(n * 100) / 100;

const bodySchema = z.object({
  /** Refund amount (tax-inclusive). Omit to refund the full remaining balance. */
  amount: z.number().positive().max(1_000_000).optional(),
});

/**
 * Issue a refund — full OR partial — for a paid registration.
 *
 * Gated on a credit note: a non-cancelled CREDIT_NOTE must already exist for the
 * registration (issued via the Issue-Credit-Note action). This route does NOT
 * create the credit note; it only records/executes the money movement.
 *
 * Partial refunds accumulate into `Registration.refundedAmount`. The
 * registration stays PAID while `refundedAmount < paidTotal` and flips to
 * REFUNDED only when the full paid amount has been returned. Supports Stripe
 * (partial `amount`) and manual/offline (record only) payments.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ eventId: string; registrationId: string }> }
) {
  const [session, { eventId, registrationId }] = await Promise.all([auth(), params]);

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const denied = denyReviewer(session);
  if (denied) return denied;

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    apiLogger.warn({ msg: "refund:invalid-input", eventId, registrationId, errors: parsed.error.flatten() });
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  apiLogger.info({ msg: "Refund requested", registrationId, eventId, issuedBy: session.user.id });

  try {
    const [event, registration] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, ...buildEventAccessWhere(session.user) },
        select: { id: true },
      }),
      db.registration.findUnique({
        where: { id: registrationId },
        select: {
          id: true,
          serialId: true,
          eventId: true,
          paymentStatus: true,
          refundedAmount: true,
          // originalPrice/discountAmount + tier/ticket price feed the computed
          // paid total when there's no Payment row to read (a PAID reg that
          // was hand-flipped without recording a payment).
          originalPrice: true,
          discountAmount: true,
          attendee: { select: { firstName: true, lastName: true, email: true, additionalEmail: true, title: true } },
          ticketType: { select: { name: true, price: true, currency: true } },
          pricingTier: { select: { price: true, currency: true } },
          event: { select: { id: true, organizationId: true, name: true, startDate: true, taxRate: true, taxLabel: true } },
          payments: {
            where: { status: "PAID" },
            orderBy: { createdAt: "desc" },
            select: { id: true, stripePaymentId: true, amount: true, currency: true },
          },
        },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!registration || registration.eventId !== eventId) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }
    if (registration.paymentStatus !== "PAID") {
      return NextResponse.json({ error: "Registration is not in a paid state" }, { status: 400 });
    }

    // ── Gate: a credit note must already exist ─────────────────────────────────
    // A refund never goes out without a credit note on record. The organizer
    // issues it first (Issue Credit Note), then refunds. We only require one to
    // exist — the refund amount is entered here independently.
    const creditNote = await db.invoice.findFirst({
      where: { registrationId, type: "CREDIT_NOTE", status: { not: "CANCELLED" } },
      select: { id: true },
    });
    if (!creditNote) {
      apiLogger.warn({ msg: "refund:credit-note-required", registrationId, eventId });
      return NextResponse.json(
        { error: "Issue a credit note for this registration before refunding.", code: "CREDIT_NOTE_REQUIRED" },
        { status: 409 },
      );
    }

    // Most recent PAID payment. A Stripe payment carries a `stripePaymentId`;
    // a MANUAL/offline payment (cash / bank transfer / card-onsite) does not.
    // A PAID registration with no Payment row at all (admin hand-flipped the
    // status) is treated as a manual refund — nothing to reverse in Stripe.
    const payment = registration.payments[0];
    const isManualRefund = !payment?.stripePaymentId;

    const currency = (
      payment?.currency ||
      registration.pricingTier?.currency ||
      registration.ticketType?.currency ||
      "USD"
    ).toUpperCase();

    // Total collected — sum of PAID payments, else the computed registration
    // total (tax-inclusive) when there's no Payment row.
    const paidTotal = registration.payments.length
      ? round2(registration.payments.reduce((s, p) => s + Number(p.amount), 0))
      : round2(
          computeRegistrationFinancials({
            subtotal: readRegistrationBasePrice(registration),
            discount: registration.discountAmount ? Number(registration.discountAmount) : 0,
            taxRate: registration.event.taxRate ? Number(registration.event.taxRate) : null,
            taxLabel: registration.event.taxLabel,
            currency,
            totalPaid: 0,
          }).total,
        );

    const refundedBefore = round2(Number(registration.refundedAmount));
    const remaining = round2(paidTotal - refundedBefore);
    if (remaining <= 0) {
      return NextResponse.json({ error: "This registration has already been fully refunded." }, { status: 400 });
    }

    const amount = parsed.data.amount != null ? round2(parsed.data.amount) : remaining;
    if (amount <= 0 || amount > remaining + 0.005) {
      apiLogger.warn({ msg: "refund:amount-out-of-range", registrationId, amount, remaining, paidTotal });
      return NextResponse.json(
        {
          error: `Refund amount must be between ${currency} 0.01 and ${currency} ${remaining.toFixed(2)} (already refunded ${currency} ${refundedBefore.toFixed(2)} of ${currency} ${paidTotal.toFixed(2)}).`,
          code: "INVALID_AMOUNT",
          remaining,
          paidTotal,
          refundedBefore,
        },
        { status: 400 },
      );
    }

    const refundedAfter = round2(refundedBefore + amount);
    const isFull = refundedAfter >= paidTotal - 0.005;
    const formattedAmount = `${currency} ${amount.toFixed(2)}`;

    // Optimistic lock on the running refunded total: an `updateMany` guarded by
    // the observed `refundedAmount` so two concurrent refund clicks can't both
    // commit (the loser sees count 0). Flips to REFUNDED only on a full refund.
    const locked = await db.registration.updateMany({
      where: { id: registrationId, paymentStatus: "PAID", refundedAmount: registration.refundedAmount },
      data: {
        refundedAmount: refundedAfter,
        ...(isFull ? { paymentStatus: "REFUNDED" as const } : {}),
      },
    });
    if (locked.count === 0) {
      return NextResponse.json({ error: "A refund for this registration is already in progress." }, { status: 409 });
    }

    let stripeRefundId: string | null = null;
    if (isManualRefund) {
      // Offline refund — no Stripe charge to reverse. The organizer returns the
      // money out-of-band; we record the reversal + flip the Payment row on full.
      apiLogger.info({
        msg: "Manual/offline refund recorded (no Stripe charge to reverse)",
        registrationId,
        eventId,
        paymentId: payment?.id ?? null,
        amount,
        currency,
        partial: !isFull,
        issuedBy: session.user.id,
      });
    } else {
      // Stripe partial refund. The idempotency key carries the cumulative
      // refunded total so each partial is distinct but a retry of the SAME
      // partial dedups.
      try {
        const stripe = getStripe();
        const refund = await stripe.refunds.create(
          { payment_intent: payment!.stripePaymentId!, amount: toStripeAmount(amount, currency) },
          { idempotencyKey: `refund-${payment!.id}-${refundedAfter.toFixed(2)}` }
        );
        stripeRefundId = refund.id;
      } catch (stripeErr) {
        // Roll the running total back to what it was — no money moved.
        await db.registration.update({
          where: { id: registrationId },
          data: { refundedAmount: registration.refundedAmount, paymentStatus: "PAID" },
        }).catch((rollbackErr) => apiLogger.error({ rollbackErr, msg: "Failed to roll back refunded amount after Stripe error", registrationId }));
        apiLogger.error({ err: stripeErr, msg: "Stripe refund failed", registrationId, paymentIntentId: payment!.stripePaymentId });
        return NextResponse.json({ error: "Refund could not be processed. Please try again or issue the refund directly in Stripe." }, { status: 502 });
      }
      apiLogger.info({
        msg: "Refund issued",
        registrationId,
        eventId,
        stripeRefundId,
        amount,
        currency,
        partial: !isFull,
        refundedAfter,
        paidTotal,
        issuedBy: session.user.id,
      });
    }

    // Flip the Payment record to REFUNDED only on a FULL refund (a partial
    // refund leaves the payment PAID so `paidTotal` still sums correctly).
    if (isFull && payment) {
      await db.payment.update({
        where: { id: payment.id },
        data: { status: "REFUNDED" },
      });
    }

    refreshEventStats(eventId);

    notifyEventAdmins(eventId, {
      type: "PAYMENT",
      title: isFull ? "Refund Issued" : "Partial Refund Issued",
      message: `${isFull ? "Refund" : "Partial refund"} of ${formattedAmount} issued to ${registration.attendee.firstName} ${registration.attendee.lastName}${isFull ? "" : ` (${currency} ${refundedAfter.toFixed(2)} of ${currency} ${paidTotal.toFixed(2)})`}`,
      link: `/events/${eventId}/registrations`,
    }).catch((err: unknown) => apiLogger.error({ err, msg: "Failed to send refund admin notification" }));

    // NOTE: no automatic refund-confirmation email is sent to the attendee.
    // The organizer communicates the refund manually (consistent with the
    // credit-note flow, which is also organizer-sent). The admin notification
    // above is in-app only.

    return NextResponse.json({
      refundId: stripeRefundId,
      manual: isManualRefund,
      status: stripeRefundId ? "succeeded" : "recorded",
      amount,
      currency,
      refundedAmount: refundedAfter,
      paidTotal,
      fullyRefunded: isFull,
    });
  } catch (err) {
    apiLogger.error({ err, msg: "Failed to issue refund", registrationId, eventId });
    return NextResponse.json({ error: "Failed to issue refund" }, { status: 500 });
  }
}

