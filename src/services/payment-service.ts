import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getStripe, toStripeAmount } from "@/lib/stripe";
import { notifyEventAdmins } from "@/lib/notifications";
import { refreshEventStats } from "@/lib/event-stats";
import { computeRegistrationFinancials, readRegistrationBasePrice } from "@/lib/registration-financials";
import { createCreditNote, sendInvoiceEmail, CreditNoteAmountError } from "@/lib/invoice-service";
import { applyRegistrationTransition } from "@/lib/registration-seat-db";

/**
 * Payment service — the domain home for money movement on a registration:
 * refunds (full/partial), and (later) manual capture + cancellation orchestration.
 *
 * Errors-as-values (see src/services/README.md). The service owns the money
 * logic + all downstream side effects (Payment flip, event stats, admin
 * notification, audit log); callers handle auth, HTTP/MCP shaping, rate limits.
 * Never imports `next/server`.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── issueCreditNoteForRegistration ───────────────────────────────────────────

export type PaymentSource = "rest" | "mcp" | "api" | "system";

export interface IssueCreditNoteInput {
  registrationId: string;
  eventId: string;
  organizationId: string;
  /** Credit-note amount (tax-inclusive). Omit for the full outstanding. */
  amount?: number;
  reason?: string;
  /** Email the credit note to the attendee on issue. */
  send?: boolean;
  source: PaymentSource;
  issuedByUserId?: string | null;
}

export type IssueCreditNoteErrorCode =
  | "REGISTRATION_NOT_FOUND"
  | "NOT_PAID"
  | "INVALID_AMOUNT"
  | "CREDIT_LIMIT_EXCEEDED"
  | "UNKNOWN";

export interface CreditNoteSummary {
  creditNoteId: string;
  invoiceNumber: string;
  amount: number;
  currency: string;
  creditedAfter: number;
  paidTotal: number;
  emailed: boolean;
}

export type IssueCreditNoteResult =
  | { ok: true; creditNote: CreditNoteSummary }
  | { ok: false; code: IssueCreditNoteErrorCode; message: string; meta?: Record<string, unknown> };

/**
 * Issue a credit note (full or partial) for a paid registration — the organizer
 * action that precedes a refund. Owns the paid-state gate, the amount cap (via
 * `createCreditNote`, which locks the registration row), the optional email, and
 * the audit log. The route handles auth / rate limit / event access.
 */
export async function issueCreditNoteForRegistration(input: IssueCreditNoteInput): Promise<IssueCreditNoteResult> {
  const { registrationId, eventId, organizationId, amount, reason, send, source, issuedByUserId } = input;

  try {
    const registration = await db.registration.findUnique({
      where: { id: registrationId },
      select: { id: true, eventId: true, paymentStatus: true },
    });
    if (!registration || registration.eventId !== eventId) {
      return { ok: false, code: "REGISTRATION_NOT_FOUND", message: "Registration not found" };
    }
    // A credit note only makes sense against money that was actually collected.
    if (registration.paymentStatus !== "PAID" && registration.paymentStatus !== "REFUNDED") {
      return { ok: false, code: "NOT_PAID", message: "A credit note can only be issued for a paid registration." };
    }

    let cn, creditedAfter: number, paidTotal: number;
    try {
      const res = await createCreditNote({ registrationId, eventId, organizationId, reason, amount });
      cn = res.invoice;
      creditedAfter = res.creditedAfter;
      paidTotal = res.paidTotal;
    } catch (err) {
      if (err instanceof CreditNoteAmountError) {
        apiLogger.warn({ msg: "credit-note:amount-rejected", eventId, registrationId, code: err.code, meta: err.meta });
        return { ok: false, code: err.code, message: err.message, meta: err.meta };
      }
      throw err;
    }

    if (send) {
      await sendInvoiceEmail(cn.id).catch((err) =>
        apiLogger.error({ err, msg: "credit-note:send-failed", creditNoteId: cn.id, registrationId }),
      );
    }

    db.auditLog
      .create({
        data: {
          eventId,
          userId: issuedByUserId ?? null,
          action: "CREDIT_NOTE_ISSUED",
          entityType: "Registration",
          entityId: registrationId,
          changes: { source, creditNoteId: cn.id, invoiceNumber: cn.invoiceNumber, amount: Number(cn.total), currency: cn.currency, creditedAfter, paidTotal, emailed: !!send },
        },
      })
      .catch((err) => apiLogger.warn({ err, msg: "credit-note:audit-write-failed", creditNoteId: cn.id }));

    apiLogger.info({
      msg: "Credit note issued",
      eventId, registrationId, creditNoteId: cn.id, invoiceNumber: cn.invoiceNumber,
      amount: Number(cn.total), creditedAfter, paidTotal, emailed: !!send, source, issuedBy: issuedByUserId ?? null,
    });

    return {
      ok: true,
      creditNote: {
        creditNoteId: cn.id,
        invoiceNumber: cn.invoiceNumber,
        amount: Number(cn.total),
        currency: cn.currency,
        creditedAfter,
        paidTotal,
        emailed: !!send,
      },
    };
  } catch (err) {
    apiLogger.error({ err, msg: "issueCreditNoteForRegistration:unknown-failure", eventId, registrationId });
    return { ok: false, code: "UNKNOWN", message: "Failed to issue the credit note" };
  }
}

// ── refundRegistration ───────────────────────────────────────────────────────

export interface RefundRegistrationInput {
  /** Caller must have already verified event access. */
  registrationId: string;
  eventId: string;
  /** Refund amount (tax-inclusive). Omit to refund the full remaining balance. */
  amount?: number;
  source: PaymentSource;
  issuedByUserId?: string | null;
}

export type RefundErrorCode =
  | "REGISTRATION_NOT_FOUND"
  | "NOT_PAID"
  | "CREDIT_NOTE_REQUIRED"
  | "ALREADY_FULLY_REFUNDED"
  | "INVALID_AMOUNT"
  | "LOST_LOCK"
  | "STRIPE_FAILED"
  | "UNKNOWN";

export interface RefundSummary {
  refundId: string | null;
  manual: boolean;
  status: "succeeded" | "recorded";
  amount: number;
  currency: string;
  refundedAmount: number;
  paidTotal: number;
  fullyRefunded: boolean;
}

export type RefundRegistrationResult =
  | { ok: true; refund: RefundSummary }
  | { ok: false; code: RefundErrorCode; message: string; meta?: Record<string, unknown> };

/**
 * Issue a refund — full or partial — for a paid registration.
 *
 * Gated on a credit note: a non-cancelled CREDIT_NOTE must already exist (issued
 * separately). Partial refunds accumulate into `Registration.refundedAmount`;
 * the reg stays PAID while `refundedAmount < paidTotal` and flips to REFUNDED
 * only when fully refunded. Stripe (partial `amount`) or manual/offline (record
 * only). Concurrency-safe via an optimistic lock on `refundedAmount`.
 */
export async function refundRegistration(input: RefundRegistrationInput): Promise<RefundRegistrationResult> {
  const { registrationId, eventId, source, issuedByUserId } = input;

  try {
    const registration = await db.registration.findUnique({
      where: { id: registrationId },
      select: {
        id: true,
        serialId: true,
        eventId: true,
        paymentStatus: true,
        refundedAmount: true,
        // originalPrice/discountAmount + tier/ticket price feed the computed paid
        // total when there's no Payment row (a PAID reg hand-flipped without one).
        originalPrice: true,
        discountAmount: true,
        attendee: { select: { firstName: true, lastName: true } },
        ticketType: { select: { price: true, currency: true } },
        pricingTier: { select: { price: true, currency: true } },
        event: { select: { organizationId: true, taxRate: true, taxLabel: true } },
        payments: {
          where: { status: "PAID" },
          orderBy: { createdAt: "desc" },
          select: { id: true, stripePaymentId: true, amount: true, currency: true },
        },
      },
    });

    if (!registration || registration.eventId !== eventId) {
      return { ok: false, code: "REGISTRATION_NOT_FOUND", message: "Registration not found" };
    }
    if (registration.paymentStatus !== "PAID") {
      return { ok: false, code: "NOT_PAID", message: "Registration is not in a paid state" };
    }

    // Gate: a non-cancelled credit note must already exist.
    const creditNote = await db.invoice.findFirst({
      where: { registrationId, type: "CREDIT_NOTE", status: { not: "CANCELLED" } },
      select: { id: true },
    });
    if (!creditNote) {
      apiLogger.warn({ msg: "refund:credit-note-required", registrationId, eventId });
      return {
        ok: false,
        code: "CREDIT_NOTE_REQUIRED",
        message: "Issue a credit note for this registration before refunding.",
      };
    }

    // Most recent PAID payment. Stripe payments carry a `stripePaymentId`; a
    // manual/offline payment (or no Payment row at all) does not → recorded, not
    // reversed in Stripe.
    const payment = registration.payments[0];
    const isManualRefund = !payment?.stripePaymentId;

    const currency = (
      payment?.currency ||
      registration.pricingTier?.currency ||
      registration.ticketType?.currency ||
      "USD"
    ).toUpperCase();

    // Total collected — sum of PAID payments, else the computed registration total.
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
      return { ok: false, code: "ALREADY_FULLY_REFUNDED", message: "This registration has already been fully refunded." };
    }

    const amount = input.amount != null ? round2(input.amount) : remaining;
    if (amount <= 0 || amount > remaining + 0.005) {
      apiLogger.warn({ msg: "refund:amount-out-of-range", registrationId, amount, remaining, paidTotal });
      return {
        ok: false,
        code: "INVALID_AMOUNT",
        message: `Refund amount must be between ${currency} 0.01 and ${currency} ${remaining.toFixed(2)} (already refunded ${currency} ${refundedBefore.toFixed(2)} of ${currency} ${paidTotal.toFixed(2)}).`,
        meta: { remaining, paidTotal, refundedBefore },
      };
    }

    const refundedAfter = round2(refundedBefore + amount);
    const isFull = refundedAfter >= paidTotal - 0.005;
    const formattedAmount = `${currency} ${amount.toFixed(2)}`;

    // Optimistic lock on the running refunded total: guarded by the observed
    // `refundedAmount` so two concurrent refunds can't both commit (loser → LOST_LOCK).
    const locked = await db.registration.updateMany({
      where: { id: registrationId, paymentStatus: "PAID", refundedAmount: registration.refundedAmount },
      data: {
        refundedAmount: refundedAfter,
        ...(isFull ? { paymentStatus: "REFUNDED" as const } : {}),
      },
    });
    if (locked.count === 0) {
      return { ok: false, code: "LOST_LOCK", message: "A refund for this registration is already in progress." };
    }

    let stripeRefundId: string | null = null;
    if (isManualRefund) {
      apiLogger.info({
        msg: "Manual/offline refund recorded (no Stripe charge to reverse)",
        registrationId, eventId, paymentId: payment?.id ?? null, amount, currency, partial: !isFull, source, issuedBy: issuedByUserId ?? null,
      });
    } else {
      // Stripe partial refund. Idempotency key carries the cumulative refunded
      // total so each partial is distinct but a retry of the SAME partial dedups.
      try {
        const stripe = getStripe();
        const refund = await stripe.refunds.create(
          { payment_intent: payment!.stripePaymentId!, amount: toStripeAmount(amount, currency) },
          { idempotencyKey: `refund-${payment!.id}-${refundedAfter.toFixed(2)}` }
        );
        stripeRefundId = refund.id;
      } catch (stripeErr) {
        // Roll the running total back — no money moved.
        await db.registration.update({
          where: { id: registrationId },
          data: { refundedAmount: registration.refundedAmount, paymentStatus: "PAID" },
        }).catch((rollbackErr) => apiLogger.error({ rollbackErr, msg: "Failed to roll back refunded amount after Stripe error", registrationId }));
        apiLogger.error({ err: stripeErr, msg: "Stripe refund failed", registrationId, paymentIntentId: payment!.stripePaymentId });
        return { ok: false, code: "STRIPE_FAILED", message: "Refund could not be processed. Please try again or issue the refund directly in Stripe." };
      }
      apiLogger.info({
        msg: "Refund issued",
        registrationId, eventId, stripeRefundId, amount, currency, partial: !isFull, refundedAfter, paidTotal, source, issuedBy: issuedByUserId ?? null,
      });
    }

    // Flip the Payment record to REFUNDED only on a FULL refund (a partial leaves
    // it PAID so `paidTotal` still sums correctly).
    if (isFull && payment) {
      await db.payment.update({ where: { id: payment.id }, data: { status: "REFUNDED" } });
    }

    refreshEventStats(eventId);

    notifyEventAdmins(eventId, {
      type: "PAYMENT",
      title: isFull ? "Refund Issued" : "Partial Refund Issued",
      message: `${isFull ? "Refund" : "Partial refund"} of ${formattedAmount} issued to ${registration.attendee.firstName} ${registration.attendee.lastName}${isFull ? "" : ` (${currency} ${refundedAfter.toFixed(2)} of ${currency} ${paidTotal.toFixed(2)})`}`,
      link: `/events/${eventId}/registrations`,
    }).catch((err: unknown) => apiLogger.error({ err, msg: "Failed to send refund admin notification" }));

    // Audit trail (fire-and-forget — must not block the refund response).
    db.auditLog
      .create({
        data: {
          eventId,
          userId: issuedByUserId ?? null,
          action: isFull ? "REFUND_ISSUED" : "PARTIAL_REFUND_ISSUED",
          entityType: "Registration",
          entityId: registrationId,
          changes: { source, amount, currency, refundedAmount: refundedAfter, paidTotal, fullyRefunded: isFull, manual: isManualRefund, stripeRefundId },
        },
      })
      .catch((err) => apiLogger.warn({ err, msg: "refund:audit-write-failed", registrationId }));

    // NOTE: no automatic refund-confirmation email to the attendee — the
    // organizer communicates the refund manually (consistent with the
    // credit-note flow). The admin notification above is in-app only.

    return {
      ok: true,
      refund: {
        refundId: stripeRefundId,
        manual: isManualRefund,
        status: stripeRefundId ? "succeeded" : "recorded",
        amount,
        currency,
        refundedAmount: refundedAfter,
        paidTotal,
        fullyRefunded: isFull,
      },
    };
  } catch (err) {
    apiLogger.error({ err, msg: "refundRegistration:unknown-failure", registrationId, eventId });
    return { ok: false, code: "UNKNOWN", message: "Failed to issue refund" };
  }
}

// ── cancelRegistration ───────────────────────────────────────────────────────

export interface CancelRegistrationInput {
  registrationId: string;
  eventId: string;
  organizationId: string;
  /** When true and the registration is PAID, auto-issue a credit note + refund
   *  the remaining balance before cancelling. */
  refund: boolean;
  source: PaymentSource;
  issuedByUserId?: string | null;
}

export type CancelRegistrationErrorCode =
  | "REGISTRATION_NOT_FOUND"
  | "ALREADY_CANCELLED"
  | "REFUND_FAILED"
  | "UNKNOWN";

export interface CancelSummary {
  status: "CANCELLED";
  refunded: boolean;
  refund?: RefundSummary;
}

export type CancelRegistrationResult =
  | { ok: true; cancel: CancelSummary }
  | { ok: false; code: CancelRegistrationErrorCode; message: string; meta?: Record<string, unknown> };

/**
 * Cancel a registration — releasing its seat + promo usage — and, for a PAID
 * registration when `refund` is set, auto-issue a full credit note and refund
 * the remaining balance FIRST. Refund-before-cancel: if the refund fails we do
 * NOT cancel (the reg stays active + recoverable, no money moved into limbo).
 *
 * COMPLIMENTARY / INCLUSIVE / UNPAID registrations have nothing to refund — they
 * are simply cancelled (their balance already shows 0, see the detail route).
 * An already-fully-refunded PAID reg is cancelled without a second refund.
 */
export async function cancelRegistration(input: CancelRegistrationInput): Promise<CancelRegistrationResult> {
  const { registrationId, eventId, organizationId, refund, source, issuedByUserId } = input;

  try {
    const reg = await db.registration.findUnique({
      where: { id: registrationId },
      select: {
        id: true,
        eventId: true,
        status: true,
        paymentStatus: true,
        attendanceMode: true,
        ticketTypeId: true,
        pricingTierId: true,
        createdSource: true,
        promoCodeId: true,
      },
    });
    if (!reg || reg.eventId !== eventId) {
      return { ok: false, code: "REGISTRATION_NOT_FOUND", message: "Registration not found" };
    }
    if (reg.status === "CANCELLED") {
      return { ok: false, code: "ALREADY_CANCELLED", message: "Registration is already cancelled" };
    }

    // ── Refund first (only a PAID reg has collected money to return) ──────────
    let refundSummary: RefundSummary | undefined;
    let refunded = false;
    if (refund && reg.paymentStatus === "PAID") {
      // Auto-issue a credit note for the outstanding credit. Tolerate "already
      // fully credited" (INVALID_AMOUNT / CREDIT_LIMIT_EXCEEDED) — a credit note
      // already exists, which is all the refund gate needs.
      const cnRes = await issueCreditNoteForRegistration({ registrationId, eventId, organizationId, source, issuedByUserId });
      if (!cnRes.ok && cnRes.code !== "INVALID_AMOUNT" && cnRes.code !== "CREDIT_LIMIT_EXCEEDED") {
        return {
          ok: false,
          code: "REFUND_FAILED",
          message: `Could not issue the credit note for the refund: ${cnRes.message}`,
          meta: { step: "credit-note", code: cnRes.code },
        };
      }

      const refundRes = await refundRegistration({ registrationId, eventId, source, issuedByUserId });
      if (refundRes.ok) {
        refundSummary = refundRes.refund;
        refunded = true;
      } else if (refundRes.code !== "ALREADY_FULLY_REFUNDED") {
        // A real refund failure aborts the cancel — nothing is left in limbo.
        return {
          ok: false,
          code: "REFUND_FAILED",
          message: refundRes.message,
          meta: { step: "refund", code: refundRes.code, ...(refundRes.meta ?? {}) },
        };
      }
    }

    // ── Cancel: claim the transition, then apply the shared seat+promo release ─
    await db.$transaction(async (tx) => {
      // Claim first so a concurrent cancel can't double-release the seat/promo.
      const claim = await tx.registration.updateMany({
        where: { id: registrationId, status: { not: "CANCELLED" } },
        data: { status: "CANCELLED" },
      });
      if (claim.count === 0) return; // lost the race — someone else cancelled
      // Single source of truth for seat + promo release (shared with the REST PUT
      // + MCP update paths) — see src/services/README.md "THE RULE".
      await applyRegistrationTransition(tx, {
        prev: { status: reg.status, attendanceMode: reg.attendanceMode, ticketTypeId: reg.ticketTypeId, pricingTierId: reg.pricingTierId, createdSource: reg.createdSource },
        next: { status: "CANCELLED", attendanceMode: reg.attendanceMode, ticketTypeId: reg.ticketTypeId, pricingTierId: reg.pricingTierId, createdSource: reg.createdSource },
        promoCodeId: reg.promoCodeId,
      });
    });

    refreshEventStats(eventId);

    db.auditLog
      .create({
        data: {
          eventId,
          userId: issuedByUserId ?? null,
          action: "REGISTRATION_CANCELLED",
          entityType: "Registration",
          entityId: registrationId,
          changes: { source, refunded, refundAmount: refundSummary?.amount ?? null, currency: refundSummary?.currency ?? null },
        },
      })
      .catch((err) => apiLogger.warn({ err, msg: "cancel:audit-write-failed", registrationId }));

    apiLogger.info({ msg: "Registration cancelled", registrationId, eventId, refunded, refundAmount: refundSummary?.amount ?? null, source, issuedBy: issuedByUserId ?? null });

    return { ok: true, cancel: { status: "CANCELLED", refunded, refund: refundSummary } };
  } catch (err) {
    apiLogger.error({ err, msg: "cancelRegistration:unknown-failure", registrationId, eventId });
    return { ok: false, code: "UNKNOWN", message: "Failed to cancel the registration" };
  }
}
