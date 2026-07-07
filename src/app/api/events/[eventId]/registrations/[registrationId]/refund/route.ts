import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getStripe } from "@/lib/stripe";
import { sendEmail, getEventTemplate, getDefaultTemplate, renderAndWrap, brandingFrom, brandingCc } from "@/lib/email";
import { getTitleLabel } from "@/lib/utils";
import { notifyEventAdmins } from "@/lib/notifications";
import { createCreditNote, sendInvoiceEmail } from "@/lib/invoice-service";
import { computeRegistrationFinancials, readRegistrationBasePrice } from "@/lib/registration-financials";
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
          // originalPrice/discountAmount + tier/ticket price feed the computed
          // refund amount when there's no Payment row to read (a PAID reg that
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

    // Most recent PAID payment. A Stripe payment carries a `stripePaymentId`;
    // a MANUAL/offline payment (cash / bank transfer / card-onsite) does not.
    // A PAID registration with no Payment row at all (admin hand-flipped the
    // status) is treated as a manual refund too — there's nothing to reverse in
    // Stripe, we just record the reversal + issue a credit note.
    const payment = registration.payments[0];
    const isManualRefund = !payment?.stripePaymentId;

    // Resolve the refunded amount + currency for the email / notification / log.
    // From the payment row when present; else computed from the registration
    // (tax-inclusive total, matching the manual-payment capture).
    const currency = (
      payment?.currency ||
      registration.pricingTier?.currency ||
      registration.ticketType?.currency ||
      "USD"
    ).toUpperCase();
    const amount = payment
      ? Number(payment.amount)
      : computeRegistrationFinancials({
          subtotal: readRegistrationBasePrice(registration),
          discount: registration.discountAmount ? Number(registration.discountAmount) : 0,
          taxRate: registration.event.taxRate ? Number(registration.event.taxRate) : null,
          taxLabel: registration.event.taxLabel,
          currency,
          totalPaid: 0,
        }).total;
    const formattedAmount = `${currency} ${amount.toFixed(2)}`;

    // Optimistic lock: mark REFUNDED in DB first so two concurrent refund clicks
    // can't both reach Stripe / both record a reversal.
    const locked = await db.registration.updateMany({
      where: { id: registrationId, paymentStatus: "PAID" },
      data: { paymentStatus: "REFUNDED" },
    });
    if (locked.count === 0) {
      return NextResponse.json({ error: "Registration is no longer in a paid state" }, { status: 409 });
    }

    let stripeRefundId: string | null = null;
    if (isManualRefund) {
      // Offline refund — no Stripe charge to reverse. The organizer returns the
      // money out-of-band (reverses the transfer / hands cash back); we record
      // the reversal, flip the Payment row (if any), and issue a credit note.
      apiLogger.info({
        msg: "Manual/offline refund recorded (no Stripe charge to reverse)",
        registrationId,
        eventId,
        paymentId: payment?.id ?? null,
        amount,
        currency,
        issuedBy: session.user.id,
      });
    } else {
      // Issue the refund via Stripe — idempotency key prevents a duplicate on retries.
      try {
        const stripe = getStripe();
        const refund = await stripe.refunds.create(
          { payment_intent: payment!.stripePaymentId! },
          { idempotencyKey: `refund-${payment!.id}` }
        );
        stripeRefundId = refund.id;
      } catch (stripeErr) {
        // Stripe call failed — roll back the optimistic lock so the admin can retry.
        await db.registration.update({
          where: { id: registrationId },
          data: { paymentStatus: "PAID" },
        }).catch((rollbackErr) => apiLogger.error({ rollbackErr, msg: "Failed to roll back optimistic lock after Stripe error", registrationId }));
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
        issuedBy: session.user.id,
      });
    }

    // Flip the Payment record to REFUNDED (if one exists — a hand-flipped PAID
    // reg may have none). Keeps the Payment row consistent with the registration.
    if (payment) {
      await db.payment.update({
        where: { id: payment.id },
        data: { status: "REFUNDED" },
      });
    }

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
        const { invoice: cn, created } = await createCreditNote({
          registrationId,
          eventId,
          organizationId: session.user.organizationId!,
          reason: `${isManualRefund ? "Offline" : "Stripe"} refund of ${formattedAmount}`,
        });
        // Only email on a fresh credit note. For a Stripe refund the resulting
        // `charge.refunded` webhook may reach `createCreditNote` too; whichever
        // runs second gets `created: false` and must not re-email the attendee.
        if (created) await sendInvoiceEmail(cn.id);
      } catch (cnErr) {
        apiLogger.error({ err: cnErr, msg: "Failed to auto-create credit note", registrationId });
      }
    })();

    return NextResponse.json({
      refundId: stripeRefundId,
      manual: isManualRefund,
      status: stripeRefundId ? "succeeded" : "recorded",
    });
  } catch (err) {
    apiLogger.error({ err, msg: "Failed to issue refund", registrationId, eventId });
    return NextResponse.json({ error: "Failed to issue refund" }, { status: 500 });
  }
}

async function sendRefundConfirmationEmail(
  registration: {
    id: string;
    serialId: number | null;
    attendee: { firstName: string; lastName: string; email: string; additionalEmail: string | null; title: string | null };
    ticketType: { name: string } | null;
    event: { id: string; organizationId: string; name: string; startDate: Date };
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
    title: getTitleLabel(registration.attendee.title),
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
    cc: brandingCc(
      branding,
      [{ email: registration.attendee.email }],
      [registration.attendee.additionalEmail],
    ),
    ...rendered,
    from: brandingFrom(branding),
    emailType: "refund_confirmation",
    stream: "transactional",
    logContext: {
      organizationId: registration.event.organizationId,
      eventId: registration.event.id,
      entityType: "REGISTRATION",
      entityId: registration.id,
      templateSlug: "refund-confirmation",
    },
  });

  apiLogger.info({ msg: "Refund confirmation email sent", registrationId: registration.id });
}
