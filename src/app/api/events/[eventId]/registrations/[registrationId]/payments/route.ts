import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, REGISTRATION_DESK_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp, checkRateLimit } from "@/lib/security";
import { issuePaidRegistrationDocuments } from "@/lib/invoice-service";
import { computeRegistrationFinancials, readRegistrationBasePrice } from "@/lib/registration-financials";
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
 * Side effects (review H7/M11, July 10 2026 — captures are now TRUTHFUL):
 *
 *   1. Insert a `Payment` row with `status: "PAID"` + the captured
 *      method-specific fields. `stripePaymentId` is left null.
 *   2. Flip `registration.paymentStatus` to `"PAID"` ONLY when the captured
 *      total (this capture + prior settled payments, same currency) covers
 *      the computed amount owed. A PARTIAL capture records the Payment row
 *      and leaves the registration unpaid — the balance stays visible, the
 *      reg stays in payment chases, and no false PAID documents go out.
 *   3. When (and only when) the registration becomes fully paid:
 *      `issuePaidRegistrationDocuments(...)` — the SAME post-payment fan-out
 *      the Stripe webhook and the reconciliation worker use (PAID invoice +
 *      receipt + one combined email).
 *   4. Audit log (`MANUAL_PAYMENT_RECORDED`, flags amount/currency divergence
 *      from the computed total) + admin notification.
 *
 * Returns 409 if the registration is already PAID with a Payment row —
 * admins should never double-record. To correct a mistake, refund first,
 * then re-record. Rate-limited 60/hr per user.
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

    // Registration-desk roles (ONSITE + MEMBER) can record a payment.
    const denied = denyReviewer(session, { allow: REGISTRATION_DESK_ALLOW });
    if (denied) return denied;

    // The widest money-write population of any endpoint (desk temps included)
    // had no rate limit (review H7). 60/hr is far above any real desk pace.
    const rateLimit = checkRateLimit({
      key: `manual-payment:${session.user.id}`,
      limit: 60,
      windowMs: 60 * 60 * 1000,
    });
    if (!rateLimit.allowed) {
      apiLogger.warn({ msg: "manual-payment:rate-limited", eventId, registrationId, userId: session.user.id });
      return NextResponse.json(
        { error: "Too many payment recordings. Please wait before recording more.", retryAfterSeconds: rateLimit.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
      );
    }

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
      select: { id: true, organizationId: true, name: true, taxRate: true, taxLabel: true },
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
        originalPrice: true,
        discountAmount: true,
        ticketType: { select: { price: true, currency: true } },
        pricingTier: { select: { price: true, currency: true } },
        attendee: { select: { firstName: true, lastName: true, email: true } },
        // We only block the 409 when there's actually a Payment row to
        // duplicate. Admin-flipped-without-recording is a real recovery
        // case (status PAID but no Payment row yet) — let it through.
        _count: { select: { payments: true } },
        // Prior settled money — a partial capture accumulates toward the
        // computed total; PAID flips only when it's covered (review H7).
        payments: {
          where: { status: { in: ["PAID", "REFUNDED"] } },
          select: { amount: true, currency: true },
        },
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

    // Reject only when there's already a Payment row recorded — that's
    // the duplicate case we actually need to prevent. PAID-but-no-Payment
    // (admin hand-flipped the dropdown earlier) IS the case organizers
    // want to recover via this endpoint, so let it through.
    if (registration.paymentStatus === "PAID" && registration._count.payments > 0) {
      apiLogger.warn({
        msg: "manual-payment:already-paid-with-payment-row",
        eventId,
        registrationId,
        existingPaymentCount: registration._count.payments,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "Registration is already marked as paid and has a payment record. Refund first if you need to re-record." },
        { status: 409 },
      );
    }

    // Resolve amount + currency. Default to the ticket price when the
    // organizer doesn't specify one — the typical case for a paid-in-full
    // capture. Pricing-tier price wins over ticket-type price when both
    // are present, matching the rest of the codebase.
    // Default to the FULL amount owed — tax-inclusive, discount-applied — i.e.
    // the total the attendee actually pays onsite, NOT the bare pre-tax ticket
    // price. Mirrors the detail-sheet Payment Summary + the generated invoice so
    // a no-amount capture tallies the tax instead of under-recording it.
    const fin = computeRegistrationFinancials({
      subtotal: readRegistrationBasePrice(registration),
      discount: registration.discountAmount ? Number(registration.discountAmount) : 0,
      taxRate: event.taxRate ? Number(event.taxRate) : null,
      taxLabel: event.taxLabel,
      currency: registration.pricingTier?.currency ?? registration.ticketType?.currency ?? "USD",
      totalPaid: 0,
    });
    const fallbackAmount = fin.total;
    const fallbackCurrency = (
      registration.pricingTier?.currency ??
      registration.ticketType?.currency ??
      "USD"
    ).toUpperCase();

    const amount = data.amount ?? fallbackAmount;
    const currency = (data.currency ?? fallbackCurrency).toUpperCase();

    // ── Truthfulness guards (review H7) ─────────────────────────────────
    // The amount + currency are operator-supplied. We accept them (real desks
    // take partial deposits and odd amounts), but the CONSEQUENCES are now
    // honest: PAID + documents only when the captured total actually covers
    // the amount owed, and any divergence is logged + audited.
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const currencyMismatch = currency !== fallbackCurrency;
    const amountDivergent = data.amount !== undefined && Math.abs(amount - fin.total) > 0.005;
    if (currencyMismatch || amountDivergent) {
      apiLogger.warn({
        msg: "manual-payment:capture-diverges-from-computed-total",
        eventId,
        registrationId,
        amount,
        currency,
        computedTotal: fin.total,
        computedCurrency: fallbackCurrency,
        userId: session.user.id,
      });
    }
    // Prior settled money in the SAME currency. A foreign-currency capture
    // can't be compared to the computed total, so it never counts toward
    // "fully paid" — the operator settles those by hand.
    const priorCaptured = round2(
      registration.payments
        .filter((p) => p.currency.toUpperCase() === fallbackCurrency)
        .reduce((s, p) => s + Number(p.amount), 0),
    );
    const capturedAfter = round2(priorCaptured + (currencyMismatch ? 0 : amount));
    const coversTotal = !currencyMismatch && capturedAfter >= fin.total - 0.005;

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

    // Atomic transaction: flip registration status (only when the captured
    // total covers the amount owed) + insert the Payment row. Three cases:
    //   - not yet PAID + capture covers the total: claim with the
    //     `paymentStatus != PAID` predicate (defends a concurrent flip).
    //   - not yet PAID + PARTIAL capture: record the Payment row ONLY —
    //     the registration stays unpaid, the balance stays visible, and no
    //     PAID documents are issued (review H7 — an $80 capture on a $105
    //     total used to flip PAID and email documents asserting $105).
    //   - status === PAID (admin previously hand-flipped + we already
    //     verified above that no Payment row exists): skip the update
    //     entirely, just insert the recovery Payment row.
    const wasAlreadyPaid = registration.paymentStatus === "PAID";
    const payment = await db.$transaction(async (tx) => {
      if (!wasAlreadyPaid && coversTotal) {
        const claim = await tx.registration.updateMany({
          where: { id: registrationId, paymentStatus: { not: "PAID" } },
          data: { paymentStatus: "PAID" },
        });
        if (claim.count === 0) {
          // Lost the race — surface as a typed error caught by the outer
          // catch below.
          throw new ManualPaymentRaceError();
        }
      } else if (wasAlreadyPaid) {
        // Recovery path (L4, July 10 review): serialize concurrent recovery
        // clicks with a row lock on the registration BEFORE the count —
        // without it two simultaneous recoveries both count 0 and both
        // insert, double-recording the payment. The lock holds through the
        // pgbouncer transaction pooler (single backend per tx), same pattern
        // as createCreditNote.
        await tx.$queryRaw`SELECT id FROM "Registration" WHERE id = ${registrationId} FOR UPDATE`;
        // Re-check that no Payment row landed between our findFirst and now
        // (a concurrent admin click, now serialized by the lock above).
        const existing = await tx.payment.count({ where: { registrationId } });
        if (existing > 0) {
          throw new ManualPaymentRaceError();
        }
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
      computedTotal: fin.total,
      capturedTotal: capturedAfter,
      fullyPaid: coversTotal || wasAlreadyPaid,
      partial: !coversTotal && !wasAlreadyPaid,
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
            computedTotal: fin.total,
            capturedTotal: capturedAfter,
            partial: !coversTotal && !wasAlreadyPaid,
            ...(amountDivergent ? { amountDivergent: true } : {}),
            ...(currencyMismatch ? { currencyMismatch: true, computedCurrency: fallbackCurrency } : {}),
            ip: getClientIp(req),
          },
        },
      })
      .catch((err) =>
        apiLogger.warn({ err, msg: "manual-payment:audit-write-failed", paymentId: payment.id }),
      );

    // Refresh denormalized event stats (fire-and-forget).
    refreshEventStats(eventId);

    // Notify event admins (non-blocking). A partial capture says so.
    const fullyPaidNow = coversTotal || wasAlreadyPaid;
    notifyEventAdmins(eventId, {
      type: "PAYMENT",
      title: fullyPaidNow ? "Manual Payment Recorded" : "Partial Payment Recorded",
      message: `${registration.attendee.firstName} ${registration.attendee.lastName} — ${data.method.replace("_", " ")} — ${currency} ${amount.toFixed(2)}${fullyPaidNow ? "" : ` (partial: ${fallbackCurrency} ${capturedAfter.toFixed(2)} of ${fallbackCurrency} ${fin.total.toFixed(2)} captured — registration stays unpaid)`}`,
      link: `/events/${eventId}/registrations`,
    }).catch((err) =>
      apiLogger.warn({ err, msg: "manual-payment:notification-failed", paymentId: payment.id }),
    );

    // Post-payment documents ONLY when the registration is fully paid — the
    // PAID invoice + receipt assert the FULL computed total, so issuing them
    // on a partial capture emailed the attendee false documents (review H7).
    // Uses issuePaidRegistrationDocuments — the SAME fan-out as the Stripe
    // webhook + reconciliation worker (review M11: this route used to carry a
    // hand-mirrored copy of it).
    let invoiceId: string | null = null;
    if (fullyPaidNow) {
      try {
        const paymentReference =
          data.bankReference ||
          (data.method === "card_onsite" && data.cardLast4 ? `Card ending ${data.cardLast4}` : undefined) ||
          (data.method === "cash" ? `Cash — received by ${data.cashReceivedBy ?? "organizer"}` : undefined);
        const { invoice } = await issuePaidRegistrationDocuments({
          registrationId: registrationId!,
          eventId,
          organizationId: event.organizationId,
          paymentId: payment.id,
          paymentMethod: data.method,
          paymentReference,
          paidAt: paidAtDate,
          amount: Number(payment.amount),
          currency: payment.currency,
          receiptUrl: null,
        });
        invoiceId = invoice.id;
      } catch (err) {
        apiLogger.error({
          err,
          msg: "manual-payment:invoice-create-failed",
          registrationId,
          paymentId: payment.id,
          prismaCode: (err as { code?: string })?.code ?? null,
        });
        // Don't fail the response — the Payment row + paymentStatus update
        // already landed; the invoice-reconciliation worker retries the
        // documents within ~10 minutes.
      }
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
      fullyPaid: fullyPaidNow,
      capturedTotal: capturedAfter,
      totalDue: fin.total,
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
