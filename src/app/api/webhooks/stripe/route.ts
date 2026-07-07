import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getStripe, fromStripeAmount } from "@/lib/stripe";
import type Stripe from "stripe";
import { notifyEventAdmins } from "@/lib/notifications";
import { createCreditNote, sendInvoiceEmail, issuePaidRegistrationDocuments } from "@/lib/invoice-service";
import { refreshEventStats } from "@/lib/event-stats";
import { readRegistrationBasePrice } from "@/lib/registration-financials";

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

      // Idempotency: skip if already paid
      if (registration.paymentStatus === "PAID") {
        apiLogger.info({ msg: "Stripe webhook: registration already paid, skipping", registrationId });
        return NextResponse.json({ received: true });
      }

      const sessionCurrency = (session.currency || registration.pricingTier?.currency || registration.ticketType?.currency || "USD").toUpperCase();
      const amount = session.amount_total
        ? fromStripeAmount(session.amount_total, sessionCurrency)
        : readRegistrationBasePrice(registration);
      const currency = sessionCurrency;
      const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || null;
      const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id || null;

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

      // Interactive transaction with optimistic lock to prevent duplicate Payment records
      // from concurrent webhook retries
      await db.$transaction(async (tx) => {
        // Re-check inside transaction to prevent race condition
        const current = await tx.registration.findUnique({
          where: { id: registrationId },
          select: { paymentStatus: true },
        });
        if (current?.paymentStatus === "PAID") return;

        await tx.registration.update({
          where: { id: registrationId },
          data: { paymentStatus: "PAID" },
        });
        await tx.payment.create({
          data: {
            registrationId,
            amount,
            currency,
            stripePaymentId: paymentIntentId,
            stripeCustomerId: customerId,
            status: "PAID",
            receiptUrl,
            cardBrand,
            cardLast4,
            paymentMethodType,
            paidAt: paidAt ?? new Date(),
            metadata: { checkoutSessionId: session.id },
          },
        });
      });

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
        apiLogger.warn({ msg: "charge.refunded: no Payment record found", paymentIntentId });
        return NextResponse.json({ received: true });
      }

      const round2 = (n: number) => Math.round(n * 100) / 100;
      // Stripe's `amount_refunded` is the CUMULATIVE refunded total (minor units)
      // — supports partial + repeated Dashboard refunds. Reconcile our running
      // `Registration.refundedAmount` up to it.
      const cumulativeRefunded = round2(fromStripeAmount(charge.amount_refunded, charge.currency));
      // `paidTotal` is the FULL collected total for the registration — the sum of
      // ALL PAID payments (a reg can hold a Stripe charge + a manual/offline
      // capture). Deriving it from this single PaymentIntent's row would flag a
      // full refund of one charge as "fully refunded" and mislabel the whole reg,
      // stranding the rest. Matches the refund route's paidTotal derivation.
      const paidAgg = await db.payment.aggregate({
        where: { registrationId: payment.registrationId, status: "PAID" },
        _sum: { amount: true },
      });
      const paidTotal = round2(Number(paidAgg._sum.amount ?? payment.amount));
      const already = round2(Number(payment.registration.refundedAmount));
      const delta = round2(cumulativeRefunded - already);
      const isFull = cumulativeRefunded >= paidTotal - 0.005;

      // A route-initiated refund already bumped `refundedAmount` to this value,
      // so a delta of 0 means "already accounted for" → skip (idempotent on
      // retries too). Only a Stripe-Dashboard (out-of-band) refund advances it.
      if (delta <= 0) {
        apiLogger.info({ msg: "charge.refunded: already reconciled, skipping", registrationId: payment.registrationId, paymentIntentId, cumulativeRefunded });
        return NextResponse.json({ received: true });
      }

      // Claim the delta atomically — guarded by `refundedAmount < cumulative` so
      // two concurrent webhook deliveries can't both advance it / both mint a CN.
      const claimed = await db.registration.updateMany({
        where: { id: payment.registrationId, refundedAmount: { lt: cumulativeRefunded } },
        data: {
          refundedAmount: cumulativeRefunded,
          ...(isFull ? { paymentStatus: "REFUNDED" as const } : {}),
        },
      });
      if (claimed.count === 0) {
        apiLogger.info({ msg: "charge.refunded: delta claimed by a concurrent delivery, skipping", registrationId: payment.registrationId, paymentIntentId });
        return NextResponse.json({ received: true });
      }

      // Flip the Payment row to REFUNDED only on a FULL refund.
      if (isFull) {
        await db.payment.update({ where: { id: payment.id }, data: { status: "REFUNDED" } });
      }

      apiLogger.info({
        msg: "Refund reconciled via Stripe webhook",
        registrationId: payment.registrationId,
        paymentIntentId,
        delta,
        cumulativeRefunded,
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
