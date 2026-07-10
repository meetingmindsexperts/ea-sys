/**
 * payment-service — refundRegistration + issueCreditNoteForRegistration.
 * Tests the result-union contract (codes) directly; the routes cover HTTP mapping.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, stripeRefundsCreate, verifyRefundSpy, createCreditNoteSpy, sendInvoiceEmailSpy, releaseSeatSpy, planSeatTransitionSpy, applyRegistrationTransitionSpy, CreditNoteAmountError } = vi.hoisted(() => {
  class CreditNoteAmountError extends Error {
    code: string;
    meta: Record<string, unknown>;
    constructor(code: string, message: string, meta: Record<string, unknown>) {
      super(message);
      this.code = code;
      this.meta = meta;
    }
  }
  return {
    mockDb: {
      registration: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
      invoice: { findFirst: vi.fn() },
      payment: { update: vi.fn() },
      promoCode: { update: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      refundAttempt: { create: vi.fn(), update: vi.fn() },
      $transaction: vi.fn(),
    },
    stripeRefundsCreate: vi.fn(),
    verifyRefundSpy: vi.fn(),
    createCreditNoteSpy: vi.fn(),
    sendInvoiceEmailSpy: vi.fn().mockResolvedValue(undefined),
    releaseSeatSpy: vi.fn().mockResolvedValue(undefined),
    planSeatTransitionSpy: vi.fn(),
    applyRegistrationTransitionSpy: vi.fn().mockResolvedValue(undefined),
    CreditNoteAmountError,
  };
});

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ refunds: { create: stripeRefundsCreate } }),
  toStripeAmount: (a: number) => Math.round(a * 100),
}));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn().mockReturnValue({ catch: () => {} }) }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/invoice-service", () => ({
  createCreditNote: createCreditNoteSpy,
  sendInvoiceEmail: sendInvoiceEmailSpy,
  CreditNoteAmountError,
}));
vi.mock("@/lib/registration-seat", () => ({ planSeatTransition: planSeatTransitionSpy }));
vi.mock("@/lib/registration-seat-db", () => ({ releaseSeat: releaseSeatSpy, applyRegistrationTransition: applyRegistrationTransitionSpy }));
// The inline Stripe verification (verify-before-rollback) is mocked so tests
// control the three outcomes: found / provably-absent / unverifiable.
vi.mock("@/lib/refund-reconciliation", () => ({ findStripeRefundForAttempt: verifyRefundSpy }));
// registration-financials is REAL (pure).

import { refundRegistration, issueCreditNoteForRegistration, cancelRegistration } from "@/services/payment-service";

function reg(payment: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  return {
    id: "reg1", serialId: 7, eventId: "ev1", paymentStatus: "PAID", refundedAmount: 0,
    originalPrice: 100, discountAmount: null,
    attendee: { firstName: "A", lastName: "B" },
    ticketType: { price: 100, currency: "USD" },
    pricingTier: null,
    event: { organizationId: "org1", taxRate: null, taxLabel: null },
    // Per-payment refunded counter defaults to 0 (as in the real schema).
    payments: payment ? [{ refundedAmount: 0, ...payment }] : [],
    ...extra,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.invoice.findFirst.mockResolvedValue({ id: "cn1" }); // credit note exists (gate open)
  mockDb.registration.updateMany.mockResolvedValue({ count: 1 });
  mockDb.registration.update.mockResolvedValue({});
  mockDb.payment.update.mockResolvedValue({});
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb.promoCode.update.mockResolvedValue({});
  stripeRefundsCreate.mockResolvedValue({ id: "re_1", status: "succeeded" });
  // Default verification outcome: Stripe reachable, refund provably absent
  // (the plain STRIPE_FAILED → rollback path).
  verifyRefundSpy.mockResolvedValue({ verified: true, found: false, refundId: null });
  mockDb.refundAttempt.create.mockResolvedValue({ id: "att1" });
  mockDb.refundAttempt.update.mockResolvedValue({});
  releaseSeatSpy.mockResolvedValue(undefined);
  planSeatTransitionSpy.mockReturnValue({ release: { kind: "ticketType", id: "tt1" }, claim: null });
  // $transaction routes to the shared top-level mocks so tests can control
  // the refund claim (registration.updateMany) and assert the attempt row.
  mockDb.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      // findUnique: the cancel tx re-reads seat fields INSIDE the transaction
      // (review M2) — route it to the shared mock (same row as the pre-read).
      registration: { updateMany: mockDb.registration.updateMany, findUnique: mockDb.registration.findUnique },
      refundAttempt: { create: mockDb.refundAttempt.create },
      promoCode: { update: mockDb.promoCode.update },
    }),
  );
});

describe("refundRegistration", () => {
  it("full manual refund → ok, recorded, fullyRefunded, writes audit", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: null, amount: 100, currency: "USD" }));
    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest", issuedByUserId: "u1" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.refund).toMatchObject({ manual: true, status: "recorded", amount: 100, refundedAmount: 100, fullyRefunded: true, refundId: null });
    // Per-payment counter bumped + flipped in one write.
    expect(mockDb.payment.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { refundedAmount: 100, status: "REFUNDED" } });
    await flush();
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "REFUND_ISSUED" }) }));
  });

  it("partial Stripe refund → keeps PAID, per-attempt idempotency key + metadata, audit PARTIAL_REFUND_ISSUED", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: "pi_1", amount: 100, currency: "USD" }));
    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", amount: 30, source: "rest" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.refund).toMatchObject({ manual: false, amount: 30, refundedAmount: 30, fullyRefunded: false, refundId: "re_1" });
    // Per-attempt key (H5: immune to the cumulative-total collision wedge) and
    // metadata ground truth for verification/reconciliation.
    expect(stripeRefundsCreate).toHaveBeenCalledWith(
      { payment_intent: "pi_1", amount: 3000, metadata: { refundAttemptId: "att1", registrationId: "reg1" } },
      { idempotencyKey: "refund-attempt-att1" },
    );
    expect(mockDb.refundAttempt.update).toHaveBeenCalledWith({ where: { id: "att1" }, data: { status: "SUCCEEDED", stripeRefundId: "re_1" } });
    // Per-payment counter bumped WITHOUT a status flip (payment not fully refunded).
    expect(mockDb.payment.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { refundedAmount: 30 } });
    await flush();
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "PARTIAL_REFUND_ISSUED" }) }));
  });

  it("persists the RefundAttempt BEFORE calling Stripe (H4 crash-safety ordering)", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: "pi_1", amount: 100, currency: "USD" }));
    await refundRegistration({ registrationId: "reg1", eventId: "ev1", amount: 30, source: "rest" });
    expect(mockDb.refundAttempt.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        registrationId: "reg1",
        stripePaymentIntentId: "pi_1",
        amount: 30,
        refundedBefore: 0,
        refundedAfter: 30,
        flippedToRefunded: false,
        kind: "stripe",
      }),
    }));
    const createOrder = mockDb.refundAttempt.create.mock.invocationCallOrder[0];
    const stripeOrder = stripeRefundsCreate.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(stripeOrder);
  });

  it("manual refund marks its attempt SUCCEEDED (kind manual, no Stripe call)", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: null, amount: 100, currency: "USD" }));
    await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" });
    expect(mockDb.refundAttempt.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: "manual", stripePaymentIntentId: null, flippedToRefunded: true }),
    }));
    expect(mockDb.refundAttempt.update).toHaveBeenCalledWith({ where: { id: "att1" }, data: { status: "SUCCEEDED" } });
    expect(stripeRefundsCreate).not.toHaveBeenCalled();
  });

  it("CREDIT_NOTE_REQUIRED when no credit note exists", async () => {
    mockDb.invoice.findFirst.mockResolvedValue(null);
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: "pi_1", amount: 100, currency: "USD" }));
    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "CREDIT_NOTE_REQUIRED" });
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });

  it("NOT_PAID for a non-paid registration", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg(null, { paymentStatus: "UNPAID" }));
    expect(await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" })).toMatchObject({ ok: false, code: "NOT_PAID" });
  });

  it("REGISTRATION_NOT_FOUND when missing / wrong event", async () => {
    mockDb.registration.findUnique.mockResolvedValue(null);
    expect(await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" })).toMatchObject({ ok: false, code: "REGISTRATION_NOT_FOUND" });
    mockDb.registration.findUnique.mockResolvedValue(reg(null, { eventId: "other" }));
    expect(await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" })).toMatchObject({ ok: false, code: "REGISTRATION_NOT_FOUND" });
  });

  it("INVALID_AMOUNT with meta when over the remaining balance", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: null, amount: 100, currency: "USD" }, { refundedAmount: 80 }));
    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", amount: 40, source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "INVALID_AMOUNT", meta: { remaining: 20, paidTotal: 100, refundedBefore: 80 } });
  });

  it("ALREADY_FULLY_REFUNDED when nothing remains", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: null, amount: 100, currency: "USD" }, { refundedAmount: 100 }));
    expect(await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" })).toMatchObject({ ok: false, code: "ALREADY_FULLY_REFUNDED" });
  });

  it("LOST_LOCK when the optimistic lock is lost", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: null, amount: 100, currency: "USD" }));
    mockDb.registration.updateMany.mockResolvedValue({ count: 0 });
    expect(await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" })).toMatchObject({ ok: false, code: "LOST_LOCK" });
  });

  it("STRIPE_FAILED: refund provably absent at Stripe → conditional rollback + attempt FAILED", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: "pi_1", amount: 100, currency: "USD" }));
    stripeRefundsCreate.mockRejectedValue(new Error("down"));
    // default verifyRefundSpy: { verified: true, found: false }
    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "STRIPE_FAILED" });
    // Rollback is a GUARDED DECREMENT of the un-executed portion (multi-slice
    // safe — sibling slices / webhook adjustments in the window are preserved).
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { id: "reg1", refundedAmount: { gte: 100 } },
      data: { refundedAmount: { decrement: 100 }, paymentStatus: "PAID" },
    });
    expect(mockDb.refundAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "att1" }, data: expect.objectContaining({ status: "FAILED" }) }),
    );
  });

  it("Stripe threw but the refund EXISTS (verified via metadata) → success, booking kept, no rollback (H5)", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: "pi_1", amount: 100, currency: "USD" }));
    stripeRefundsCreate.mockRejectedValue(new Error("ETIMEDOUT"));
    verifyRefundSpy.mockResolvedValue({ verified: true, found: true, refundId: "re_recovered" });

    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", amount: 50, source: "rest" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.refund).toMatchObject({ refundId: "re_recovered", status: "succeeded", amount: 50 });
    expect(mockDb.refundAttempt.update).toHaveBeenCalledWith({ where: { id: "att1" }, data: { status: "SUCCEEDED", stripeRefundId: "re_recovered" } });
    // No rollback write: the only updateMany is the claim itself.
    const rollbackCalls = mockDb.registration.updateMany.mock.calls.filter((call) => {
      const where = (call[0] as { where?: Record<string, unknown> } | undefined)?.where;
      return !!where && "refundedAmount" in where && !("paymentStatus" in where);
    });
    expect(rollbackCalls).toHaveLength(0);
  });

  it("REFUND_STATE_UNKNOWN when Stripe AND verification are unreachable → booking kept, attempt UNKNOWN (sweep resolves)", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: "pi_1", amount: 100, currency: "USD" }));
    stripeRefundsCreate.mockRejectedValue(new Error("network down"));
    verifyRefundSpy.mockResolvedValue({ verified: false });

    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "REFUND_STATE_UNKNOWN" });
    expect(mockDb.refundAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "att1" }, data: expect.objectContaining({ status: "UNKNOWN" }) }),
    );
    // Booking kept: only the claim ran, no rollback shape.
    expect(mockDb.registration.updateMany).toHaveBeenCalledTimes(1);
  });

  // ── Phase 4: multi-payment allocation (H6) ────────────────────────────────

  it("mixed Stripe+manual full refund → Stripe slice capped at its charge, manual remainder recorded, both counters bumped", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg(null, {
      payments: [
        { id: "pStripe", stripePaymentId: "pi_1", amount: 100, currency: "USD", refundedAmount: 0 },
        { id: "pManual", stripePaymentId: null, amount: 50, currency: "USD", refundedAmount: 0 },
      ],
    }));
    mockDb.refundAttempt.create
      .mockResolvedValueOnce({ id: "attS" })
      .mockResolvedValueOnce({ id: "attM" });

    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.refund).toMatchObject({ amount: 150, paidTotal: 150, refundedAmount: 150, fullyRefunded: true, manual: false });
      expect(r.refund.slices).toEqual([
        { paymentId: "pStripe", kind: "stripe", amount: 100, stripeRefundId: "re_1" },
        { paymentId: "pManual", kind: "manual", amount: 50, stripeRefundId: null },
      ]);
    }
    // Stripe called ONLY for the Stripe charge, capped at its amount — the old
    // payments[0] pick would have either buried the Stripe charge in a
    // "manual" refund or asked Stripe for $150 against a $100 intent.
    expect(stripeRefundsCreate).toHaveBeenCalledTimes(1);
    expect(stripeRefundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_1", amount: 10000 }),
      { idempotencyKey: "refund-attempt-attS" },
    );
    // Both per-payment counters bumped + flipped (each fully refunded).
    expect(mockDb.payment.update).toHaveBeenCalledWith({ where: { id: "pStripe" }, data: { refundedAmount: 100, status: "REFUNDED" } });
    expect(mockDb.payment.update).toHaveBeenCalledWith({ where: { id: "pManual" }, data: { refundedAmount: 50, status: "REFUNDED" } });
  });

  it("two Stripe charges → the refund spans both, each slice capped and separately keyed", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg(null, {
      payments: [
        { id: "pA", stripePaymentId: "pi_A", amount: 100, currency: "USD", refundedAmount: 0 },
        { id: "pB", stripePaymentId: "pi_B", amount: 50, currency: "USD", refundedAmount: 0 },
      ],
    }));
    mockDb.refundAttempt.create
      .mockResolvedValueOnce({ id: "attA" })
      .mockResolvedValueOnce({ id: "attB" });
    stripeRefundsCreate
      .mockResolvedValueOnce({ id: "re_A" })
      .mockResolvedValueOnce({ id: "re_B" });

    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", amount: 120, source: "rest" });
    expect(r.ok).toBe(true);
    expect(stripeRefundsCreate).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ payment_intent: "pi_A", amount: 10000 }),
      { idempotencyKey: "refund-attempt-attA" });
    expect(stripeRefundsCreate).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ payment_intent: "pi_B", amount: 2000 }),
      { idempotencyKey: "refund-attempt-attB" });
    if (r.ok) {
      expect(r.refund.slices).toEqual([
        { paymentId: "pA", kind: "stripe", amount: 100, stripeRefundId: "re_A" },
        { paymentId: "pB", kind: "stripe", amount: 20, stripeRefundId: "re_B" },
      ]);
    }
  });

  it("REFUND_PARTIALLY_COMPLETED when a later slice fails — completed slices kept, remainder un-booked by decrement", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg(null, {
      payments: [
        { id: "pA", stripePaymentId: "pi_A", amount: 100, currency: "USD", refundedAmount: 0 },
        { id: "pB", stripePaymentId: "pi_B", amount: 50, currency: "USD", refundedAmount: 0 },
      ],
    }));
    mockDb.refundAttempt.create
      .mockResolvedValueOnce({ id: "attA" })
      .mockResolvedValueOnce({ id: "attB" });
    stripeRefundsCreate
      .mockResolvedValueOnce({ id: "re_A" })
      .mockRejectedValueOnce(new Error("declined"));
    // Verification: slice B provably absent.
    verifyRefundSpy.mockResolvedValue({ verified: true, found: false, refundId: null });

    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" }); // full 150
    expect(r).toMatchObject({
      ok: false,
      code: "REFUND_PARTIALLY_COMPLETED",
      meta: expect.objectContaining({ refundedThisCall: 100, failedAmount: 50 }),
    });
    // The failed remainder (50) is released via guarded decrement; the booking
    // had flipped REFUNDED (full amount) so the reg goes back to PAID.
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { id: "reg1", refundedAmount: { gte: 50 } },
      data: { refundedAmount: { decrement: 50 }, paymentStatus: "PAID" },
    });
    // Slice A's money stays on the books.
    expect(mockDb.payment.update).toHaveBeenCalledWith({ where: { id: "pA" }, data: { refundedAmount: 100, status: "REFUNDED" } });
    expect(mockDb.refundAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "attB" }, data: expect.objectContaining({ status: "FAILED" }) }),
    );
  });

  it("REFUND_STATE_UNKNOWN when the rollback loses its race (state moved on) → attempt UNKNOWN", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: "pi_1", amount: 100, currency: "USD" }));
    stripeRefundsCreate.mockRejectedValue(new Error("declined"));
    // Claim wins, rollback loses.
    mockDb.registration.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "REFUND_STATE_UNKNOWN" });
    expect(mockDb.refundAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "att1" }, data: expect.objectContaining({ status: "UNKNOWN" }) }),
    );
  });
});

describe("issueCreditNoteForRegistration", () => {
  beforeEach(() => {
    mockDb.registration.findUnique.mockResolvedValue({ id: "reg1", eventId: "ev1", paymentStatus: "PAID" });
    createCreditNoteSpy.mockResolvedValue({
      invoice: { id: "cn1", invoiceNumber: "MM-CN-001", total: 105, currency: "USD" },
      created: true, creditedAfter: 105, paidTotal: 105,
    });
  });

  it("issues a credit note → ok summary + audit", async () => {
    const r = await issueCreditNoteForRegistration({ registrationId: "reg1", eventId: "ev1", organizationId: "org1", source: "rest", issuedByUserId: "u1" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.creditNote).toMatchObject({ creditNoteId: "cn1", amount: 105, creditedAfter: 105, emailed: false });
    expect(sendInvoiceEmailSpy).not.toHaveBeenCalled();
    await flush();
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "CREDIT_NOTE_ISSUED" }) }));
  });

  it("emails the credit note when send=true", async () => {
    const r = await issueCreditNoteForRegistration({ registrationId: "reg1", eventId: "ev1", organizationId: "org1", send: true, source: "rest" });
    expect(r.ok && r.creditNote.emailed).toBe(true);
    expect(sendInvoiceEmailSpy).toHaveBeenCalledWith("cn1");
  });

  it("maps CreditNoteAmountError → CREDIT_LIMIT_EXCEEDED with meta", async () => {
    createCreditNoteSpy.mockRejectedValue(new CreditNoteAmountError("CREDIT_LIMIT_EXCEEDED", "over", { outstanding: 5 }));
    const r = await issueCreditNoteForRegistration({ registrationId: "reg1", eventId: "ev1", organizationId: "org1", amount: 50, source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "CREDIT_LIMIT_EXCEEDED", meta: { outstanding: 5 } });
  });

  it("NOT_PAID when the registration isn't paid", async () => {
    mockDb.registration.findUnique.mockResolvedValue({ id: "reg1", eventId: "ev1", paymentStatus: "UNPAID" });
    expect(await issueCreditNoteForRegistration({ registrationId: "reg1", eventId: "ev1", organizationId: "org1", source: "rest" })).toMatchObject({ ok: false, code: "NOT_PAID" });
    expect(createCreditNoteSpy).not.toHaveBeenCalled();
  });

  it("REGISTRATION_NOT_FOUND when missing", async () => {
    mockDb.registration.findUnique.mockResolvedValue(null);
    expect(await issueCreditNoteForRegistration({ registrationId: "reg1", eventId: "ev1", organizationId: "org1", source: "rest" })).toMatchObject({ ok: false, code: "REGISTRATION_NOT_FOUND" });
  });
});

describe("cancelRegistration", () => {
  function cancelReg(extra: Record<string, unknown> = {}) {
    return {
      id: "reg1", serialId: 7, eventId: "ev1", status: "CONFIRMED", paymentStatus: "PAID",
      attendanceMode: "IN_PERSON", ticketTypeId: "tt1", pricingTierId: null, createdSource: null, promoCodeId: null,
      refundedAmount: 0, originalPrice: 100, discountAmount: null,
      attendee: { firstName: "A", lastName: "B" }, ticketType: { price: 100, currency: "USD" }, pricingTier: null,
      event: { organizationId: "org1", taxRate: null, taxLabel: null },
      payments: [{ id: "p1", stripePaymentId: null, amount: 100, currency: "USD" }],
      ...extra,
    };
  }

  beforeEach(() => {
    createCreditNoteSpy.mockResolvedValue({
      invoice: { id: "cn1", invoiceNumber: "MM-CN-001", total: 100, currency: "USD" },
      created: true, creditedAfter: 100, paidTotal: 100,
    });
  });

  it("paid cancel with refund → issues CN, refunds full, cancels, releases seat", async () => {
    mockDb.registration.findUnique.mockResolvedValue(cancelReg());
    const r = await cancelRegistration({ registrationId: "reg1", eventId: "ev1", organizationId: "org1", refund: true, source: "rest" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cancel.refunded).toBe(true);
      expect(r.cancel.refund).toMatchObject({ amount: 100, fullyRefunded: true });
    }
    expect(createCreditNoteSpy).toHaveBeenCalled();
    expect(applyRegistrationTransitionSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ next: expect.objectContaining({ status: "CANCELLED" }) }));
    expect(mockDb.$transaction).toHaveBeenCalled();
  });

  it("unpaid cancel → cancels, no refund (no credit note)", async () => {
    mockDb.registration.findUnique.mockResolvedValue(cancelReg({ paymentStatus: "UNPAID", payments: [] }));
    const r = await cancelRegistration({ registrationId: "reg1", eventId: "ev1", organizationId: "org1", refund: true, source: "rest" });
    expect(r).toMatchObject({ ok: true, cancel: { refunded: false } });
    expect(createCreditNoteSpy).not.toHaveBeenCalled();
    expect(stripeRefundsCreate).not.toHaveBeenCalled();
    expect(applyRegistrationTransitionSpy).toHaveBeenCalled();
  });

  it("refund:false on a paid reg → just cancels, no refund", async () => {
    mockDb.registration.findUnique.mockResolvedValue(cancelReg());
    const r = await cancelRegistration({ registrationId: "reg1", eventId: "ev1", organizationId: "org1", refund: false, source: "rest" });
    expect(r).toMatchObject({ ok: true, cancel: { refunded: false } });
    expect(createCreditNoteSpy).not.toHaveBeenCalled();
  });

  it("passes the promo code to the shared transition applier on cancel", async () => {
    mockDb.registration.findUnique.mockResolvedValue(cancelReg({ paymentStatus: "UNPAID", payments: [], promoCodeId: "promo1" }));
    await cancelRegistration({ registrationId: "reg1", eventId: "ev1", organizationId: "org1", refund: false, source: "rest" });
    expect(applyRegistrationTransitionSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ promoCodeId: "promo1", next: expect.objectContaining({ status: "CANCELLED" }) }),
    );
  });

  it("ALREADY_CANCELLED when the reg is already cancelled", async () => {
    mockDb.registration.findUnique.mockResolvedValue(cancelReg({ status: "CANCELLED" }));
    const r = await cancelRegistration({ registrationId: "reg1", eventId: "ev1", organizationId: "org1", refund: true, source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "ALREADY_CANCELLED" });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("REGISTRATION_NOT_FOUND when missing", async () => {
    mockDb.registration.findUnique.mockResolvedValue(null);
    expect(await cancelRegistration({ registrationId: "reg1", eventId: "ev1", organizationId: "org1", refund: true, source: "rest" })).toMatchObject({ ok: false, code: "REGISTRATION_NOT_FOUND" });
  });

  it("a refund failure ABORTS the cancel (reg not cancelled)", async () => {
    mockDb.registration.findUnique.mockResolvedValue(cancelReg({ payments: [{ id: "p1", stripePaymentId: "pi_1", amount: 100, currency: "USD" }] }));
    stripeRefundsCreate.mockRejectedValue(new Error("stripe down"));
    const r = await cancelRegistration({ registrationId: "reg1", eventId: "ev1", organizationId: "org1", refund: true, source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "REFUND_FAILED", meta: { step: "refund" } });
    // Never cancelled: the refund's own claim tx ran, but the cancel
    // transition was never applied.
    expect(applyRegistrationTransitionSpy).not.toHaveBeenCalled();
  });

  it("an already-fully-refunded paid reg is cancelled without a second refund", async () => {
    // remaining 0 → refundRegistration returns ALREADY_FULLY_REFUNDED, cancel proceeds.
    mockDb.registration.findUnique.mockResolvedValue(cancelReg({ refundedAmount: 100 }));
    const r = await cancelRegistration({ registrationId: "reg1", eventId: "ev1", organizationId: "org1", refund: true, source: "rest" });
    expect(r).toMatchObject({ ok: true, cancel: { refunded: false } });
    expect(mockDb.$transaction).toHaveBeenCalled(); // still cancelled
  });
});
