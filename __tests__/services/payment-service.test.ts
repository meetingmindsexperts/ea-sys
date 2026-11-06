/**
 * payment-service — refundRegistration + issueCreditNoteForRegistration.
 * Tests the result-union contract (codes) directly; the routes cover HTTP mapping.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
// Row locks are Postgres FOR UPDATE; a mocked transaction cannot take them.
// Pinned against the real database in
// tests/integration-db/registration-row-lock.db.test.ts.
const { mockLockRegistrationRows } = vi.hoisted(() => ({ mockLockRegistrationRows: vi.fn(async () => undefined) }));
vi.mock("@/lib/registration-row-lock", () => ({
  lockRegistrationRows: mockLockRegistrationRows,
  lockRegistrationIfUnchanged: vi.fn(async () => "unchanged"),
}));

const { mockDb, stripeRefundsCreate, verifyRefundSpy, unbookSpy, UnbookRaced, UnbookNeedsReview, createCreditNoteSpy, sendInvoiceEmailSpy, releaseSeatSpy, planSeatTransitionSpy, applyRegistrationTransitionSpy, CreditNoteAmountError } = vi.hoisted(() => {
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
      invoice: { findFirst: vi.fn(), findMany: vi.fn() },
      payment: { update: vi.fn(), updateMany: vi.fn() },
      promoCode: { update: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      refundAttempt: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
      $transaction: vi.fn(),
    },
    stripeRefundsCreate: vi.fn(),
    verifyRefundSpy: vi.fn(),
    unbookSpy: vi.fn(),
    UnbookRaced: class UnbookRaced extends Error {},
    UnbookNeedsReview: class UnbookNeedsReview extends Error {},
    createCreditNoteSpy: vi.fn(),
    sendInvoiceEmailSpy: vi.fn().mockResolvedValue(undefined),
    releaseSeatSpy: vi.fn().mockResolvedValue(undefined),
    planSeatTransitionSpy: vi.fn(),
    applyRegistrationTransitionSpy: vi.fn().mockResolvedValue(undefined),
    CreditNoteAmountError,
  };
});

vi.mock("@/lib/db", () => ({
  db: mockDb,
  // tenantTransaction with the flag off IS db.$transaction — delegate so the
  // test's tx interception keeps working for the migrated sites.
  tenantTransaction: (fn: (tx: unknown) => unknown) => mockDb.$transaction(fn),
}));
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
vi.mock("@/lib/stripe-refund-lookup", () => ({ findStripeRefundForAttempt: verifyRefundSpy }));
// The rollback itself (the arithmetic, Stripe's figure, all-or-nothing) is
// pinned in __tests__/services/refund-unbook.test.ts and on real Postgres in
// tests/integration-db/refund-counters.db.test.ts. Here: what the service hands
// it, and what it does with each outcome.
vi.mock("@/services/refund-unbook", () => ({ unbookRefund: unbookSpy, UnbookRaced, UnbookNeedsReview }));
// H2 sub-item: cancel expires any still-open checkout session (post-commit,
// fire-and-forget). Mocked so the service tests can assert the call.
const expireSessionSpy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/checkout-session-cleanup", () => ({ expireOpenCheckoutSessionOnCancel: expireSessionSpy }));
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
  // Amount gate default: ample credit so existing scenarios stay gate-open.
  mockDb.invoice.findMany.mockResolvedValue([{ total: 100000 }]);
  mockDb.registration.updateMany.mockResolvedValue({ count: 1 });
  mockDb.registration.update.mockResolvedValue({});
  mockDb.payment.update.mockResolvedValue({});
  mockDb.payment.updateMany.mockResolvedValue({ count: 1 });
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb.promoCode.update.mockResolvedValue({});
  stripeRefundsCreate.mockResolvedValue({ id: "re_1", status: "succeeded" });
  // Default verification outcome: Stripe reachable, refund provably absent
  // (the plain STRIPE_FAILED → rollback path).
  verifyRefundSpy.mockResolvedValue({ verified: true, found: false, refundId: null, refundedTotal: 0, attemptIds: [] });
  unbookSpy.mockImplementation(async (_tx: unknown, args: { slices: Array<{ take: number }> }) => ({
    unbooked: args.slices.reduce((s, x) => s + x.take, 0),
    absorbed: [],
    registrationRefunded: 0,
  }));
  mockDb.refundAttempt.create.mockResolvedValue({ id: "att1" });
  mockDb.refundAttempt.update.mockResolvedValue({});
  // Status writes are guarded (only from PENDING/UNKNOWN), and each Stripe
  // slice is claimed before it is sent; both are updateMany.
  mockDb.refundAttempt.updateMany.mockResolvedValue({ count: 1 });
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
      payment: { updateMany: mockDb.payment.updateMany },
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
    // Per-payment counter booked + flipped in the claim, optimistic on the read value.
    expect(mockDb.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "p1", refundedAmount: 0 },
      data: { refundedAmount: { increment: 100 }, status: "REFUNDED" },
    });
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
    expect(mockDb.refundAttempt.updateMany).toHaveBeenCalledWith({ where: { id: "att1", status: "PENDING" }, data: { status: "SUCCEEDED", stripeRefundId: "re_1" } });
    // Per-payment counter booked WITHOUT a status flip (payment not fully refunded).
    expect(mockDb.payment.updateMany).toHaveBeenCalledWith({ where: { id: "p1", refundedAmount: 0 }, data: { refundedAmount: { increment: 30 } } });
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
    expect(mockDb.refundAttempt.updateMany).toHaveBeenCalledWith({ where: { id: "att1", status: "PENDING" }, data: { status: "SUCCEEDED" } });
    expect(stripeRefundsCreate).not.toHaveBeenCalled();
  });

  it("CREDIT_NOTE_REQUIRED when no credit note exists", async () => {
    mockDb.invoice.findMany.mockResolvedValue([]);
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: "pi_1", amount: 100, currency: "USD" }));
    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "CREDIT_NOTE_REQUIRED" });
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });

  it("CREDIT_NOTE_INSUFFICIENT when the refund would exceed the credited total (July 7 M2, closed July 11)", async () => {
    // A $1 credit note must NOT unlock a $100 refund.
    mockDb.invoice.findMany.mockResolvedValue([{ total: 1 }]);
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: "pi_1", amount: 100, currency: "USD" }));
    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" });
    expect(r).toMatchObject({
      ok: false,
      code: "CREDIT_NOTE_INSUFFICIENT",
      meta: { creditedTotal: 1, refundedBefore: 0, requested: 100, maxRefundable: 1 },
    });
    // Nothing booked, no Stripe call.
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
    expect(stripeRefundsCreate).not.toHaveBeenCalled();
  });

  it("credit gate is CUMULATIVE: prior refunds count against the credited total", async () => {
    // Credited 50, already refunded 30 → only 20 more refundable.
    mockDb.invoice.findMany.mockResolvedValue([{ total: 30 }, { total: 20 }]);
    mockDb.registration.findUnique.mockResolvedValue(
      reg({ id: "p1", stripePaymentId: "pi_1", amount: 100, currency: "USD" }, { refundedAmount: 30 }),
    );
    const blocked = await refundRegistration({ registrationId: "reg1", eventId: "ev1", amount: 25, source: "rest" });
    expect(blocked).toMatchObject({ ok: false, code: "CREDIT_NOTE_INSUFFICIENT", meta: { maxRefundable: 20 } });

    const allowed = await refundRegistration({ registrationId: "reg1", eventId: "ev1", amount: 20, source: "rest" });
    expect(allowed.ok).toBe(true);
  });

  it("a fully-credited registration refunds in full (gate exactly at the boundary)", async () => {
    mockDb.invoice.findMany.mockResolvedValue([{ total: 100 }]);
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: null, amount: 100, currency: "USD" }));
    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.refund.fullyRefunded).toBe(true);
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
    // The shared rollback gets the slice and Stripe's own figure for its intent.
    expect(unbookSpy).toHaveBeenCalledWith(expect.anything(), {
      registrationId: "reg1",
      slices: [{ attemptId: "att1", paymentId: "p1", take: 100, paymentBooked: true, stripe: { refundedTotal: 0, attemptIds: [] }, failureNote: "down" }],
      flippedToRefunded: true,
    });
    // The rollback marks the attempt FAILED itself, in its transaction; the
    // service writes nothing more for it.
    expect(mockDb.refundAttempt.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
  });

  it("Stripe threw but the refund EXISTS (verified via metadata) → success, booking kept, no rollback (H5)", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: "pi_1", amount: 100, currency: "USD" }));
    stripeRefundsCreate.mockRejectedValue(new Error("ETIMEDOUT"));
    verifyRefundSpy.mockResolvedValue({ verified: true, found: true, refundId: "re_recovered", refundedTotal: 50, attemptIds: ["att1"] });

    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", amount: 50, source: "rest" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.refund).toMatchObject({ refundId: "re_recovered", status: "succeeded", amount: 50 });
    expect(mockDb.refundAttempt.updateMany).toHaveBeenCalledWith({ where: { id: "att1", status: "PENDING" }, data: { status: "SUCCEEDED", stripeRefundId: "re_recovered" } });
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
    expect(mockDb.refundAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "att1", status: { in: ["PENDING", "UNKNOWN"] } }, data: expect.objectContaining({ status: "UNKNOWN" }) }),
    );
    // Booking kept: only the claim ran, no rollback shape.
    expect(mockDb.registration.updateMany).toHaveBeenCalledTimes(1);
  });

  // ── W0-1 (security audit, Nov 6 2026): the payment counter is booked first ──
  // charge.refunded decides "already counted" from Payment.refundedAmount alone.
  // These pin that the counter moves with the claim, before Stripe, and never
  // after it, so the webhook for our own refund can only ever read delta 0.

  it("books the payment counter inside the claim, BEFORE Stripe, and never writes it after", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: "pi_1", amount: 100, currency: "USD" }));
    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", amount: 30, source: "rest" });
    expect(r.ok).toBe(true);
    expect(mockDb.payment.updateMany).toHaveBeenCalledTimes(1);
    expect(mockDb.payment.updateMany.mock.invocationCallOrder[0]).toBeLessThan(stripeRefundsCreate.mock.invocationCallOrder[0]);
    // The old post-Stripe absolute write (the double-count window) is gone.
    expect(mockDb.payment.update).not.toHaveBeenCalled();
  });

  it("a webhook arriving between Stripe's success and the old counter write has nothing to re-book", async () => {
    // Simulates the race: by the time Stripe returns, the counter must already
    // hold this refund. Read it at the moment Stripe is called.
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: "pi_1", amount: 500, currency: "USD" }));
    let bookedWhenStripeCalled = 0;
    stripeRefundsCreate.mockImplementation(async () => {
      bookedWhenStripeCalled = mockDb.payment.updateMany.mock.calls
        .map((c) => (c[0] as { data: { refundedAmount: { increment?: number } } }).data.refundedAmount.increment ?? 0)
        .reduce((a, b) => a + b, 0);
      return { id: "re_1" };
    });
    await refundRegistration({ registrationId: "reg1", eventId: "ev1", amount: 100, source: "rest" });
    expect(bookedWhenStripeCalled).toBe(100);
  });

  it("a Stripe Dashboard refund that moved the payment counter since the read → LOST_LOCK, no Stripe call, no attempt rows", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: "pi_1", amount: 100, currency: "USD" }));
    mockDb.payment.updateMany.mockResolvedValue({ count: 0 });
    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", amount: 30, source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "LOST_LOCK" });
    expect(stripeRefundsCreate).not.toHaveBeenCalled();
    // The throw aborted the transaction before the attempts were written, and
    // took the registration claim with it (a return would have committed it).
    expect(mockDb.refundAttempt.create).not.toHaveBeenCalled();
  });

  it("the rollback refuses (needs review) → nothing un-booked, attempt UNKNOWN for the sweep", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: "pi_1", amount: 100, currency: "USD" }));
    stripeRefundsCreate.mockRejectedValue(new Error("declined"));
    // The rollback refuses: the books hold more than Stripe explains.
    unbookSpy.mockRejectedValue(new UnbookNeedsReview("counter above Stripe"));
    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "REFUND_STATE_UNKNOWN" });
    expect(mockDb.refundAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "att1", status: { in: ["PENDING", "UNKNOWN"] } }, data: expect.objectContaining({ status: "UNKNOWN" }) }),
    );
  });

  // ── W0-1 follow-up (Nov 6 2026): review MED-1 / MED-2 / LOW-3 ─────────────

  const threePayments = () => reg(null, {
    payments: [
      { id: "pA", stripePaymentId: "pi_A", amount: 100, currency: "USD", refundedAmount: 0 },
      { id: "pB", stripePaymentId: "pi_B", amount: 50, currency: "USD", refundedAmount: 0 },
      { id: "pM", stripePaymentId: null, amount: 30, currency: "USD", refundedAmount: 0 },
    ],
  });
  const threeAttempts = () => mockDb.refundAttempt.create
    .mockResolvedValueOnce({ id: "attA" })
    .mockResolvedValueOnce({ id: "attB" })
    .mockResolvedValueOnce({ id: "attM" });
  /** Status writes the SERVICE made (claims carry no status; rollback marks happen inside the mocked rollback). */
  const statusOf = (id: string) =>
    mockDb.refundAttempt.updateMany.mock.calls
      .filter((c) => (c[0] as { where: { id: string } }).where.id === id)
      .map((c) => (c[0] as { data: { status?: string } }).data.status)
      .filter(Boolean);
  const rolledBackIds = () =>
    unbookSpy.mock.calls.flatMap((c) => (c[1] as { slices: Array<{ attemptId: string }> }).slices.map((x) => x.attemptId));

  it("one attempt per payment plus one for residue; each with a payment is marked paymentBooked", async () => {
    // 150 paid across a Stripe and a manual payment, refunding the full 150.
    mockDb.registration.findUnique.mockResolvedValue(reg(null, {
      payments: [
        { id: "pS", stripePaymentId: "pi_S", amount: 100, currency: "USD", refundedAmount: 0 },
        { id: "pM", stripePaymentId: null, amount: 50, currency: "USD", refundedAmount: 0 },
      ],
    }));
    await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" });
    const rows = mockDb.refundAttempt.create.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
    expect(rows.map((d) => [d.kind, d.paymentId, d.amount, d.paymentBooked])).toEqual([
      ["stripe", "pS", 100, true],
      ["manual", "pM", 50, true],
    ]);
  });

  it("every attempt of one refund carries the same bookingId, and a new refund gets a new one", async () => {
    mockDb.registration.findUnique.mockResolvedValue(threePayments());
    threeAttempts();
    await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" });
    const ids = mockDb.refundAttempt.create.mock.calls.map((c) => (c[0] as { data: { bookingId: string } }).data.bookingId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    mockDb.refundAttempt.create.mockClear();
    await refundRegistration({ registrationId: "reg1", eventId: "ev1", amount: 10, source: "rest" });
    const next = (mockDb.refundAttempt.create.mock.calls[0][0] as { data: { bookingId: string } }).data.bookingId;
    expect(next).not.toBe(ids[0]);
  });

  it("unattributed residue (PAID, no payment rows) gets its own attempt with no payment and paymentBooked false", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg(null));
    await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" });
    expect(mockDb.refundAttempt.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: "manual", paymentId: null, amount: 100, paymentBooked: false }),
    }));
    expect(mockDb.payment.updateMany).not.toHaveBeenCalled();
  });

  it("MED-2: a rollback that cannot apply leaves EVERY remaining attempt UNKNOWN (the sweep takes each back)", async () => {
    mockDb.registration.findUnique.mockResolvedValue(threePayments());
    threeAttempts();
    stripeRefundsCreate.mockResolvedValueOnce({ id: "re_A" }).mockRejectedValueOnce(new Error("declined"));
    unbookSpy.mockRejectedValue(new UnbookRaced("moved"));

    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "REFUND_STATE_UNKNOWN" });
    expect(statusOf("attA")).toEqual(["SUCCEEDED"]);
    expect(statusOf("attB")).toEqual(["UNKNOWN"]);
    // It used to be marked FAILED "booking rolled back" while its counters stayed up.
    expect(statusOf("attM")).toEqual(["UNKNOWN"]);
  });

  it("keptUnknown: the unconfirmed slice stays booked; later Stripe slices are checked with Stripe and handed over with the manual one", async () => {
    mockDb.registration.findUnique.mockResolvedValue(threePayments());
    threeAttempts();
    stripeRefundsCreate.mockRejectedValueOnce(new Error("ETIMEDOUT"));
    verifyRefundSpy
      .mockResolvedValueOnce({ verified: false }) // slice A: cannot confirm, kept UNKNOWN
      .mockResolvedValueOnce({ verified: true, found: false, refundId: null, refundedTotal: 10, attemptIds: [] }); // slice B: never sent

    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "REFUND_STATE_UNKNOWN" });
    expect(verifyRefundSpy).toHaveBeenNthCalledWith(2, "pi_B", "attB", "org1");
    expect(unbookSpy).toHaveBeenCalledTimes(1);
    expect(unbookSpy.mock.calls[0][1].slices).toEqual([
      { attemptId: "attB", paymentId: "pB", take: 50, paymentBooked: true, stripe: { refundedTotal: 10, attemptIds: [] }, failureNote: expect.stringContaining("earlier refund slice failed") },
      { attemptId: "attM", paymentId: "pM", take: 30, paymentBooked: true, stripe: null, failureNote: expect.stringContaining("earlier refund slice failed") },
    ]);
    expect(statusOf("attA")).toEqual(["UNKNOWN"]);
    // B and M are marked FAILED by the rollback itself, not by the service.
    expect(rolledBackIds()).toEqual(["attB", "attM"]);
    expect(statusOf("attB")).toEqual([]);
    expect(statusOf("attM")).toEqual([]);
  });

  it("keptUnknown and a later slice cannot be checked with Stripe: nothing un-booked here, every attempt left UNKNOWN", async () => {
    mockDb.registration.findUnique.mockResolvedValue(threePayments());
    threeAttempts();
    stripeRefundsCreate.mockRejectedValueOnce(new Error("ETIMEDOUT"));
    verifyRefundSpy.mockResolvedValue({ verified: false });

    await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" });
    expect(unbookSpy).not.toHaveBeenCalled();
    expect([statusOf("attA"), statusOf("attB"), statusOf("attM")]).toEqual([["UNKNOWN"], ["UNKNOWN"], ["UNKNOWN"]]);
  });

  it("a slice we never sent that Stripe somehow holds: not guessed at, left UNKNOWN for the sweep", async () => {
    mockDb.registration.findUnique.mockResolvedValue(threePayments());
    threeAttempts();
    stripeRefundsCreate.mockRejectedValueOnce(new Error("ETIMEDOUT"));
    verifyRefundSpy
      .mockResolvedValueOnce({ verified: false })
      .mockResolvedValueOnce({ verified: true, found: true, refundId: "re_odd", refundedTotal: 50, attemptIds: ["attB"] });

    await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" });
    expect(unbookSpy).not.toHaveBeenCalled();
    expect(statusOf("attB")).toEqual(["UNKNOWN"]);
  });

  it("review 2 MED-3: each Stripe slice is claimed (touched, only if still PENDING) right before it is sent", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: "pi_1", amount: 100, currency: "USD" }));
    await refundRegistration({ registrationId: "reg1", eventId: "ev1", amount: 30, source: "rest" });
    const claimIdx = mockDb.refundAttempt.updateMany.mock.calls.findIndex(
      (c) => (c[0] as { data: Record<string, unknown> }).data.updatedAt instanceof Date,
    );
    expect(mockDb.refundAttempt.updateMany.mock.calls[claimIdx][0]).toMatchObject({ where: { id: "att1", status: "PENDING" } });
    expect(mockDb.refundAttempt.updateMany.mock.invocationCallOrder[claimIdx]).toBeLessThan(stripeRefundsCreate.mock.invocationCallOrder[0]);
  });

  it("review 2 MED-3: the sweep already settled a slice we had not sent yet → stop, send nothing more, touch nothing", async () => {
    mockDb.registration.findUnique.mockResolvedValue(threePayments());
    threeAttempts();
    stripeRefundsCreate.mockResolvedValueOnce({ id: "re_A" });
    // Slice A's claim works; by slice B the sweep has rolled B back.
    mockDb.refundAttempt.updateMany.mockImplementation(async (q: { where: { id: string }; data: Record<string, unknown> }) =>
      q.where.id === "attB" && q.data.updatedAt instanceof Date ? { count: 0 } : { count: 1 });

    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "REFUND_STATE_UNKNOWN", meta: { refundedThisCall: 100 } });
    expect(stripeRefundsCreate).toHaveBeenCalledTimes(1);
    expect(unbookSpy).not.toHaveBeenCalled();
    expect(statusOf("attB")).toEqual([]);
    // Never recorded: UNKNOWN, so the sweep takes it back (PENDING would be confirmed).
    expect(statusOf("attM")).toEqual(["UNKNOWN"]);
  });

  it("MED-1: a Dashboard refund found by the rollback gets its credit note, an audit row and a notice", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: "pi_1", amount: 100, currency: "USD" }));
    stripeRefundsCreate.mockRejectedValue(new Error("amount exceeds"));
    verifyRefundSpy.mockResolvedValue({ verified: true, found: false, refundId: null, refundedTotal: 50, attemptIds: [] });
    unbookSpy.mockResolvedValue({ unbooked: 50, absorbed: [{ paymentId: "p1", amount: 50 }], registrationRefunded: 50 });
    createCreditNoteSpy.mockResolvedValue({ invoice: { id: "cn9", invoiceNumber: "CN-9", total: 50, currency: "USD" }, creditedAfter: 150, paidTotal: 100 });

    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "STRIPE_FAILED" });
    await flush();
    await flush();
    expect(createCreditNoteSpy).toHaveBeenCalledWith(expect.objectContaining({ registrationId: "reg1", amount: 50 }));
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ changes: expect.objectContaining({ source: "refund-rollback", amount: 50, absorbedFromStripe: true }) }),
    }));
    const { notifyEventAdmins } = await import("@/lib/notifications");
    expect(notifyEventAdmins).toHaveBeenCalledWith("ev1", expect.objectContaining({ title: "Refund recorded from Stripe" }));
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
    // Both per-payment counters booked + flipped (each fully refunded).
    expect(mockDb.payment.updateMany).toHaveBeenCalledWith({ where: { id: "pStripe", refundedAmount: 0 }, data: { refundedAmount: { increment: 100 }, status: "REFUNDED" } });
    expect(mockDb.payment.updateMany).toHaveBeenCalledWith({ where: { id: "pManual", refundedAmount: 0 }, data: { refundedAmount: { increment: 50 }, status: "REFUNDED" } });
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
    verifyRefundSpy.mockResolvedValue({ verified: true, found: false, refundId: null, refundedTotal: 0, attemptIds: [] });

    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" }); // full 150
    expect(r).toMatchObject({
      ok: false,
      code: "REFUND_PARTIALLY_COMPLETED",
      meta: expect.objectContaining({ refundedThisCall: 100, failedAmount: 50 }),
    });
    // Only slice B goes back; slice A's money moved and stays on the books.
    expect(unbookSpy).toHaveBeenCalledTimes(1);
    expect(unbookSpy.mock.calls[0][1]).toMatchObject({
      slices: [{ attemptId: "attB", paymentId: "pB", take: 50, paymentBooked: true, stripe: { refundedTotal: 0 } }],
      flippedToRefunded: true,
    });
    expect(mockDb.payment.updateMany).toHaveBeenCalledWith({ where: { id: "pA", refundedAmount: 0 }, data: { refundedAmount: { increment: 100 }, status: "REFUNDED" } });
    expect(unbookSpy.mock.calls[0][1].slices[0].failureNote).toBe("declined");
  });

  it("REFUND_STATE_UNKNOWN when the rollback loses its race (state moved on) → attempt UNKNOWN", async () => {
    mockDb.registration.findUnique.mockResolvedValue(reg({ id: "p1", stripePaymentId: "pi_1", amount: 100, currency: "USD" }));
    stripeRefundsCreate.mockRejectedValue(new Error("declined"));
    // The shared rollback finds the counters moved.
    unbookSpy.mockRejectedValue(new UnbookRaced("moved"));

    const r = await refundRegistration({ registrationId: "reg1", eventId: "ev1", source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "REFUND_STATE_UNKNOWN" });
    expect(mockDb.refundAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "att1", status: { in: ["PENDING", "UNKNOWN"] } }, data: expect.objectContaining({ status: "UNKNOWN" }) }),
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
    // H2 sub-item: the cancel kills any still-open Stripe payment tab.
    expect(expireSessionSpy).toHaveBeenCalledWith("reg1", "cancel-service");
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

  it("L2: nothing-left-to-refund SKIPS the credit-note issue entirely (no spurious CN)", async () => {
    // Settled 100, already refunded 100 → the CN issue used to run first and
    // could mint a spurious credit note before the refund reported
    // ALREADY_FULLY_REFUNDED. The short-circuit skips both.
    mockDb.registration.findUnique.mockResolvedValue(cancelReg({ refundedAmount: 100 }));
    const r = await cancelRegistration({ registrationId: "reg1", eventId: "ev1", organizationId: "org1", refund: true, source: "rest" });
    expect(r).toMatchObject({ ok: true, cancel: { refunded: false } });
    expect(createCreditNoteSpy).not.toHaveBeenCalled();
    expect(stripeRefundsCreate).not.toHaveBeenCalled();
  });

  it("M2: refund completes but the cancel tx fails → CANCEL_FAILED_AFTER_REFUND (not UNKNOWN)", async () => {
    // Manual payment → the refund succeeds without Stripe. The FIRST
    // $transaction is the refund's claim; the SECOND is the cancel — fail it.
    mockDb.registration.findUnique.mockResolvedValue(cancelReg());
    let txCall = 0;
    mockDb.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      txCall++;
      if (txCall === 2) throw new Error("pool timeout");
      return cb({
        registration: { updateMany: mockDb.registration.updateMany, findUnique: mockDb.registration.findUnique },
        refundAttempt: { create: mockDb.refundAttempt.create },
        payment: { updateMany: mockDb.payment.updateMany },
        promoCode: { update: mockDb.promoCode.update },
      });
    });
    const r = await cancelRegistration({ registrationId: "reg1", eventId: "ev1", organizationId: "org1", refund: true, source: "rest" });
    expect(r).toMatchObject({
      ok: false,
      code: "CANCEL_FAILED_AFTER_REFUND",
      meta: { refunded: true },
    });
  });

  it("L3: a lost cancel race returns ok WITHOUT writing an audit row for a cancel it didn't perform", async () => {
    mockDb.registration.findUnique.mockResolvedValue(cancelReg({ paymentStatus: "UNPAID", payments: [] }));
    mockDb.registration.updateMany.mockResolvedValue({ count: 0 }); // claim lost
    const r = await cancelRegistration({ registrationId: "reg1", eventId: "ev1", organizationId: "org1", refund: false, source: "rest" });
    expect(r).toMatchObject({ ok: true, cancel: { status: "CANCELLED" } });
    expect(applyRegistrationTransitionSpy).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });
});
