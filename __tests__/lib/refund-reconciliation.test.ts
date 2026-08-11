/**
 * Refund-attempt reconciliation sweep (review H4/H5, July 10 2026).
 * Pins each settlement outcome: manual-confirm, confirmed-at-Stripe,
 * provably-absent → rollback + FAILED + alert, rollback-lost-race → terminal
 * manual-review (no per-tick churn), Stripe-unreachable → left for next tick.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockDbOperator, mockApiLogger, refundsList, notifySpy } = vi.hoisted(() => ({
  mockDb: {
    // Per-attempt work; stays on the normal client inside the row's own lane.
    refundAttempt: { findMany: vi.fn(), update: vi.fn() },
    registration: { updateMany: vi.fn() },
  },
  // The privileged candidate scan, and ONLY that.
  mockDbOperator: { refundAttempt: { findMany: vi.fn() } },
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  refundsList: vi.fn(),
  notifySpy: vi.fn().mockResolvedValue(undefined),
}));

// `dbOperator` is a DISTINCT fake here, not an alias of `db`. Binding both to
// one object is fine for master parity but makes the assertion meaningless:
// reverting `dbOperator.x` to `db.x` would still pass. The scan below is the
// one statement that MUST be privileged, and on the platform a revert makes
// it return zero rows forever without erroring, so the test distinguishes them.
vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: mockDbOperator }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ refunds: { list: refundsList } }) }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: notifySpy }));

import { resolveStaleRefundAttempts, findStripeRefundForAttempt } from "@/lib/refund-reconciliation";

function attempt(extra: Record<string, unknown> = {}) {
  return {
    id: "att1",
    registrationId: "reg1",
    paymentId: "p1",
    stripePaymentIntentId: "pi_1",
    amount: 50,
    refundedBefore: 0,
    refundedAfter: 50,
    flippedToRefunded: false,
    kind: "stripe",
    status: "PENDING",
    registration: { eventId: "ev1", attendee: { firstName: "A", lastName: "B" } },
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.refundAttempt.update.mockResolvedValue({});
  mockDb.registration.updateMany.mockResolvedValue({ count: 1 });
  refundsList.mockResolvedValue({ data: [] });
  notifySpy.mockResolvedValue(undefined);
});

describe("findStripeRefundForAttempt", () => {
  it("matches by metadata.refundAttemptId", async () => {
    refundsList.mockResolvedValue({
      data: [
        { id: "re_other", metadata: { refundAttemptId: "someone-else" } },
        { id: "re_mine", metadata: { refundAttemptId: "att1" } },
      ],
    });
    expect(await findStripeRefundForAttempt("pi_1", "att1", null)).toEqual({ verified: true, found: true, refundId: "re_mine" });
  });

  it("returns verified:false (not found:false) when Stripe is unreachable", async () => {
    refundsList.mockRejectedValue(new Error("network"));
    expect(await findStripeRefundForAttempt("pi_1", "att1", null)).toEqual({ verified: false });
    expect(mockApiLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "refund-verify:stripe-list-failed" }));
  });
});

describe("resolveStaleRefundAttempts", () => {
  it("confirms a stale MANUAL attempt (booking is the record)", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([attempt({ kind: "manual", stripePaymentIntentId: null })]);
    const r = await resolveStaleRefundAttempts();
    expect(r).toMatchObject({ scanned: 1, confirmed: 1, rolledBack: 0 });
    expect(mockDb.refundAttempt.update).toHaveBeenCalledWith({ where: { id: "att1" }, data: { status: "SUCCEEDED" } });
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });

  it("confirms a stripe attempt whose refund exists at Stripe (crash AFTER the Stripe call)", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([attempt()]);
    refundsList.mockResolvedValue({ data: [{ id: "re_found", metadata: { refundAttemptId: "att1" } }] });
    const r = await resolveStaleRefundAttempts();
    expect(r).toMatchObject({ confirmed: 1, rolledBack: 0 });
    expect(mockDb.refundAttempt.update).toHaveBeenCalledWith({
      where: { id: "att1" },
      data: { status: "SUCCEEDED", stripeRefundId: "re_found" },
    });
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });

  it("rolls back the booking when the refund provably never happened (crash BEFORE the Stripe call, H4)", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([attempt({ flippedToRefunded: true })]);
    const r = await resolveStaleRefundAttempts();
    expect(r).toMatchObject({ rolledBack: 1 });
    // Guarded decrement — sibling slices / webhook adjustments preserved.
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { id: "reg1", refundedAmount: { gte: 50 } },
      data: { refundedAmount: { decrement: 50 }, paymentStatus: "PAID" },
    });
    expect(mockDb.refundAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "att1" }, data: expect.objectContaining({ status: "FAILED" }) }),
    );
    expect(notifySpy).toHaveBeenCalledWith("ev1", expect.objectContaining({ title: expect.stringContaining("Refund did not complete") }));
    expect(mockApiLogger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "refund-sweep:rolled-back" }));
  });

  it("does not flip paymentStatus back when the attempt never flipped it (partial refund)", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([attempt({ flippedToRefunded: false, refundedBefore: 20, refundedAfter: 70 })]);
    await resolveStaleRefundAttempts();
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { id: "reg1", refundedAmount: { gte: 50 } },
      data: { refundedAmount: { decrement: 50 } },
    });
  });

  it("goes terminal (manual review, no churn) when the rollback loses its race", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([attempt()]);
    mockDb.registration.updateMany.mockResolvedValue({ count: 0 });
    const r = await resolveStaleRefundAttempts();
    expect(r).toMatchObject({ needsReview: 1, rolledBack: 0 });
    expect(mockDb.refundAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", error: expect.stringContaining("review manually") }) }),
    );
    expect(notifySpy).toHaveBeenCalledWith("ev1", expect.objectContaining({ title: expect.stringContaining("manual review") }));
  });

  it("leaves the attempt for the next tick when Stripe is unreachable", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([attempt()]);
    refundsList.mockRejectedValue(new Error("down"));
    const r = await resolveStaleRefundAttempts();
    expect(r).toMatchObject({ unverifiable: 1 });
    expect(mockDb.refundAttempt.update).not.toHaveBeenCalled();
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });

  it("one bad row cannot kill the tick (per-attempt try/catch)", async () => {
    mockDbOperator.refundAttempt.findMany.mockResolvedValue([
      attempt({ id: "att-bad" }),
      attempt({ id: "att-good", kind: "manual", stripePaymentIntentId: null }),
    ]);
    mockDb.refundAttempt.update
      .mockRejectedValueOnce(new Error("db blip")) // att-bad's FAILED write throws
      .mockResolvedValue({});
    const r = await resolveStaleRefundAttempts();
    expect(r.scanned).toBe(2);
    expect(r.confirmed).toBe(1); // att-good still processed
    expect(mockApiLogger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "refund-sweep:attempt-failed", attemptId: "att-bad" }));
  });
});
