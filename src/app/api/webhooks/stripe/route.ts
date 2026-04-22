import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getStripe, fromStripeAmount } from "@/lib/stripe";
import { sendEmail, getEventTemplate, getDefaultTemplate, renderAndWrap, brandingFrom } from "@/lib/email";
import type Stripe from "stripe";
import { notifyEventAdmins } from "@/lib/notifications";
import { createReceipt, createCreditNote, sendInvoiceEmail } from "@/lib/invoice-service";
import { refreshEventStats } from "@/lib/event-stats";

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
          attendee: { select: { firstName: true, lastName: true, email: true } },
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
        : Number(registration.pricingTier?.price ?? registration.ticketType?.price ?? 0);
      const currency = sessionCurrency;
      const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || null;
      const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id || null;

      // Fetch receipt URL from the payment intent's latest charge
      let receiptUrl: string | null = null;
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
          }
        } catch (err) {
          apiLogger.warn({ err, msg: "Failed to fetch Stripe receipt URL", paymentIntentId });
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

      // Send payment confirmation email (non-blocking).
      // paymentIntentId → `Payment Reference` field in the email.
      sendPaymentConfirmationEmail(registration, amount, currency, receiptUrl, paymentIntentId).catch((err) =>
        apiLogger.error({ err, msg: "Failed to send payment confirmation email", registrationId })
      );

      // Auto-create receipt (non-blocking)
      (async () => {
        try {
          // Find the payment record just created
          const payment = await db.payment.findFirst({
            where: { registrationId, status: "PAID" },
            orderBy: { createdAt: "desc" },
            select: { id: true },
          });
          if (payment) {
            const receipt = await createReceipt({
              registrationId,
              eventId: registration.event.id,
              organizationId: registration.event.organizationId,
              paymentId: payment.id,
              paymentMethod: "stripe",
              paymentReference: paymentIntentId || undefined,
            });
            await sendInvoiceEmail(receipt.id);
          }
        } catch (err) {
          apiLogger.error({ err, msg: "Failed to auto-create receipt", registrationId });
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
        select: { id: true, registrationId: true, registration: { select: { eventId: true, event: { select: { organizationId: true } } } } },
      });
      if (!payment) {
        apiLogger.warn({ msg: "charge.refunded: no Payment record found", paymentIntentId });
        return NextResponse.json({ received: true });
      }

      await db.$transaction([
        db.registration.update({
          where: { id: payment.registrationId },
          data: { paymentStatus: "REFUNDED" },
        }),
        db.payment.update({
          where: { id: payment.id },
          data: { status: "REFUNDED" },
        }),
      ]);

      apiLogger.info({ msg: "Refund processed via Stripe webhook", registrationId: payment.registrationId, paymentIntentId });

      // Auto-create credit note (non-blocking)
      (async () => {
        try {
          const cn = await createCreditNote({
            registrationId: payment.registrationId,
            eventId: payment.registration.eventId,
            organizationId: payment.registration.event.organizationId,
            reason: "Refund via Stripe",
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

async function sendPaymentConfirmationEmail(
  registration: {
    id: string;
    serialId: number | null;
    attendee: { firstName: string; lastName: string; email: string };
    ticketType: { name: string; price: unknown; currency: string } | null;
    pricingTier: { price: unknown; currency: string } | null;
    event: { id: string; name: string; slug: string; startDate: Date; venue: string | null; city: string | null; taxRate: unknown; taxLabel: string | null };
  },
  amount: number,
  currency: string,
  receiptUrl: string | null,
  paymentIntentId: string | null,
) {
  const eventDate = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(registration.event.startDate));

  const paymentDate = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());

  // Calculate tax from event settings
  const basePrice = Number(registration.pricingTier?.price ?? registration.ticketType?.price ?? 0);
  const taxRate = Number(registration.event.taxRate || 0);
  const taxLabel = registration.event.taxLabel || "VAT";
  const taxAmount = taxRate > 0 ? basePrice * taxRate / 100 : 0;
  const subtotal = basePrice;
  const total = basePrice + taxAmount;

  // Build tax block — only shown when taxRate > 0
  const taxBlock = taxRate > 0
    ? `<tr><td style="padding: 4px 0; color: #555; font-size: 14px;">${taxLabel} (${taxRate}%)</td><td style="padding: 4px 0; text-align: right; font-size: 14px;">${currency} ${taxAmount.toFixed(2)}</td></tr>`
    : "";

  // Build receipt block — only shown if Stripe provided a receipt URL
  const receiptBlock = receiptUrl
    ? `<div style="text-align: center; margin: 20px 0;">
        <a href="${receiptUrl}" style="display: inline-block; background: #00aade; color: white; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: 500; font-size: 14px;">View Receipt / Invoice</a>
      </div>`
    : "";
  const receiptBlockText = receiptUrl ? `View Receipt: ${receiptUrl}` : "";

  // registrationId → the padded serial number (e.g. "002") that matches the
  // first confirmation email the user already has. paymentReference → Stripe
  // payment intent id (the transaction-level identifier). Fall back to "—"
  // when either is missing so the template doesn't render a raw "undefined".
  const displayRegistrationId =
    registration.serialId != null
      ? String(registration.serialId).padStart(3, "0")
      : registration.id;
  const paymentReference = paymentIntentId ?? "—";

  const vars: Record<string, string | number | undefined> = {
    firstName: registration.attendee.firstName,
    lastName: registration.attendee.lastName,
    eventName: registration.event.name,
    eventDate,
    eventVenue: [registration.event.venue, registration.event.city].filter(Boolean).join(", "),
    registrationId: displayRegistrationId,
    paymentReference,
    ticketType: registration.ticketType?.name ?? "General",
    amount: `${currency} ${amount.toFixed(2)}`,
    currency,
    paymentDate,
    receiptUrl: receiptUrl || undefined,
    receiptBlock,
    subtotal: `${currency} ${subtotal.toFixed(2)}`,
    taxRate: taxRate > 0 ? taxRate : undefined,
    taxLabel: taxRate > 0 ? taxLabel : undefined,
    taxAmount: taxRate > 0 ? `${currency} ${taxAmount.toFixed(2)}` : undefined,
    total: `${currency} ${total.toFixed(2)}`,
    taxBlock,
  };

  const tpl = await getEventTemplate(registration.event.id, "payment-confirmation");
  const template = tpl || getDefaultTemplate("payment-confirmation");

  if (!template) {
    apiLogger.warn({ msg: "No payment-confirmation template found" });
    return;
  }

  const branding = tpl?.branding || { eventName: registration.event.name };
  const rendered = renderAndWrap(template, vars, branding, new Set(["receiptBlock", "taxBlock"]));

  // Override text content with plain text receipt link
  const textVars = { ...vars, receiptBlock: receiptBlockText };
  const { renderTemplatePlain } = await import("@/lib/email");
  rendered.textContent = renderTemplatePlain(template.textContent, textVars);

  await sendEmail({
    to: [{ email: registration.attendee.email, name: registration.attendee.firstName }],
    ...rendered,
    from: brandingFrom(branding),
    logContext: {
      eventId: registration.event.id,
      entityType: "REGISTRATION",
      entityId: registration.id,
      templateSlug: "payment-confirmation",
    },
  });

  apiLogger.info({ msg: "Payment confirmation email sent", registrationId: registration.id });
}
