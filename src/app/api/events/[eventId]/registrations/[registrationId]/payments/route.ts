import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";
import { createPaidInvoice, sendInvoiceEmail } from "@/lib/invoice-service";
import { notifyEventAdmins } from "@/lib/notifications";
import { refreshEventStats } from "@/lib/event-stats";

/**
 * POST /api/events/[eventId]/registrations/[registrationId]/payments
 *
 * Records a MANUAL payment for a registration — for onsite/offline
 * scenarios that bypass Stripe:
 *
 *   - bank_transfer  organizer captures the bank reference + uploaded
 *                    proof (transfer copy / receipt photo)
 *   - card_onsite    organizer captures last4 + brand of a card swiped
 *                    on a physical terminal at the desk
 *   - cash           organizer notes who received the cash
 *
 * Side effects (mirrors the Stripe webhook flow at
 * `src/app/api/webhooks/stripe/route.ts`):
 *
 *   1. Insert a `Payment` row with `status: "PAID"` + the captured
 *      method-specific fields. `stripePaymentId` is left null.
 *   2. Flip `registration.paymentStatus` to `"PAID"`.
 *   3. Fire-and-forget: `createPaidInvoice(...)` (promotes any existing
 *      admin INVOICE in place, else mints a new INVOICE/PAID row) +
 *      `sendInvoiceEmail(invoice.id)` so the registrant receives the
 *      proper Invoice PDF.
 *   4. Audit log (`MANUAL_PAYMENT_RECORDED`) + admin notification.
 *
 * Returns 409 if the registration is already PAID — admins should never
 * record two manual payments for the same registration. To correct a
 * mistake, refund first, then re-record.
 */

const recordPaymentSchema = z
  .object({
    method: z.enum(["bank_transfer", "card_onsite", "cash"]),
    amount: z.number().positive().max(1_000_000).optional(),
    currency: z.string().length(3).toUpperCase().optional(),
    paidAt: z
      .string()
      .datetime({ offset: true })
      .optional()
      .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),

    // bank_transfer
    bankReference: z.string().max(255).optional(),
    proofUrl: z.string().max(2000).optional(),

    // card_onsite — `cardBrand` is free-text because terminal receipts
    // don't always emit normalized strings (we'll see "VISA", "Visa",
    // "visa", "mastercard"…). The PDF renderer titlecases at display.
    cardBrand: z.string().max(50).optional(),
    cardLast4: z.string().regex(/^\d{4}$/).optional(),

    // cash
    cashReceivedBy: z.string().max(255).optional(),

    notes: z.string().max(2000).optional(),
  })
  // Per-method required fields — caught here so the UI gets a clean
  // field-level error rather than a generic "Invalid input".
  .superRefine((data, ctx) => {
    if (data.method === "card_onsite" && !data.cardLast4) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cardLast4"],
        message: "Last 4 digits of the card are required for onsite card payments",
      });
    }
    if (data.method === "cash" && !data.cashReceivedBy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cashReceivedBy"],
        message: "Who received the cash? (organizer / cashier name)",
      });
    }
  });

interface RouteParams {
  params: Promise<{ eventId: string; registrationId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  let registrationId: string | undefined;
  let eventId: string | undefined;
  try {
    const [{ eventId: eId, registrationId: rId }, session, body] = await Promise.all([
      params,
      auth(),
      req.json(),
    ]);
    eventId = eId;
    registrationId = rId;

    if (!session?.user) {
      apiLogger.warn({ msg: "manual-payment:unauthenticated", eventId, registrationId });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const parsed = recordPaymentSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({
        msg: "manual-payment:zod-validation-failed",
        eventId,
        registrationId,
        errors: parsed.error.flatten(),
      });
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const data = parsed.data;

    const event = await db.event.findFirst({
      where: { id: eventId, ...buildEventAccessWhere(session.user) },
      select: { id: true, organizationId: true, name: true },
    });
    if (!event) {
      apiLogger.warn({
        msg: "manual-payment:event-not-found",
        eventId,
        registrationId,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const registration = await db.registration.findFirst({
      where: { id: registrationId, eventId },
      select: {
        id: true,
        paymentStatus: true,
        ticketType: { select: { price: true, currency: true } },
        pricingTier: { select: { price: true, currency: true } },
        attendee: { select: { firstName: true, lastName: true, email: true } },
      },
    });
    if (!registration) {
      apiLogger.warn({
        msg: "manual-payment:registration-not-found",
        eventId,
        registrationId,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    // Reject if already paid. Admins should not stack manual payments —
    // a duplicate row would inflate the Payment History panel and could
    // mint a second Invoice number. To correct a mistake: refund first,
    // then re-record.
    if (registration.paymentStatus === "PAID") {
      apiLogger.warn({
        msg: "manual-payment:already-paid",
        eventId,
        registrationId,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "Registration is already marked as paid. Refund first if you need to re-record." },
        { status: 409 },
      );
    }

    // Resolve amount + currency. Default to the ticket price when the
    // organizer doesn't specify one — the typical case for a paid-in-full
    // capture. Pricing-tier price wins over ticket-type price when both
    // are present, matching the rest of the codebase.
    const fallbackAmount = registration.pricingTier
      ? Number(registration.pricingTier.price)
      : Number(registration.ticketType?.price ?? 0);
    const fallbackCurrency = (
      registration.pricingTier?.currency ??
      registration.ticketType?.currency ??
      "USD"
    ).toUpperCase();

    const amount = data.amount ?? fallbackAmount;
    const currency = (data.currency ?? fallbackCurrency).toUpperCase();
    if (amount <= 0) {
      apiLogger.warn({
        msg: "manual-payment:zero-amount",
        eventId,
        registrationId,
        amount,
      });
      return NextResponse.json(
        { error: "Amount must be greater than zero. For complimentary registrations, set Payment Status to COMPLIMENTARY instead." },
        { status: 400 },
      );
    }

    const paidAtDate = data.paidAt ? new Date(data.paidAt) : new Date();
    if (Number.isNaN(paidAtDate.getTime())) {
      apiLogger.warn({ msg: "manual-payment:invalid-paidAt", eventId, registrationId });
      return NextResponse.json({ error: "Invalid paidAt date" }, { status: 400 });
    }

    // Method-specific metadata captured into Payment.metadata so the
    // detail sheet's Billing panel can render reconciliation context
    // without schema bloat.
    const metadata = {
      recordedManually: true,
      recordedByUserId: session.user.id,
      recordedAt: new Date().toISOString(),
      method: data.method,
      ...(data.bankReference ? { bankReference: data.bankReference } : {}),
      ...(data.cashReceivedBy ? { cashReceivedBy: data.cashReceivedBy } : {}),
      ...(data.notes ? { notes: data.notes } : {}),
    };

    // Atomic transaction: flip registration status + insert Payment row.
    // We re-check the paymentStatus inside the tx to defend against a
    // concurrent admin click flipping it via the Payment Status dropdown.
    const payment = await db.$transaction(async (tx) => {
      const claim = await tx.registration.updateMany({
        where: { id: registrationId, paymentStatus: { not: "PAID" } },
        data: { paymentStatus: "PAID" },
      });
      if (claim.count === 0) {
        // Lost the race — surface as a typed error caught by the outer
        // catch below.
        throw new ManualPaymentRaceError();
      }

      return tx.payment.create({
        data: {
          registrationId: registrationId!,
          amount,
          currency,
          status: "PAID",
          paymentMethodType: data.method,
          paidAt: paidAtDate,
          // For card_onsite the organizer types last4 + brand directly.
          cardBrand: data.method === "card_onsite" ? data.cardBrand ?? null : null,
          cardLast4: data.method === "card_onsite" ? data.cardLast4 ?? null : null,
          // Re-purpose `receiptUrl` as the URL of the proof artifact —
          // a Stripe-hosted receipt for online payments, or our locally-
          // uploaded transfer copy / receipt photo for manual payments.
          receiptUrl: data.method === "bank_transfer" ? data.proofUrl ?? null : null,
          // Reference field — bank reference for transfers, last4 hint
          // for card-onsite (so it shows on the invoice "Reference" line),
          // empty for cash.
          metadata,
        },
      });
    });

    apiLogger.info({
      msg: "manual-payment:recorded",
      eventId,
      registrationId,
      paymentId: payment.id,
      method: data.method,
      amount,
      currency,
      userId: session.user.id,
    });

    // Audit log (fire-and-forget — invoice creation must not block on
    // an audit insert failure, but failure is rare enough we still log it).
    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "MANUAL_PAYMENT_RECORDED",
          entityType: "Registration",
          entityId: registrationId!,
          changes: {
            method: data.method,
            amount,
            currency,
            paymentId: payment.id,
            ip: getClientIp(req),
          },
        },
      })
      .catch((err) =>
        apiLogger.warn({ err, msg: "manual-payment:audit-write-failed", paymentId: payment.id }),
      );

    // Refresh denormalized event stats (fire-and-forget).
    refreshEventStats(eventId);

    // Notify event admins (non-blocking).
    notifyEventAdmins(eventId, {
      type: "PAYMENT",
      title: "Manual Payment Recorded",
      message: `${registration.attendee.firstName} ${registration.attendee.lastName} — ${data.method.replace("_", " ")} — ${currency} ${amount.toFixed(2)}`,
      link: `/events/${eventId}/registrations`,
    }).catch((err) =>
      apiLogger.warn({ err, msg: "manual-payment:notification-failed", paymentId: payment.id }),
    );

    // Auto-create the post-payment INVOICE (status PAID) and email it.
    // Mirrors the Stripe webhook side-effect fan-out so the registrant
    // receives the same artifact regardless of payment channel.
    let invoiceId: string | null = null;
    try {
      const invoice = await createPaidInvoice({
        registrationId: registrationId!,
        eventId,
        organizationId: event.organizationId,
        paymentId: payment.id,
        paymentMethod: data.method,
        paymentReference:
          data.bankReference ||
          (data.method === "card_onsite" && data.cardLast4 ? `Card ending ${data.cardLast4}` : undefined) ||
          (data.method === "cash" ? `Cash — received by ${data.cashReceivedBy ?? "organizer"}` : undefined),
        paidAt: paidAtDate,
      });
      invoiceId = invoice.id;
      // Fire-and-forget the email so the API responds quickly. Email
      // failure is logged but doesn't fail the manual-payment recording —
      // the admin can resend from the registration detail sheet.
      sendInvoiceEmail(invoice.id).catch((err) =>
        apiLogger.error({
          err,
          msg: "manual-payment:invoice-email-failed",
          registrationId,
          invoiceId: invoice.id,
        }),
      );
    } catch (err) {
      apiLogger.error({
        err,
        msg: "manual-payment:invoice-create-failed",
        registrationId,
        paymentId: payment.id,
        prismaCode: (err as { code?: string })?.code ?? null,
      });
      // Don't fail the response — the Payment row + paymentStatus update
      // already landed, the admin can retry the invoice manually.
    }

    return NextResponse.json({
      payment: {
        id: payment.id,
        amount: Number(payment.amount),
        currency: payment.currency,
        method: payment.paymentMethodType,
        paidAt: payment.paidAt,
        cardBrand: payment.cardBrand,
        cardLast4: payment.cardLast4,
        receiptUrl: payment.receiptUrl,
        metadata: payment.metadata,
      },
      invoiceId,
    });
  } catch (error) {
    if (error instanceof ManualPaymentRaceError) {
      apiLogger.warn({
        msg: "manual-payment:race-already-paid",
        eventId,
        registrationId,
      });
      return NextResponse.json(
        { error: "Registration was paid by another action just now. Refresh and re-check." },
        { status: 409 },
      );
    }
    apiLogger.error({
      err: error,
      msg: "manual-payment:unexpected-error",
      eventId,
      registrationId,
      prismaCode: (error as { code?: string })?.code ?? null,
    });
    return NextResponse.json({ error: "Failed to record payment" }, { status: 500 });
  }
}

// ── Internal sentinel ────────────────────────────────────────────────
// Typed error so the catch block can distinguish a concurrent-flip race
// (return 409) from a generic failure (return 500). Same pattern used by
// `src/services/registration-service.ts`.
class ManualPaymentRaceError extends Error {
  constructor() {
    super("Registration was already paid by a concurrent action");
    this.name = "ManualPaymentRaceError";
  }
}
