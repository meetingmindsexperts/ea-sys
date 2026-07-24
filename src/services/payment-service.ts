import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getStripe, toStripeAmount } from "@/lib/stripe";
import { notifyEventAdmins } from "@/lib/notifications";
import { refreshEventStats } from "@/lib/event-stats";
import { computeRegistrationFinancials, readRegistrationBasePrice, round2 } from "@/lib/registration-financials";
import { createCreditNote, sendInvoiceEmail, CreditNoteAmountError } from "@/lib/invoice-service";
import { applyRegistrationTransition } from "@/lib/registration-seat-db";
import { expireOpenCheckoutSessionOnCancel } from "@/lib/checkout-session-cleanup";
import { findStripeRefundForAttempt } from "@/lib/refund-reconciliation";

/**
 * Payment service — the domain home for money movement on a registration:
 * refunds (full/partial), and (later) manual capture + cancellation orchestration.
 *
 * Errors-as-values (see src/services/README.md). The service owns the money
 * logic + all downstream side effects (Payment flip, event stats, admin
 * notification, audit log); callers handle auth, HTTP/MCP shaping, rate limits.
 * Never imports `next/server`.
 */

// round2 comes from registration-financials (review M9 — one shared copy).

const truncateError = (err: unknown) => String(err instanceof Error ? err.message : err).slice(0, 500);

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
      apiLogger.warn({ msg: "credit-note:registration-not-found", registrationId, eventId });
      return { ok: false, code: "REGISTRATION_NOT_FOUND", message: "Registration not found" };
    }
    // A credit note only makes sense against money that was actually collected.
    if (registration.paymentStatus !== "PAID" && registration.paymentStatus !== "REFUNDED") {
      apiLogger.warn({ msg: "credit-note:not-paid", registrationId, eventId, paymentStatus: registration.paymentStatus });
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
  | "CREDIT_NOTE_INSUFFICIENT"
  | "ALREADY_FULLY_REFUNDED"
  | "INVALID_AMOUNT"
  | "LOST_LOCK"
  | "STRIPE_FAILED"
  | "REFUND_PARTIALLY_COMPLETED"
  | "REFUND_STATE_UNKNOWN"
  | "UNKNOWN";

/** One allocated part of a refund: which payment it came from and how. */
export interface RefundSliceSummary {
  paymentId: string | null;
  kind: "stripe" | "manual";
  amount: number;
  stripeRefundId: string | null;
}

export interface RefundSummary {
  refundId: string | null;
  manual: boolean;
  status: "succeeded" | "recorded";
  amount: number;
  currency: string;
  refundedAmount: number;
  paidTotal: number;
  fullyRefunded: boolean;
  /** How the amount was allocated across the registration's payments. */
  slices: RefundSliceSummary[];
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
        // Settled money: PAID + REFUNDED rows both represent collected funds
        // (REFUNDED just means that payment was already fully returned — its
        // per-payment remaining is 0 and the allocator skips it naturally).
        payments: {
          where: { status: { in: ["PAID", "REFUNDED"] } },
          orderBy: { createdAt: "desc" },
          select: { id: true, stripePaymentId: true, amount: true, currency: true, refundedAmount: true },
        },
      },
    });

    if (!registration || registration.eventId !== eventId) {
      apiLogger.warn({ msg: "refund:registration-not-found", registrationId, eventId });
      return { ok: false, code: "REGISTRATION_NOT_FOUND", message: "Registration not found" };
    }
    if (registration.paymentStatus !== "PAID") {
      apiLogger.warn({ msg: "refund:not-paid", registrationId, eventId, paymentStatus: registration.paymentStatus });
      return { ok: false, code: "NOT_PAID", message: "Registration is not in a paid state" };
    }

    // Gate 1: a non-cancelled credit note must already exist. The totals feed
    // gate 2 (the AMOUNT gate) further down, once the refund amount is known.
    const creditNotes = await db.invoice.findMany({
      where: { registrationId, type: "CREDIT_NOTE", status: { not: "CANCELLED" } },
      select: { total: true },
    });
    if (creditNotes.length === 0) {
      apiLogger.warn({ msg: "refund:credit-note-required", registrationId, eventId });
      return {
        ok: false,
        code: "CREDIT_NOTE_REQUIRED",
        message: "Issue a credit note for this registration before refunding.",
      };
    }
    const creditedTotal = round2(creditNotes.reduce((s, c) => s + Number(c.total), 0));

    const settledPayments = registration.payments;

    const currency = (
      settledPayments[0]?.currency ||
      registration.pricingTier?.currency ||
      registration.ticketType?.currency ||
      "USD"
    ).toUpperCase();

    // Total collected — sum of settled payments, else the computed registration total.
    const paidTotal = settledPayments.length
      ? round2(settledPayments.reduce((s, p) => s + Number(p.amount), 0))
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
      apiLogger.warn({ msg: "refund:already-fully-refunded", registrationId, eventId });
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

    // Gate 2 — the AMOUNT gate (July 7 review M2, closed July 11): cumulative
    // refunds may never exceed what was credited via credit notes. Before this,
    // the gate only checked a CN *existed*, so a $1 credit note unlocked a
    // full-balance refund — defeating the credit-note-first control. The UI
    // mirrors the cap; this is the authoritative check.
    if (refundedAfter > creditedTotal + 0.005) {
      const maxRefundable = round2(Math.max(0, creditedTotal - refundedBefore));
      apiLogger.warn({
        msg: "refund:credit-note-insufficient",
        registrationId, eventId, amount, refundedBefore, creditedTotal, maxRefundable,
      });
      return {
        ok: false,
        code: "CREDIT_NOTE_INSUFFICIENT",
        message: `Refunds are capped by the credited total: ${currency} ${creditedTotal.toFixed(2)} credited, ${currency} ${refundedBefore.toFixed(2)} already refunded — at most ${currency} ${maxRefundable.toFixed(2)} can be refunded now. Issue a credit note for the difference first.`,
        meta: { creditedTotal, refundedBefore, requested: amount, maxRefundable },
      };
    }

    const isFull = refundedAfter >= paidTotal - 0.005;
    const formattedAmount = `${currency} ${amount.toFixed(2)}`;

    // ── Allocation: which payment does each part of this refund come from? ──
    // Stripe charges first (they reverse automatically), newest first; then
    // manual/offline payments (recorded only); any residue is unattributed (a
    // PAID reg hand-flipped with no Payment rows). Every slice is capped at
    // its payment's own remaining (`amount - refundedAmount`), so a Stripe
    // refund can never exceed its charge — the old payments[0]-only pick
    // either buried a live Stripe charge inside a "manual" refund or called
    // Stripe for more than the charge held (review H6).
    const stripeSlices: Array<{ payment: (typeof settledPayments)[number]; take: number }> = [];
    const manualSlices: Array<{ payment: (typeof settledPayments)[number]; take: number }> = [];
    let unallocated = amount;
    for (const p of settledPayments) {
      if (unallocated <= 0.005) break;
      if (!p.stripePaymentId) continue;
      const paymentRemaining = round2(Number(p.amount) - Number(p.refundedAmount ?? 0));
      if (paymentRemaining <= 0.005) continue;
      const take = round2(Math.min(paymentRemaining, unallocated));
      stripeSlices.push({ payment: p, take });
      unallocated = round2(unallocated - take);
    }
    for (const p of settledPayments) {
      if (unallocated <= 0.005) break;
      if (p.stripePaymentId) continue;
      const paymentRemaining = round2(Number(p.amount) - Number(p.refundedAmount ?? 0));
      if (paymentRemaining <= 0.005) continue;
      const take = round2(Math.min(paymentRemaining, unallocated));
      manualSlices.push({ payment: p, take });
      unallocated = round2(unallocated - take);
    }
    // Manual portion = manual-payment slices + anything unattributable.
    const manualPortion = round2(manualSlices.reduce((s, x) => s + x.take, 0) + Math.max(0, unallocated));
    const isManualRefund = stripeSlices.length === 0;

    // ── Crash-safe booking: claim + persist the attempts ATOMICALLY ─────────
    // Optimistic lock on the running refunded total (loser → LOST_LOCK), and
    // in the SAME transaction one RefundAttempt row per slice — persisted
    // BEFORE any Stripe call. Each attempt id is its slice's Stripe
    // idempotency key AND rides in the refund's metadata, so whatever happens
    // next (process death, timeout, ambiguous SDK error) each slice is
    // verifiable against Stripe: inline below on error, or by the sweep in
    // src/lib/refund-reconciliation.ts for anything left PENDING/UNKNOWN.
    const attemptPlan: Array<{ kind: "stripe" | "manual"; paymentId: string | null; intentId: string | null; take: number }> = [
      ...stripeSlices.map((s) => ({ kind: "stripe" as const, paymentId: s.payment.id, intentId: s.payment.stripePaymentId, take: s.take })),
      ...(manualPortion > 0.005
        ? [{ kind: "manual" as const, paymentId: manualSlices[0]?.payment.id ?? null, intentId: null, take: manualPortion }]
        : []),
    ];

    const attempts = await db.$transaction(async (tx) => {
      const locked = await tx.registration.updateMany({
        where: { id: registrationId, paymentStatus: "PAID", refundedAmount: registration.refundedAmount },
        data: {
          refundedAmount: refundedAfter,
          ...(isFull ? { paymentStatus: "REFUNDED" as const } : {}),
        },
      });
      if (locked.count === 0) return null;
      const rows: { id: string }[] = [];
      let running = refundedBefore;
      for (let i = 0; i < attemptPlan.length; i++) {
        const p = attemptPlan[i];
        const after = round2(running + p.take);
        rows.push(
          await tx.refundAttempt.create({
            data: {
              registrationId,
              paymentId: p.paymentId,
              stripePaymentIntentId: p.intentId,
              amount: p.take,
              refundedBefore: running,
              refundedAfter: after,
              // The booking flips the reg once, for the whole claim — the
              // flag lives on the LAST slice so the sweep un-flips at most once.
              flippedToRefunded: isFull && i === attemptPlan.length - 1,
              kind: p.kind,
              source,
              issuedByUserId: issuedByUserId ?? null,
            },
            select: { id: true },
          }),
        );
        running = after;
      }
      return rows;
    });
    if (!attempts) {
      apiLogger.warn({ msg: "refund:lost-lock", registrationId, eventId });
      return { ok: false, code: "LOST_LOCK", message: "A refund for this registration is already in progress." };
    }

    // ── Execution: run each Stripe slice, then record the manual portion ────
    const completedSlices: RefundSliceSummary[] = [];
    let stripeRefundId: string | null = null;

    /** A slice can't proceed: un-book everything not executed (and not kept as
     *  UNKNOWN) via a guarded decrement, un-flip if the booking flipped, and
     *  mark the failed + never-attempted attempt rows. */
    const abortRemainder = async (args: { keptUnknown: number; failedAttemptIndex: number; failedStatus: "FAILED" | "UNKNOWN"; err: unknown }) => {
      const executed = round2(completedSlices.reduce((s, r) => s + r.amount, 0));
      const rollbackPortion = round2(amount - executed - args.keptUnknown);
      let rollbackApplied = true;
      if (rollbackPortion > 0.005) {
        // Decrement (not set-back): a webhook may have adjusted OTHER charges'
        // refunds in the window — we only un-book the portion WE know never
        // moved. Guarded so it can't go negative.
        const rolledBack = await db.registration
          .updateMany({
            where: { id: registrationId, refundedAmount: { gte: rollbackPortion } },
            data: {
              refundedAmount: { decrement: rollbackPortion },
              // The booking flipped REFUNDED only when the FULL amount was
              // booked; un-booking any part means the reg isn't fully refunded.
              ...(isFull ? { paymentStatus: "PAID" as const } : {}),
            },
          })
          .catch((rollbackErr) => {
            apiLogger.error({ rollbackErr, msg: "refund:rollback-failed — sweep will reconcile", registrationId });
            return null;
          });
        rollbackApplied = !!rolledBack && rolledBack.count > 0;
        if (!rollbackApplied) {
          apiLogger.error({ msg: "refund:rollback-did-not-apply — sweep will reconcile", registrationId, rollbackPortion });
        }
      }
      // A rollback that didn't apply leaves the books overstated — keep the
      // failed slice UNKNOWN (not FAILED) so the sweep keeps reconciling it.
      const failedStatus = rollbackApplied ? args.failedStatus : "UNKNOWN";
      for (let j = args.failedAttemptIndex; j < attempts.length; j++) {
        const status = j === args.failedAttemptIndex ? failedStatus : "FAILED";
        const error =
          j === args.failedAttemptIndex
            ? rollbackApplied
              ? truncateError(args.err)
              : `Rollback did not apply: ${truncateError(args.err)}`
            : "Aborted: an earlier refund slice failed (booking rolled back)";
        await db.refundAttempt
          .update({ where: { id: attempts[j].id }, data: { status, error } })
          .catch((err) => apiLogger.warn({ err, msg: "refund:attempt-status-update-failed", attemptId: attempts[j].id }));
      }
      return { executed, rollbackPortion, rollbackApplied };
    };

    for (let i = 0; i < stripeSlices.length; i++) {
      const slice = stripeSlices[i];
      const attemptId = attempts[i].id;
      let sliceRefundId: string | null = null;
      try {
        const stripe = getStripe();
        const refund = await stripe.refunds.create(
          {
            payment_intent: slice.payment.stripePaymentId!,
            amount: toStripeAmount(slice.take, currency),
            // Ground truth for verification/reconciliation — never remove.
            metadata: { refundAttemptId: attemptId, registrationId },
          },
          // Per-attempt key: immune to the cumulative-total collision that
          // wedged retries after a rollback (same cumulative reached by a
          // different amount → Stripe idempotency_error for ~24h).
          { idempotencyKey: `refund-attempt-${attemptId}` },
        );
        sliceRefundId = refund.id;
      } catch (stripeErr) {
        // The SDK throwing does NOT mean the refund didn't happen (client
        // timeouts). VERIFY against Stripe before deciding — rolling back a
        // refund that actually went through would erase real money movement
        // (and a webhook that already delta-skipped will never redeliver).
        const outcome = await findStripeRefundForAttempt(slice.payment.stripePaymentId!, attemptId);

        if (outcome.verified && outcome.found) {
          // This slice's refund exists at Stripe — treat as success.
          sliceRefundId = outcome.refundId;
          apiLogger.warn({
            msg: "refund:stripe-error-but-refund-exists — booking kept",
            err: stripeErr, registrationId, attemptId, stripeRefundId: sliceRefundId,
          });
        } else if (outcome.verified) {
          // Provably no refund for THIS slice → un-book it + the remainder.
          const { executed, rollbackPortion, rollbackApplied } = await abortRemainder({ keptUnknown: 0, failedAttemptIndex: i, failedStatus: "FAILED", err: stripeErr });
          apiLogger.error({ err: stripeErr, msg: "Stripe refund failed", registrationId, attemptId, paymentIntentId: slice.payment.stripePaymentId, executed, rollbackPortion });
          if (!rollbackApplied) {
            // Books may still overstate — the attempt stays UNKNOWN and the
            // sweep reconciles it; tell the operator not to retry blindly.
            return {
              ok: false,
              code: "REFUND_STATE_UNKNOWN",
              message: "The refund could not be completed and the books need reconciliation — the system will resolve it automatically within ~10 minutes. Check the Stripe Dashboard before retrying.",
              meta: { refundedThisCall: executed, slices: completedSlices },
            };
          }
          if (executed > 0.005) {
            return {
              ok: false,
              code: "REFUND_PARTIALLY_COMPLETED",
              message: `Refunded ${currency} ${executed.toFixed(2)} of ${formattedAmount} before a payment's refund failed — the un-refunded remainder was released. Retry to refund the rest, or finish it in Stripe.`,
              meta: { refundedThisCall: executed, failedAmount: rollbackPortion, slices: completedSlices },
            };
          }
          return { ok: false, code: "STRIPE_FAILED", message: "Refund could not be processed. Please try again or issue the refund directly in Stripe." };
        } else {
          // Stripe unreachable for verification too — keep THIS slice booked
          // (rolling back blind risks erasing a real refund), un-book only the
          // never-attempted remainder, alert, let the sweep resolve.
          const { executed } = await abortRemainder({ keptUnknown: slice.take, failedAttemptIndex: i, failedStatus: "UNKNOWN", err: stripeErr });
          apiLogger.error({ err: stripeErr, msg: "refund:state-unknown — verification unavailable, sweep will reconcile", registrationId, attemptId });
          notifyEventAdmins(eventId, {
            type: "PAYMENT",
            title: "⚠ Refund state unknown",
            message: `A ${currency} ${slice.take.toFixed(2)} refund for ${registration.attendee.firstName} ${registration.attendee.lastName} could not be confirmed with Stripe — the system will reconcile automatically within ~10 minutes. Check the Stripe Dashboard before retrying.`,
            link: `/events/${eventId}/registrations`,
          }).catch((err: unknown) => apiLogger.error({ err, msg: "Failed to send refund-unknown admin notification" }));
          return {
            ok: false,
            code: "REFUND_STATE_UNKNOWN",
            message: "The refund could not be confirmed with Stripe. The system will reconcile automatically within ~10 minutes — check the Stripe Dashboard before retrying.",
            meta: { refundedThisCall: executed, unconfirmedAmount: slice.take, slices: completedSlices },
          };
        }
      }

      // Slice succeeded (directly or via verification): persist per-payment truth.
      stripeRefundId ??= sliceRefundId;
      await db.refundAttempt
        .update({ where: { id: attemptId }, data: { status: "SUCCEEDED", stripeRefundId: sliceRefundId } })
        .catch((err) => apiLogger.warn({ err, msg: "refund:attempt-status-update-failed", attemptId }));
      const paymentRefundedAfter = round2(Number(slice.payment.refundedAmount ?? 0) + slice.take);
      await db.payment
        .update({
          where: { id: slice.payment.id },
          data: {
            refundedAmount: paymentRefundedAfter,
            ...(paymentRefundedAfter >= Number(slice.payment.amount) - 0.005 ? { status: "REFUNDED" as const } : {}),
          },
        })
        .catch((err) => apiLogger.error({ err, msg: "refund:payment-counter-update-failed", registrationId, paymentId: slice.payment.id }));
      completedSlices.push({ paymentId: slice.payment.id, kind: "stripe", amount: slice.take, stripeRefundId: sliceRefundId });
    }

    // Manual portion (manual-payment slices + unattributed residue): the money
    // moves out-of-band — the booking IS the record. A missed status update is
    // benign: the sweep confirms stale manual attempts.
    if (manualPortion > 0.005) {
      const manualAttemptId = attempts[attempts.length - 1].id;
      for (const m of manualSlices) {
        const paymentRefundedAfter = round2(Number(m.payment.refundedAmount ?? 0) + m.take);
        await db.payment
          .update({
            where: { id: m.payment.id },
            data: {
              refundedAmount: paymentRefundedAfter,
              ...(paymentRefundedAfter >= Number(m.payment.amount) - 0.005 ? { status: "REFUNDED" as const } : {}),
            },
          })
          .catch((err) => apiLogger.error({ err, msg: "refund:payment-counter-update-failed", registrationId, paymentId: m.payment.id }));
      }
      await db.refundAttempt
        .update({ where: { id: manualAttemptId }, data: { status: "SUCCEEDED" } })
        .catch((err) => apiLogger.warn({ err, msg: "refund:attempt-status-update-failed", attemptId: manualAttemptId }));
      completedSlices.push({ paymentId: manualSlices[0]?.payment.id ?? null, kind: "manual", amount: manualPortion, stripeRefundId: null });
      apiLogger.info({
        msg: "Manual/offline refund recorded (no Stripe charge to reverse)",
        registrationId, eventId, attemptId: manualAttemptId, amount: manualPortion, currency, partial: !isFull, source, issuedBy: issuedByUserId ?? null,
      });
    }

    if (stripeSlices.length > 0) {
      apiLogger.info({
        msg: "Refund issued",
        registrationId, eventId, stripeRefundId, amount, currency, partial: !isFull, refundedAfter, paidTotal, slices: completedSlices.length, source, issuedBy: issuedByUserId ?? null,
      });
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
          changes: { source, amount, currency, refundedAmount: refundedAfter, paidTotal, fullyRefunded: isFull, manual: isManualRefund, stripeRefundId, slices: JSON.parse(JSON.stringify(completedSlices)) },
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
        slices: completedSlices,
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
  /** The refund completed but the cancel transaction failed — retry the
   *  cancel; the refund will not run twice (review M2, July 8). */
  | "CANCEL_FAILED_AFTER_REFUND"
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
        // For the nothing-left-to-refund short-circuit (review L2, July 8).
        refundedAmount: true,
        payments: {
          where: { status: { in: ["PAID", "REFUNDED"] } },
          select: { amount: true },
        },
      },
    });
    if (!reg || reg.eventId !== eventId) {
      apiLogger.warn({ msg: "cancel:registration-not-found", registrationId, eventId });
      return { ok: false, code: "REGISTRATION_NOT_FOUND", message: "Registration not found" };
    }
    if (reg.status === "CANCELLED") {
      apiLogger.warn({ msg: "cancel:already-cancelled", registrationId, eventId });
      return { ok: false, code: "ALREADY_CANCELLED", message: "Registration is already cancelled" };
    }

    // ── Refund first (only a PAID reg has collected money to return) ──────────
    let refundSummary: RefundSummary | undefined;
    let refunded = false;
    // L2 (July 8): when the settled payments are already fully refunded, skip
    // the CN + refund entirely — issuing the auto-CN first could mint a
    // spurious credit note a moment before the refund reports
    // ALREADY_FULLY_REFUNDED. Only decidable from Payment rows; a PAID reg
    // with none (hand-flipped) keeps the normal flow.
    const settledSum = round2(reg.payments.reduce((s, p) => s + Number(p.amount), 0));
    const nothingLeftToRefund =
      reg.payments.length > 0 && round2(Number(reg.refundedAmount)) >= settledSum - 0.005;
    if (refund && reg.paymentStatus === "PAID" && nothingLeftToRefund) {
      apiLogger.info({ msg: "cancel:nothing-left-to-refund — skipping CN + refund", registrationId, eventId, settledSum });
    }
    if (refund && reg.paymentStatus === "PAID" && !nothingLeftToRefund) {
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
    // Own try/catch (review M2, July 8): the refund committed BEFORE this
    // transaction — a tx failure here must not surface as a generic UNKNOWN
    // 500 that hides the fact real money already moved.
    let claimed = false;
    try {
      claimed = await db.$transaction(async (tx) => {
        // Claim first so a concurrent cancel can't double-release the seat/promo.
        // RE-READ the seat-relevant fields INSIDE the transaction (review M2):
        // the pre-refund snapshot is seconds old by now — a concurrent type/tier
        // change during the CN + Stripe phase would make us release the WRONG
        // counter (double-release the old type, leak the new one).
        const fresh = await tx.registration.findUnique({
          where: { id: registrationId },
          select: { status: true, attendanceMode: true, ticketTypeId: true, pricingTierId: true, createdSource: true, promoCodeId: true },
        });
        if (!fresh || fresh.status === "CANCELLED") return false; // gone / already cancelled

        const claim = await tx.registration.updateMany({
          where: { id: registrationId, status: { not: "CANCELLED" } },
          data: { status: "CANCELLED" },
        });
        if (claim.count === 0) return false; // lost the race — someone else cancelled
        // Single source of truth for seat + promo release (shared with the REST PUT
        // + MCP update paths) — see src/services/README.md "THE RULE".
        await applyRegistrationTransition(tx, {
          prev: { status: fresh.status, attendanceMode: fresh.attendanceMode, ticketTypeId: fresh.ticketTypeId, pricingTierId: fresh.pricingTierId, createdSource: fresh.createdSource },
          next: { status: "CANCELLED", attendanceMode: fresh.attendanceMode, ticketTypeId: fresh.ticketTypeId, pricingTierId: fresh.pricingTierId, createdSource: fresh.createdSource },
          promoCodeId: fresh.promoCodeId,
          eventId,
        });
        return true;
      });
    } catch (cancelErr) {
      if (refunded) {
        apiLogger.error({ err: cancelErr, msg: "cancel:tx-failed-after-refund", registrationId, eventId, refundAmount: refundSummary?.amount ?? null });
        return {
          ok: false,
          code: "CANCEL_FAILED_AFTER_REFUND",
          message: "The refund completed, but cancelling the registration failed. Retry the cancel — the refund will not run twice.",
          meta: { refunded: true, refundAmount: refundSummary?.amount ?? null, currency: refundSummary?.currency ?? null },
        };
      }
      throw cancelErr; // no money moved — the outer catch maps it to UNKNOWN
    }

    // L3 (registrations review, July 10): the lost-race path used to fall
    // through to the audit write + success — recording a cancel this call
    // didn't perform. The outcome is still "cancelled" (idempotent), but only
    // the winner writes the audit row.
    if (!claimed) {
      apiLogger.warn({ msg: "cancel:lost-race — already cancelled by a concurrent caller", registrationId, eventId, source });
      return { ok: true, cancel: { status: "CANCELLED", refunded, refund: refundSummary } };
    }

    refreshEventStats(eventId);

    // Kill any still-open Stripe payment tab (review H2 sub-item). Fire-and-
    // forget — the helper never throws.
    void expireOpenCheckoutSessionOnCancel(registrationId, "cancel-service");

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
