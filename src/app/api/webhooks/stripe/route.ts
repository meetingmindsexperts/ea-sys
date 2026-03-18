import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getStripe } from "@/lib/stripe";
import { sendEmail, getEventTemplate, getDefaultTemplate, renderAndWrap } from "@/lib/email";
import type Stripe from "stripe";

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
      // Look up registration
      const registration = await db.registration.findUnique({
        where: { id: registrationId },
        include: {
          attendee: { select: { firstName: true, lastName: true, email: true } },
          ticketType: { select: { name: true, price: true, currency: true } },
          event: { select: { id: true, name: true, slug: true, startDate: true, venue: true, city: true } },
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

      const amount = session.amount_total ? session.amount_total / 100 : Number(registration.ticketType.price);
      const currency = (session.currency || registration.ticketType.currency).toUpperCase();

      // Update registration and create payment record in transaction
      await db.$transaction([
        db.registration.update({
          where: { id: registrationId },
          data: { paymentStatus: "PAID" },
        }),
        db.payment.create({
          data: {
            registrationId,
            amount,
            currency,
            stripePaymentId: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || null,
            stripeCustomerId: typeof session.customer === "string" ? session.customer : session.customer?.id || null,
            status: "PAID",
            receiptUrl: null,
            metadata: { checkoutSessionId: session.id },
          },
        }),
      ]);

      apiLogger.info({
        msg: "Payment completed via Stripe",
        registrationId,
        eventId: registration.event.id,
        amount,
        currency,
        stripeSessionId: session.id,
      });

      // Send payment confirmation email (non-blocking)
      sendPaymentConfirmationEmail(registration, amount, currency).catch((err) =>
        apiLogger.error({ err, msg: "Failed to send payment confirmation email", registrationId })
      );
    } catch (err) {
      apiLogger.error({ err, msg: "Error processing Stripe checkout.session.completed", registrationId });
      // Return 500 so Stripe retries
      return NextResponse.json({ error: "Processing failed" }, { status: 500 });
    }
  }

  return NextResponse.json({ received: true });
}

async function sendPaymentConfirmationEmail(
  registration: {
    id: string;
    attendee: { firstName: string; lastName: string; email: string };
    ticketType: { name: string; price: unknown; currency: string };
    event: { id: string; name: string; slug: string; startDate: Date; venue: string | null; city: string | null };
  },
  amount: number,
  currency: string
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

  const vars = {
    firstName: registration.attendee.firstName,
    lastName: registration.attendee.lastName,
    eventName: registration.event.name,
    eventDate,
    eventVenue: [registration.event.venue, registration.event.city].filter(Boolean).join(", "),
    registrationId: registration.id,
    ticketType: registration.ticketType.name,
    amount: `${currency} ${amount.toFixed(2)}`,
    currency,
    paymentDate,
  };

  const tpl = await getEventTemplate(registration.event.id, "payment-confirmation");
  const template = tpl || getDefaultTemplate("payment-confirmation");

  if (!template) {
    apiLogger.warn({ msg: "No payment-confirmation template found" });
    return;
  }

  const branding = tpl?.branding || { eventName: registration.event.name };
  const rendered = renderAndWrap(template, vars, branding);

  await sendEmail({
    to: [{ email: registration.attendee.email, name: registration.attendee.firstName }],
    ...rendered,
  });

  apiLogger.info({ msg: "Payment confirmation email sent", registrationId: registration.id });
}
