import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getStripe } from "@/lib/stripe";
import { sendEmail, getEventTemplate, getDefaultTemplate, renderAndWrap, brandingFrom } from "@/lib/email";
import { notifyEventAdmins } from "@/lib/notifications";
import { createCreditNote, sendInvoiceEmail } from "@/lib/invoice-service";
import { refreshEventStats } from "@/lib/event-stats";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ eventId: string; registrationId: string }> }
) {
  const [session, { eventId, registrationId }] = await Promise.all([auth(), params]);

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const denied = denyReviewer(session);
  if (denied) return denied;

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
          attendee: { select: { firstName: true, lastName: true, email: true } },
          ticketType: { select: { name: true, currency: true } },
          pricingTier: { select: { currency: true } },
          event: { select: { id: true, name: true, startDate: true } },
          payments: {
            where: { status: "PAID" },
            orderBy: { createdAt: "desc" },
            take: 1,
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

    const payment = registration.payments[0];
    if (!payment?.stripePaymentId) {
      return NextResponse.json({ error: "No Stripe payment found for this registration" }, { status: 400 });
    }

    const currency = (payment.currency || registration.pricingTier?.currency || registration.ticketType?.currency || "USD").toUpperCase();
    const amount = Number(payment.amount);
    const formattedAmount = `${currency} ${amount.toFixed(2)}`;

    // Optimistic lock: mark as REFUNDED in DB before calling Stripe to prevent
    // concurrent duplicate refund requests from both reaching Stripe.
    const locked = await db.registration.updateMany({
      where: { id: registrationId, paymentStatus: "PAID" },
      data: { paymentStatus: "REFUNDED" },
    });
    if (locked.count === 0) {
      return NextResponse.json({ error: "Registration is no longer in a paid state" }, { status: 409 });
    }

    // Issue refund via Stripe — idempotency key prevents duplicate charges on retries
    let refund: { id: string; status: string | null };
    try {
      const stripe = getStripe();
      refund = await stripe.refunds.create(
        { payment_intent: payment.stripePaymentId },
        { idempotencyKey: `refund-${payment.id}` }
      );
    } catch (stripeErr) {
      // Stripe call failed — roll back the optimistic lock so the admin can retry
      await db.registration.update({
        where: { id: registrationId },
        data: { paymentStatus: "PAID" },
      }).catch((rollbackErr) => apiLogger.error({ rollbackErr, msg: "Failed to roll back optimistic lock after Stripe error", registrationId }));
      apiLogger.error({ err: stripeErr, msg: "Stripe refund failed", registrationId, paymentIntentId: payment.stripePaymentId });
      return NextResponse.json({ error: "Refund could not be processed. Please try again or issue the refund directly in Stripe." }, { status: 502 });
    }

    // Update Payment record status
    await db.payment.update({
      where: { id: payment.id },
      data: { status: "REFUNDED" },
    });

    apiLogger.info({
      msg: "Refund issued",
      registrationId,
      eventId,
      stripeRefundId: refund.id,
      amount,
      currency,
      issuedBy: session.user.id,
    });

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(eventId);

    // Notify admins (non-blocking)
    notifyEventAdmins(eventId, {
      type: "PAYMENT",
      title: "Refund Issued",
      message: `Refund of ${formattedAmount} issued to ${registration.attendee.firstName} ${registration.attendee.lastName}`,
      link: `/events/${eventId}/registrations`,
    }).catch((err: unknown) => apiLogger.error({ err, msg: "Failed to send refund admin notification" }));

    // Send refund confirmation email to attendee (non-blocking)
    sendRefundConfirmationEmail(registration, formattedAmount).catch((err: unknown) =>
      apiLogger.error({ err, msg: "Failed to send refund confirmation email", registrationId })
    );

    // Auto-create credit note (non-blocking)
    (async () => {
      try {
        const cn = await createCreditNote({
          registrationId,
          eventId,
          organizationId: session.user.organizationId!,
          reason: `Admin-initiated refund of ${formattedAmount}`,
        });
        await sendInvoiceEmail(cn.id);
      } catch (cnErr) {
        apiLogger.error({ err: cnErr, msg: "Failed to auto-create credit note", registrationId });
      }
    })();

    return NextResponse.json({ refundId: refund.id, status: refund.status });
  } catch (err) {
    apiLogger.error({ err, msg: "Failed to issue refund", registrationId, eventId });
    return NextResponse.json({ error: "Failed to issue refund" }, { status: 500 });
  }
}

async function sendRefundConfirmationEmail(
  registration: {
    id: string;
    serialId: number | null;
    attendee: { firstName: string; lastName: string; email: string };
    ticketType: { name: string } | null;
    event: { id: string; name: string; startDate: Date };
  },
  formattedAmount: string
) {
  const eventDate = new Intl.DateTimeFormat("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  }).format(new Date(registration.event.startDate));

  const refundDate = new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date());

  const displayRegistrationId =
    registration.serialId != null
      ? String(registration.serialId).padStart(3, "0")
      : registration.id;

  const vars: Record<string, string> = {
    firstName: registration.attendee.firstName,
    lastName: registration.attendee.lastName,
    eventName: registration.event.name,
    eventDate,
    registrationId: displayRegistrationId,
    ticketType: registration.ticketType?.name ?? "General",
    amount: formattedAmount,
    refundDate,
  };

  const tpl = await getEventTemplate(registration.event.id, "refund-confirmation");
  const template = tpl || getDefaultTemplate("refund-confirmation");
  if (!template) {
    apiLogger.warn({ msg: "No refund-confirmation template found" });
    return;
  }

  const branding = tpl?.branding || { eventName: registration.event.name };
  const rendered = renderAndWrap(template, vars, branding);

  await sendEmail({
    to: [{ email: registration.attendee.email, name: registration.attendee.firstName }],
    ...rendered,
    from: brandingFrom(branding),
    logContext: {
      eventId: registration.event.id,
      entityType: "REGISTRATION",
      entityId: registration.id,
      templateSlug: "refund-confirmation",
    },
  });

  apiLogger.info({ msg: "Refund confirmation email sent", registrationId: registration.id });
}
