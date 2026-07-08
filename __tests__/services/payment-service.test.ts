/**
 * payment-service — refundRegistration + issueCreditNoteForRegistration.
 * Tests the result-union contract (codes) directly; the routes cover HTTP mapping.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, stripeRefundsCreate, createCreditNoteSpy, sendInvoiceEmailSpy, releaseSeatSpy, planSeatTransitionSpy, CreditNoteAmountError } = vi.hoisted(() => {
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
      $transaction: vi.fn(),
    },
    stripeRefundsCreate: vi.fn(),
    createCreditNoteSpy: vi.fn(),
    sendInvoiceEmailSpy: vi.fn().mockResolvedValue(undefined),
    releaseSeatSpy: vi.fn().mockResolvedValue(undefined),
    planSeatTransitionSpy: vi.fn(),
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
vi.mock("@/lib/registration-seat-db", () => ({ releaseSeat: releaseSeatSpy }));
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
    payments: payment ? [payment] : [],
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
  releaseSeatSpy.mockResolvedValue(undefined);
  planSeatTransitionSpy.mockReturnValue({ release: { kind: "ticketType", id: "tt1" }, claim: null });
  // $transaction runs the callback with a tx that claims the status + releases.
  mockDb.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      registration: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
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
    expect(mockDb.payment.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { status: "REFUNDED" } });
    await flush();
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "REFUND_ISSUED" }) }));
  });

  it("partial Stripe refund → keeps PAID, partial amount to Stripe, audit PARTIAL_REFUND_ISSUED", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: "pi_1", amount: 100, currency: "USD" }));
    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", amount: 30, source: "rest" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.refund).toMatchObject({ manual: false, amount: 30, refundedAmount: 30, fullyRefunded: false, refundId: "re_1" });
    expect(stripeRefundsCreate).toHaveBeenCalledWith({ payment_intent: "pi_1", amount: 3000 }, { idempotencyKey: "refund-p1-30.00" });
    expect(mockDb.payment.update).not.toHaveBeenCalled();
    await flush();
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "PARTIAL_REFUND_ISSUED" }) }));
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

  it("STRIPE_FAILED rolls back and returns the code", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: "pi_1", amount: 100, currency: "USD" }));
    stripeRefundsCreate.mockRejectedValue(new Error("down"));
    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "STRIPE_FAILED" });
    expect(mockDb.registration.update).toHaveBeenCalledWith({ where: { id: "reg1" }, data: { refundedAmount: 0, paymentStatus: "PAID" } });
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
    expect(releaseSeatSpy).toHaveBeenCalledWith(expect.anything(), { kind: "ticketType", id: "tt1" });
    expect(mockDb.$transaction).toHaveBeenCalled();
  });

  it("unpaid cancel → cancels, no refund (no credit note)", async () => {
    mockDb.registration.findUnique.mockResolvedValue(cancelReg({ paymentStatus: "UNPAID", payments: [] }));
    const r = await cancelRegistration({ registrationId: "reg1", eventId: "ev1", organizationId: "org1", refund: true, source: "rest" });
    expect(r).toMatchObject({ ok: true, cancel: { refunded: false } });
    expect(createCreditNoteSpy).not.toHaveBeenCalled();
    expect(stripeRefundsCreate).not.toHaveBeenCalled();
    expect(releaseSeatSpy).toHaveBeenCalled();
  });

  it("refund:false on a paid reg → just cancels, no refund", async () => {
    mockDb.registration.findUnique.mockResolvedValue(cancelReg());
    const r = await cancelRegistration({ registrationId: "reg1", eventId: "ev1", organizationId: "org1", refund: false, source: "rest" });
    expect(r).toMatchObject({ ok: true, cancel: { refunded: false } });
    expect(createCreditNoteSpy).not.toHaveBeenCalled();
  });

  it("releases the promo code usage on cancel", async () => {
    mockDb.registration.findUnique.mockResolvedValue(cancelReg({ paymentStatus: "UNPAID", payments: [], promoCodeId: "promo1" }));
    await cancelRegistration({ registrationId: "reg1", eventId: "ev1", organizationId: "org1", refund: false, source: "rest" });
    expect(mockDb.promoCode.update).toHaveBeenCalledWith({ where: { id: "promo1" }, data: { usedCount: { decrement: 1 } } });
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
    expect(mockDb.$transaction).not.toHaveBeenCalled(); // never cancelled
  });

  it("an already-fully-refunded paid reg is cancelled without a second refund", async () => {
    // remaining 0 → refundRegistration returns ALREADY_FULLY_REFUNDED, cancel proceeds.
    mockDb.registration.findUnique.mockResolvedValue(cancelReg({ refundedAmount: 100 }));
    const r = await cancelRegistration({ registrationId: "reg1", eventId: "ev1", organizationId: "org1", refund: true, source: "rest" });
    expect(r).toMatchObject({ ok: true, cancel: { refunded: false } });
    expect(mockDb.$transaction).toHaveBeenCalled(); // still cancelled
  });
});
