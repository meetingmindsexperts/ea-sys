/**
 * Refund-attempt reconciliation sweep (review H4/H5, July 10 2026; rollback
 * moved to src/services/refund-unbook.ts on Nov 6 2026).
 * Pins each settlement outcome: manual PENDING confirmed, manual UNKNOWN rolled
 * back, confirmed-at-Stripe, provably-absent → rollback + FAILED + alert,
 * rollback refused → terminal manual review (no per-tick churn),
 * Stripe-unreachable → left for next tick. The rollback's arithmetic is pinned
 * in __tests__/services/refund-unbook.test.ts; here, what the sweep hands it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockDbOperator, mockApiLogger, refundsList, notifySpy, unbookSpy, recordAbsorbedSpy, UnbookRaced, UnbookNeedsReview, UnbookAttemptMoved } = vi.hoisted(() => ({
  mockDb: {
    // Per-attempt work; stays on the normal client inside the row's own lane.
    refundAttempt: { findMany: vi.fn(), updateMany: vi.fn() },
    payment: { findUnique: vi.fn() },
  },
  // The privileged candidate scan, and ONLY that.
  mockDbOperator: { refundAttempt: { findMany: vi.fn() } },
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  refundsList: vi.fn(),
  notifySpy: vi.fn().mockResolvedValue(undefined),
  unbookSpy: vi.fn(),
  recordAbsorbedSpy: vi.fn(),
  UnbookRaced: class UnbookRaced extends Error {},
  UnbookNeedsReview: class UnbookNeedsReview extends Error {},
  UnbookAttemptMoved: class UnbookAttemptMoved extends Error {},
}));

// `dbOperator` is a DISTINCT fake here, not an alias of `db`. Binding both to
// one object is fine for master parity but makes the assertion meaningless:
// reverting `dbOperator.x` to `db.x` would still pass. The scan below is the
// one statement that MUST be privileged, and on the platform a revert makes
// it return zero rows forever without erroring, so the test distinguishes them.
vi.mock("@/lib/db", () => ({
  db: mockDb,
  dbOperator: mockDbOperator,
  // Flag off, tenantTransaction is db.$transaction; the rollback is mocked, so
  // the tx it receives only needs to be passed through.
  tenantTransaction: (fn: (tx: unknown) => unknown) => fn({ tx: true }),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ refunds: { list: refundsList } }),
  fromStripeAmount: (a: number) => a / 100,
}));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: notifySpy }));
vi.mock("@/services/refund-unbook", () => ({ unbookRefund: unbookSpy, UnbookRaced, UnbookNeedsReview, UnbookAttemptMoved }));
vi.mock("@/services/payment-service", () => ({ recordAbsorbedRefunds: recordAbsorbedSpy }));

import { resolveStaleRefundAttempts, findStripeRefundForAttempt } from "@/lib/refund-reconciliation";

const READ_AT = new Date("2026-11-06T10:00:00Z");
/** The guarded status write the sweep makes: only if the attempt is as it read it. */
const guarded = (id: string, data: Record<string, unknown>) => ({
  where: { id, status: { in: ["PENDING", "UNKNOWN"] }, updatedAt: READ_AT },
  data,
});

function attempt(extra: Record<string, unknown> = {}) {
  return {
    id: "att1",
    registrationId: "reg1",
    organizationId: "org1",
    paymentId: "p1",
    stripePaymentIntentId: "pi_1",
    amount: 50,
    refundedBefore: 0,
    refundedAfter: 50,
    flippedToRefunded: false,
    paymentBooked: true,
    kind: "stripe",
    status: "PENDING",
    updatedAt: READ_AT,
    registration: { eventId: "ev1", organizationId: "org1", attendee: { firstName: "A", lastName: "B" } },
    ...extra,
  };
}

const refund = (id: string, amount: number, status: string, attemptId?: string) => ({
  id, amount, status, currency: "usd", metadata: attemptId ? { refundAttemptId: attemptId } : {},
});

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.refundAttempt.updateMany.mockResolvedValue({ count: 1 });
  mockDb.payment.findUnique.mockResolvedValue({ currency: "usd" });
  refundsList.mockResolvedValue({ data: [], has_more: false });
  notifySpy.mockResolvedValue(undefined);
  unbookSpy.mockResolvedValue({ unbooked: 50, absorbed: [], registrationRefunded: 0 });
});

describe("findStripeRefundForAttempt", () => {
  it("matches by metadata.refundAttemptId and totals what Stripe has refunded", async () => {
    refundsList.mockResolvedValue({
      data: [refund("re_other", 2000, "succeeded", "someone-else"), refund("re_mine", 3000, "succeeded", "att1")],
      has_more: false,
    });
    expect(await findStripeRefundForAttempt("pi_1", "att1", null)).toEqual({
      verified: true, found: true, refundId: "re_mine", refundedTotal: 50, attemptIds: ["someone-else", "att1"],
    });
  });

  it("a failed or canceled refund moved no money: not found, and not in the total", async () => {
    refundsList.mockResolvedValue({
      data: [refund("re_failed", 3000, "failed", "att1"), refund("re_cancel", 1000, "canceled"), refund("re_pending", 500, "pending")],
      has_more: false,
    });
    expect(await findStripeRefundForAttempt("pi_1", "att1", null)).toEqual({
      verified: true, found: false, refundId: null, refundedTotal: 5, attemptIds: [],
    });
  });

  it("refuses a partial list (has_more) rather than return a short total", async () => {
    refundsList.mockResolvedValue({ data: [refund("re_1", 100, "succeeded")], has_more: true });
    expect(await findStripeRefundForAttempt("pi_1", "att1", null)).toEqual({ verified: false });
    expect(mockApiLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "refund-verify:too-many-refunds" }));
  });

  it("returns verified:false (not found:false) when Stripe is unreachable", async () => {
    refundsList.mockRejectedValue(new Error("network"));
    expect(await findStripeRefundForAttempt("pi_1", "att1", null)).toEqual({ verified: false });
    expect(mockApiLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "refund-verify:stripe-list-failed" }));
  });
});

describe("resolveStaleRefundAttempts", () => {
  it("confirms a stale MANUAL PENDING attempt (the process died before the status write)", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([attempt({ kind: "manual", stripePaymentIntentId: null })]);
    const r = await resolveStaleRefundAttempts();
    expect(r).toMatchObject({ scanned: 1, confirmed: 1, rolledBack: 0 });
    expect(mockDb.refundAttempt.updateMany).toHaveBeenCalledWith(guarded("att1", { status: "SUCCEEDED" }));
    expect(unbookSpy).not.toHaveBeenCalled();
  });

  it("a manual PENDING attempt whose Stripe siblings are still unsettled waits (the refund may still be sending them)", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([attempt({ kind: "manual", stripePaymentIntentId: null, bookingId: "bk1" })]);
    mockDb.refundAttempt.findMany.mockResolvedValue([{ status: "SUCCEEDED" }, { status: "PENDING" }]);
    const r = await resolveStaleRefundAttempts();
    expect(r).toMatchObject({ moved: 1, confirmed: 0, rolledBack: 0 });
    expect(mockDb.refundAttempt.findMany).toHaveBeenCalledWith({ where: { bookingId: "bk1", kind: "stripe" }, select: { status: true } });
    expect(mockDb.refundAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("a manual PENDING attempt whose refund had a Stripe part fail is rolled back, not confirmed", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([attempt({ kind: "manual", stripePaymentIntentId: null, bookingId: "bk1", paymentId: "pM", amount: 30 })]);
    mockDb.refundAttempt.findMany.mockResolvedValue([{ status: "SUCCEEDED" }, { status: "FAILED" }]);
    const r = await resolveStaleRefundAttempts();
    expect(r).toMatchObject({ rolledBack: 1, confirmed: 0 });
    expect(unbookSpy.mock.calls[0][1].slices[0]).toMatchObject({ attemptId: "att1", stripe: null, failureNote: expect.stringContaining("manual part rolled back") });
  });

  it("a manual PENDING attempt whose Stripe siblings all succeeded is confirmed", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([attempt({ kind: "manual", stripePaymentIntentId: null, bookingId: "bk1" })]);
    mockDb.refundAttempt.findMany.mockResolvedValue([{ status: "SUCCEEDED" }]);
    const r = await resolveStaleRefundAttempts();
    expect(r).toMatchObject({ confirmed: 1 });
    expect(unbookSpy).not.toHaveBeenCalled();
  });

  it("MED-2: rolls back a MANUAL UNKNOWN attempt (left by a rollback that did not apply), with no Stripe figure", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([attempt({ kind: "manual", status: "UNKNOWN", stripePaymentIntentId: null, paymentId: "pM", amount: 30 })]);
    const r = await resolveStaleRefundAttempts();
    expect(r).toMatchObject({ rolledBack: 1, confirmed: 0 });
    expect(refundsList).not.toHaveBeenCalled();
    expect(unbookSpy).toHaveBeenCalledWith({ tx: true }, {
      registrationId: "reg1",
      slices: [{ attemptId: "att1", paymentId: "pM", take: 30, paymentBooked: true, stripe: null, failureNote: expect.any(String), expectedUpdatedAt: READ_AT }],
      flippedToRefunded: false,
    });
  });

  it("confirms a stripe attempt whose refund exists at Stripe (crash AFTER the Stripe call)", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([attempt()]);
    refundsList.mockResolvedValue({ data: [refund("re_found", 5000, "succeeded", "att1")], has_more: false });
    const r = await resolveStaleRefundAttempts();
    expect(r).toMatchObject({ confirmed: 1, rolledBack: 0 });
    expect(mockDb.refundAttempt.updateMany).toHaveBeenCalledWith(guarded("att1", { status: "SUCCEEDED", stripeRefundId: "re_found" }));
    expect(unbookSpy).not.toHaveBeenCalled();
  });

  it("rolls back the booking when the refund provably never happened (crash BEFORE the Stripe call, H4), with Stripe's figure", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([attempt({ flippedToRefunded: true })]);
    refundsList.mockResolvedValue({ data: [refund("re_dash", 2000, "succeeded")], has_more: false });
    const r = await resolveStaleRefundAttempts();
    expect(r).toMatchObject({ rolledBack: 1 });
    expect(unbookSpy).toHaveBeenCalledWith({ tx: true }, {
      registrationId: "reg1",
      slices: [{
        attemptId: "att1", paymentId: "p1", take: 50, paymentBooked: true, stripe: { refundedTotal: 20, attemptIds: [] },
        failureNote: "No matching refund at Stripe — booking rolled back by sweep", expectedUpdatedAt: READ_AT,
      }],
      flippedToRefunded: true,
    });
    // The rollback marks the attempt itself; the sweep writes nothing more.
    expect(mockDb.refundAttempt.updateMany).not.toHaveBeenCalled();
    expect(notifySpy).toHaveBeenCalledWith("ev1", expect.objectContaining({ title: expect.stringContaining("Refund did not complete") }));
    expect(mockApiLogger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "refund-sweep:rolled-back" }));
    expect(recordAbsorbedSpy).not.toHaveBeenCalled();
  });

  it("LOW-1: an attempt from the previous image is handed over as paymentBooked false", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([attempt({ paymentBooked: false })]);
    await resolveStaleRefundAttempts();
    expect(unbookSpy.mock.calls[0][1].slices[0].paymentBooked).toBe(false);
  });

  it("MED-1: a Dashboard refund found by the rollback is recorded (credit note, audit, notice)", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([attempt()]);
    unbookSpy.mockResolvedValue({ unbooked: 0, absorbed: [{ paymentId: "p1", amount: 50 }], registrationRefunded: 50 });
    await resolveStaleRefundAttempts();
    expect(recordAbsorbedSpy).toHaveBeenCalledWith({
      registrationId: "reg1", eventId: "ev1", organizationId: "org1", currency: "USD",
      absorbed: [{ paymentId: "p1", amount: 50 }], attendee: { firstName: "A", lastName: "B" },
    });
  });

  it("goes terminal (manual review, no churn) when the rollback finds the counters moved", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([attempt()]);
    unbookSpy.mockRejectedValue(new UnbookRaced("moved"));
    const r = await resolveStaleRefundAttempts();
    expect(r).toMatchObject({ needsReview: 1, rolledBack: 0 });
    expect(mockDb.refundAttempt.updateMany).toHaveBeenCalledWith(
      guarded("att1", { status: "FAILED", error: expect.stringContaining("review manually") }),
    );
    expect(notifySpy).toHaveBeenCalledWith("ev1", expect.objectContaining({ title: expect.stringContaining("manual review") }));
  });

  it("goes terminal when the books hold more than Stripe explains (needs review)", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([attempt()]);
    unbookSpy.mockRejectedValue(new UnbookNeedsReview("counter above Stripe"));
    const r = await resolveStaleRefundAttempts();
    expect(r).toMatchObject({ needsReview: 1, rolledBack: 0 });
    expect(mockApiLogger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "refund-sweep:rollback-state-moved-on" }));
  });

  it("a database error inside the rollback is not mistaken for a race: logged, attempt left for the next tick", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([attempt()]);
    unbookSpy.mockRejectedValue(new Error("connection reset"));
    const r = await resolveStaleRefundAttempts();
    expect(r).toMatchObject({ needsReview: 0, rolledBack: 0 });
    expect(mockDb.refundAttempt.updateMany).not.toHaveBeenCalled();
    expect(mockApiLogger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "refund-sweep:attempt-failed" }));
  });

  it("review 2 MED-1/MED-3: an attempt the refund service touched or settled since this tick read it is left alone", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([attempt()]);
    unbookSpy.mockRejectedValue(new UnbookAttemptMoved("touched"));
    const r = await resolveStaleRefundAttempts();
    expect(r).toMatchObject({ moved: 1, rolledBack: 0, needsReview: 0 });
    expect(mockDb.refundAttempt.updateMany).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("...and a confirm that finds the attempt moved writes nothing and counts it as moved", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([attempt({ kind: "manual", stripePaymentIntentId: null })]);
    mockDb.refundAttempt.updateMany.mockResolvedValue({ count: 0 });
    const r = await resolveStaleRefundAttempts();
    expect(r).toMatchObject({ moved: 1, confirmed: 0 });
  });

  it("picks attempts by last touch, not by creation, so a refund still sending is not taken for dead", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([]);
    await resolveStaleRefundAttempts();
    const where = mockDbOperator.refundAttempt.findMany.mock.calls[0][0].where;
    expect(where.updatedAt.lt).toBeInstanceOf(Date);
    expect(where.createdAt).toBeUndefined();
  });

  it("leaves the attempt for the next tick when Stripe is unreachable", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([attempt()]);
    refundsList.mockRejectedValue(new Error("down"));
    const r = await resolveStaleRefundAttempts();
    expect(r).toMatchObject({ unverifiable: 1 });
    expect(mockDb.refundAttempt.updateMany).not.toHaveBeenCalled();
    expect(unbookSpy).not.toHaveBeenCalled();
  });

  it("one bad row cannot kill the tick (per-attempt try/catch)", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([
      attempt({ id: "att-bad" }),
      attempt({ id: "att-good", kind: "manual", stripePaymentIntentId: null }),
    ]);
    unbookSpy.mockRejectedValueOnce(new Error("db blip")); // att-bad's rollback throws
    const r = await resolveStaleRefundAttempts();
    expect(r.scanned).toBe(2);
    expect(r.confirmed).toBe(1); // att-good still processed
    expect(mockApiLogger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "refund-sweep:attempt-failed", attemptId: "att-bad" }));
  });
});
