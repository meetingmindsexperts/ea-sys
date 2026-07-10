import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getStripe, fromStripeAmount } from "@/lib/stripe";
import type Stripe from "stripe";
import { notifyEventAdmins } from "@/lib/notifications";
import { createCreditNote, sendInvoiceEmail, issuePaidRegistrationDocuments } from "@/lib/invoice-service";
import { refreshEventStats } from "@/lib/event-stats";
import { readRegistrationBasePrice } from "@/lib/registration-financials";
import { captureStripeReceipt } from "@/lib/stripe-receipt";

export async function POST(req: Request) {
  let event: Stripe.Event;

  try {
    // Must read raw body for signature verification — do NOT use req.json()
    const body = await req.text();
    const sig = req.headers.get("stripe-signature");

    if (!sig) {
      apiLogger.warn({ msg: "Stripe webhook missing signature header" });
      return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      apiLogger.error({ msg: "STRIPE_WEBHOOK_SECRET not configured" });
      return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
    }

    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err) {
    apiLogger.error({ err, msg: "Stripe webhook signature verification failed" });
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Handle checkout.session.completed
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const registrationId = session.metadata?.registrationId;

    if (!registrationId) {
      apiLogger.warn({ msg: "Stripe checkout session missing registrationId metadata", sessionId: session.id });
      return NextResponse.json({ received: true });
    }

    try {
      // Look up registration. `serialId` is included so the payment
      // confirmation email can display the same short "Registration #"
      // the user saw in their initial confirmation — gives continuity
      // instead of surfacing the internal cuid.
      const registration = await db.registration.findUnique({
        where: { id: registrationId },
        include: {
          attendee: { select: { firstName: true, lastName: true, email: true, additionalEmail: true, title: true } },
          ticketType: { select: { name: true, price: true, currency: true } },
          pricingTier: { select: { price: true, currency: true } },
          event: { select: { id: true, organizationId: true, name: true, slug: true, startDate: true, venue: true, city: true, taxRate: true, taxLabel: true } },
        },
      });

      if (!registration) {
        apiLogger.warn({ msg: "Stripe webhook: registration not found", registrationId, sessionId: session.id });
        return NextResponse.json({ received: true });
      }

      const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || null;
      const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id || null;

      // Idempotency is CHARGE-level, not registration-level. "Is this reg
      // already PAID?" says nothing about whether THIS session's money was
      // recorded — a registration can legitimately be charged twice (two open
      // checkout tabs, or desk cash racing a Stripe checkout), and skipping on
      // paymentStatus silently dropped the second real settlement from the
      // books. `Payment.stripePaymentId` is unique, so an existing row for
      // this intent means this event was already processed (webhook retry).
      if (paymentIntentId) {
        const existingPayment = await db.payment.findUnique({
          where: { stripePaymentId: paymentIntentId },
          select: { id: true },
        });
        if (existingPayment) {
          apiLogger.info({ msg: "Stripe webhook: payment intent already recorded, skipping", registrationId, paymentIntentId });
          return NextResponse.json({ received: true });
        }
      } else if (registration.paymentStatus === "PAID") {
        // No payment intent to key on (shouldn't happen in payment mode) —
        // fall back to the old registration-level skip rather than risk a
        // duplicate row with a null unique key.
        apiLogger.warn({ msg: "Stripe webhook: no payment_intent on session and registration already paid, skipping", registrationId, sessionId: session.id });
        return NextResponse.json({ received: true });
      }

      // A payment can land on a CANCELLED registration: the checkout route
      // excludes CANCELLED only at session-CREATE time, and Stripe sessions
      // live ~24h — an admin cancel in that window doesn't close the open
      // payment tab. Money truth wins: we still record the Payment row and
      // flip PAID below (so the gated refund flow can reverse it), but we
      // suppress the attendee-facing documents email and replace the routine
      // "Payment Received" notification with a loud refund-required alert.
      const paidOnCancelledRegistration = registration.status === "CANCELLED";

      const sessionCurrency = (session.currency || registration.pricingTier?.currency || registration.ticketType?.currency || "USD").toUpperCase();
      const amount = session.amount_total
        ? fromStripeAmount(session.amount_total, sessionCurrency)
        : readRegistrationBasePrice(registration);
      const currency = sessionCurrency;

      // Pull the latest charge off the PaymentIntent to capture:
      //   - Stripe's own receipt URL (we surface this in the portal)
      //   - payment_method_details — card brand + last 4, or bank-transfer
      //     type, so the Billing panel and the Invoice PDF can reconcile
      //     "Paid via Visa ending 4242 on 2026-04-24"
      //   - the actual settlement timestamp (`charge.created`), distinct
      //     from our row-insert time which drifts under webhook retries
      let receiptUrl: string | null = null;
      let cardBrand: string | null = null;
      let cardLast4: string | null = null;
      let paymentMethodType: string | null = null;
      let paidAt: Date | null = null;
      if (paymentIntentId) {
        try {
          const stripe = getStripe();
          const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
          const chargeId = typeof paymentIntent.latest_charge === "string"
            ? paymentIntent.latest_charge
            : paymentIntent.latest_charge?.id;
          if (chargeId) {
            const charge = await stripe.charges.retrieve(chargeId);
            receiptUrl = charge.receipt_url || null;
            const pmd = charge.payment_method_details;
            if (pmd) {
              paymentMethodType = pmd.type || null;
              if (pmd.card) {
                cardBrand = pmd.card.brand || null;
                cardLast4 = pmd.card.last4 || null;
              }
            }
            if (charge.created) {
              paidAt = new Date(charge.created * 1000);
            }
          }
        } catch (err) {
          apiLogger.warn({ err, msg: "Failed to fetch Stripe receipt URL / payment method details", paymentIntentId });
        }
      }

      // Record the money. The Payment row is created UNCONDITIONALLY — even
      // when the registration is already PAID via another channel (a second
      // checkout session, or a desk cash capture that won the race). Dropping
      // the row was the old behavior and left a real Stripe charge invisible
      // to paidTotal, refund caps, and finance exports. When the reg was
      // already PAID we don't touch paymentStatus; we flag the over-collection
      // to admins below instead.
      let duplicateCharge = false;
      try {
        await db.$transaction(async (tx) => {
          const current = await tx.registration.findUnique({
            where: { id: registrationId },
            select: { paymentStatus: true },
          });
          duplicateCharge = current?.paymentStatus === "PAID";

          if (!duplicateCharge) {
            await tx.registration.update({
              where: { id: registrationId },
              data: { paymentStatus: "PAID" },
            });
          }
          await tx.payment.create({
            data: {
              registrationId,
              amount,
              currency,
              stripePaymentId: paymentIntentId,
              stripeCustomerId: customerId,
              status: "PAID",
              receiptUrl,
              stripeReceiptUrl: receiptUrl,
              cardBrand,
              cardLast4,
              paymentMethodType,
              paidAt: paidAt ?? new Date(),
              metadata: { checkoutSessionId: session.id },
            },
          });
        });
      } catch (txErr) {
        // A concurrent retry of the SAME event recorded the intent between our
        // pre-check and this insert — the unique on stripePaymentId caught it.
        // That's a completed processing, not a failure.
        if (txErr instanceof Prisma.PrismaClientKnownRequestError && txErr.code === "P2002") {
          apiLogger.info({ msg: "Stripe webhook: concurrent retry already recorded this intent, skipping", registrationId, paymentIntentId });
          return NextResponse.json({ received: true });
        }
        throw txErr;
      }

      if (duplicateCharge) {
        // Money collected twice — both rows are now on the books; a human
        // decides which charge to refund.
        apiLogger.error({
          msg: "stripe-webhook:duplicate-charge-recorded",
          registrationId,
          eventId: registration.event.id,
          amount,
          currency,
          stripeSessionId: session.id,
          paymentIntentId,
        });
        notifyEventAdmins(registration.event.id, {
          type: "PAYMENT",
          title: "⚠ Possible double payment",
          message: `${registration.attendee.firstName} ${registration.attendee.lastName} paid ${currency} ${amount.toFixed(2)} but the registration was already paid — check the Billing tab and refund the duplicate charge if confirmed.`,
          link: `/events/${registration.event.id}/registrations`,
        }).catch((err) => apiLogger.error({ err, msg: "Failed to send duplicate-charge notification" }));
        // No documents email — the attendee shouldn't receive a second PAID
        // invoice for a charge that's about to be refunded.
        return NextResponse.json({ received: true });
      }

      apiLogger.info({
        msg: "Payment completed via Stripe",
        registrationId,
        eventId: registration.event.id,
        amount,
        currency,
        stripeSessionId: session.id,
      });

      // Refresh denormalized event stats (fire-and-forget)
      refreshEventStats(registration.event.id);

      if (paidOnCancelledRegistration) {
        // Money collected for a seat that was already released — needs a human.
        apiLogger.error({
          msg: "stripe-webhook:payment-on-cancelled-registration",
          registrationId,
          eventId: registration.event.id,
          amount,
          currency,
          stripeSessionId: session.id,
          paymentIntentId,
        });
        notifyEventAdmins(registration.event.id, {
          type: "PAYMENT",
          title: "⚠ Payment on a CANCELLED registration",
          message: `${registration.attendee.firstName} ${registration.attendee.lastName} paid ${currency} ${amount.toFixed(2)} on a cancelled registration — issue a refund from the registration's Billing tab.`,
          link: `/events/${registration.event.id}/registrations`,
        }).catch((err) => apiLogger.error({ err, msg: "Failed to send cancelled-payment notification" }));
        // No attendee documents email — the registration is cancelled; the
        // organizer refunds and communicates manually.
        return NextResponse.json({ received: true });
      }

      // Notify admins/organizers (non-blocking)
      notifyEventAdmins(registration.event.id, {
        type: "PAYMENT",
        title: "Payment Received",
        message: `${registration.attendee.firstName} ${registration.attendee.lastName} paid ${currency} ${amount.toFixed(2)}`,
        link: `/events/${registration.event.id}/registrations`,
      }).catch((err) => apiLogger.error({ err, msg: "Failed to send payment notification" }));

      // Post-payment documents: mint the PAID invoice + the receipt and send
      // ONE combined "payment received" email carrying both PDFs, plus Stripe's
      // hosted-receipt link. Replaces the previously-separate payment-
      // confirmation and invoice emails. Non-blocking; idempotent end-to-end
      // so a webhook retry won't duplicate documents or emails.
      (async () => {
        try {
          const payment = await db.payment.findFirst({
            where: { registrationId, status: "PAID" },
            orderBy: { createdAt: "desc" },
            select: { id: true },
          });
          if (payment) {
            await issuePaidRegistrationDocuments({
              registrationId,
              eventId: registration.event.id,
              organizationId: registration.event.organizationId,
              paymentId: payment.id,
              paymentMethod: paymentMethodType || "card",
              paymentReference: paymentIntentId || undefined,
              paidAt: paidAt ?? undefined,
              amount,
              currency,
              receiptUrl,
            });

            // Store a durable local snapshot of Stripe's hosted receipt so it
            // survives if the Stripe URL ever breaks. Isolated try/catch — a
            // capture failure must never affect document issuance.
            if (receiptUrl) {
              try {
                const stripeReceiptFile = await captureStripeReceipt(receiptUrl);
                if (stripeReceiptFile) {
                  await db.payment.update({ where: { id: payment.id }, data: { stripeReceiptFile } });
                }
              } catch (err) {
                apiLogger.error({ err, msg: "Failed to capture Stripe receipt snapshot", registrationId, paymentId: payment.id });
              }
            }
          }
        } catch (err) {
          apiLogger.error({ err, msg: "Failed to issue post-payment documents", registrationId });
        }
      })();
    } catch (err) {
      apiLogger.error({ err, msg: "Error processing Stripe checkout.session.completed", registrationId });
      // Return 500 so Stripe retries
      return NextResponse.json({ error: "Processing failed" }, { status: 500 });
    }
  }

  // Handle checkout.session.expired — release stuck PENDING registrations
  if (event.type === "checkout.session.expired") {
    const session = event.data.object as Stripe.Checkout.Session;
    const registrationId = session.metadata?.registrationId;
    if (!registrationId) return NextResponse.json({ received: true });

    try {
      const updated = await db.registration.updateMany({
        where: { id: registrationId, paymentStatus: "PENDING" },
        data: { paymentStatus: "UNPAID" },
      });
      if (updated.count > 0) {
        apiLogger.info({ msg: "Checkout session expired — registration reset to UNPAID", registrationId, sessionId: session.id });
      }
    } catch (err) {
      apiLogger.error({ err, msg: "Error handling checkout.session.expired", registrationId });
      return NextResponse.json({ error: "Processing failed" }, { status: 500 });
    }
  }

  // Handle charge.refunded — update status when refund is issued (e.g. via Stripe Dashboard)
  if (event.type === "charge.refunded") {
    const charge = event.data.object as Stripe.Charge;
    const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
    if (!paymentIntentId) return NextResponse.json({ received: true });

    try {
      const payment = await db.payment.findUnique({
        where: { stripePaymentId: paymentIntentId },
        select: {
          id: true,
          amount: true,
          refundedAmount: true,
          registrationId: true,
          registration: {
            select: {
              eventId: true,
              refundedAmount: true,
              event: { select: { organizationId: true } },
            },
          },
        },
      });
      if (!payment) {
        // Stripe doesn't guarantee event ordering: charge.refunded can beat
        // checkout.session.completed (the payment handler does two synchronous
        // Stripe reads before its DB tx). Acking a young charge with 200 would
        // lose the refund forever — Stripe never redelivers a 200. Return 500
        // so Stripe retries until the Payment row exists. An OLD charge with
        // no row is likely foreign to this system (or truly orphaned) — ack it
        // so a shared Stripe account can't wedge the webhook endpoint.
        const chargeAgeMs = charge.created
          ? Date.now() - charge.created * 1000
          : Number.MAX_SAFE_INTEGER;
        if (chargeAgeMs < 24 * 60 * 60 * 1000) {
          apiLogger.warn({
            msg: "charge.refunded: no Payment record yet — 500 so Stripe retries (likely out-of-order delivery)",
            paymentIntentId,
            chargeAgeMs,
          });
          return NextResponse.json({ error: "Payment record not found yet" }, { status: 500 });
        }
        apiLogger.warn({ msg: "charge.refunded: no Payment record found", paymentIntentId });
        return NextResponse.json({ received: true });
      }

      const round2 = (n: number) => Math.round(n * 100) / 100;
      // Stripe's `amount_refunded` is the CUMULATIVE refunded total FOR THIS
      // CHARGE (minor units). Reconcile it against the PER-PAYMENT counter
      // (`Payment.refundedAmount`), NOT the registration's mixed total —
      // `Registration.refundedAmount` also accumulates manual/offline refunds,
      // and comparing Stripe's per-charge cumulative against the mixed number
      // either under-recorded (a prior manual refund ate the delta and the
      // Stripe refund vanished from the books) or mislabeled remaining
      // balances on mixed Stripe+manual registrations (review M4).
      const cumulativeRefunded = round2(fromStripeAmount(charge.amount_refunded, charge.currency));
      const alreadyForPayment = round2(Number(payment.refundedAmount));
      const delta = round2(cumulativeRefunded - alreadyForPayment);

      // A route-initiated refund already bumped THIS payment's counter, so a
      // delta of 0 means "already accounted for" → skip (idempotent on
      // retries too). Only a Stripe-Dashboard (out-of-band) refund advances it.
      if (delta <= 0) {
        apiLogger.info({ msg: "charge.refunded: already reconciled, skipping", registrationId: payment.registrationId, paymentIntentId, cumulativeRefunded });
        return NextResponse.json({ received: true });
      }

      // Claim the delta atomically on the PAYMENT row — optimistic on the
      // observed counter so two concurrent deliveries can't both advance it /
      // both mint a CN. The loser 500s and Stripe's retry re-reads a counter
      // that already includes the winner's delta (→ delta ≤ 0 → skip).
      const paymentFullyRefunded = cumulativeRefunded >= Number(payment.amount) - 0.005;
      const claimed = await db.payment.updateMany({
        where: { id: payment.id, refundedAmount: payment.refundedAmount },
        data: {
          refundedAmount: cumulativeRefunded,
          ...(paymentFullyRefunded ? { status: "REFUNDED" as const } : {}),
        },
      });
      if (claimed.count === 0) {
        apiLogger.warn({ msg: "charge.refunded: payment counter moved concurrently — 500 so Stripe retries", registrationId: payment.registrationId, paymentIntentId });
        return NextResponse.json({ error: "Concurrent reconciliation" }, { status: 500 });
      }

      // Roll the delta up into the registration's mixed running total, and
      // flip the whole reg REFUNDED only when the new total covers everything
      // collected (settled = PAID + REFUNDED rows — refunded payments still
      // represent money that was collected).
      const paidAgg = await db.payment.aggregate({
        where: { registrationId: payment.registrationId, status: { in: ["PAID", "REFUNDED"] } },
        _sum: { amount: true },
      });
      const paidTotal = round2(Number(paidAgg._sum.amount ?? payment.amount));
      const updatedReg = await db.registration.update({
        where: { id: payment.registrationId },
        data: { refundedAmount: { increment: delta } },
        select: { refundedAmount: true },
      });
      const newRegTotal = round2(Number(updatedReg.refundedAmount));
      const isFull = newRegTotal >= paidTotal - 0.005;
      if (isFull) {
        await db.registration.updateMany({
          where: { id: payment.registrationId, paymentStatus: "PAID" },
          data: { paymentStatus: "REFUNDED" },
        });
      }

      apiLogger.info({
        msg: "Refund reconciled via Stripe webhook",
        registrationId: payment.registrationId,
        paymentIntentId,
        delta,
        cumulativeRefunded,
        regRefundedTotal: newRegTotal,
        paidTotal,
        partial: !isFull,
      });

      // Auto-create a credit note for this refund delta (out-of-band Dashboard
      // refund has no route-issued CN). Non-blocking; keyed off the claimed delta
      // so retries — which no-op above — never duplicate it.
      (async () => {
        try {
          const { invoice: cn } = await createCreditNote({
            registrationId: payment.registrationId,
            eventId: payment.registration.eventId,
            organizationId: payment.registration.event.organizationId,
            amount: delta,
            reason: isFull ? "Refund via Stripe" : `Partial refund via Stripe (${charge.currency.toUpperCase()} ${delta.toFixed(2)})`,
          });
          await sendInvoiceEmail(cn.id);
        } catch (err) {
          apiLogger.error({ err, msg: "Failed to auto-create credit note", registrationId: payment.registrationId });
        }
      })();
    } catch (err) {
      apiLogger.error({ err, msg: "Error handling charge.refunded", paymentIntentId });
      return NextResponse.json({ error: "Processing failed" }, { status: 500 });
    }
  }

  // Handle payment_intent.payment_failed — log for visibility
  if (event.type === "payment_intent.payment_failed") {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const errorMessage = paymentIntent.last_payment_error?.message || "Unknown error";
    apiLogger.warn({
      msg: "Stripe payment failed",
      paymentIntentId: paymentIntent.id,
      error: errorMessage,
      code: paymentIntent.last_payment_error?.code,
    });
  }

  return NextResponse.json({ received: true });
}
