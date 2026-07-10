/**
 * Refund route — gated partial refunds.
 *
 * A refund requires a non-cancelled CREDIT_NOTE to already exist (the organizer
 * issues it first). The refund amount is entered here independently and may be
 * partial: partial refunds accumulate into `Registration.refundedAmount` and the
 * registration stays PAID until fully refunded, then flips to REFUNDED. Stripe
 * partial via `amount`; manual/offline records only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockDb,
  mockAuth,
  stripeRefundsCreate,
  stripeRefundsList,
  sendEmailSpy,
} = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    payment: { update: vi.fn() },
    invoice: { findFirst: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    refundAttempt: { create: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  },
  mockAuth: vi.fn(),
  stripeRefundsCreate: vi.fn(),
  stripeRefundsList: vi.fn(),
  sendEmailSpy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ refunds: { create: stripeRefundsCreate, list: stripeRefundsList } }),
  // Real behaviour for USD (non-zero-decimal): major → minor units.
  toStripeAmount: (amount: number) => Math.round(amount * 100),
}));
vi.mock("@/lib/email", () => ({
  sendEmail: sendEmailSpy,
  getEventTemplate: vi.fn().mockResolvedValue(null),
  getDefaultTemplate: vi.fn().mockReturnValue({ subject: "s", html: "h", text: "t" }),
  renderAndWrap: vi.fn().mockReturnValue({ subject: "s", html: "h", text: "t" }),
  brandingFrom: vi.fn().mockReturnValue({ email: "f@x.com" }),
  brandingCc: vi.fn().mockReturnValue([]),
}));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn().mockReturnValue({ catch: () => {} }) }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
// denyReviewer, buildEventAccessWhere, registration-financials, utils are REAL (pure).

import { POST } from "@/app/api/events/[eventId]/registrations/[registrationId]/refund/route";

const params = Promise.resolve({ eventId: "ev1", registrationId: "reg1" });
const req = (body?: unknown) =>
  new Request("http://localhost/x", {
    method: "POST",
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });

function registration(paymentOverrides: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  return {
    id: "reg1",
    serialId: 7,
    eventId: "ev1",
    paymentStatus: "PAID",
    refundedAmount: 0,
    originalPrice: 100,
    discountAmount: null,
    attendee: { firstName: "A", lastName: "B", email: "a@b.com", additionalEmail: null, title: null },
    ticketType: { name: "Standard", price: 100, currency: "USD" },
    pricingTier: null,
    event: { id: "ev1", organizationId: "org1", name: "Ev", startDate: new Date("2026-11-01"), taxRate: null, taxLabel: null },
    // Per-payment refunded counter defaults to 0 (as in the real schema).
    payments: paymentOverrides ? [{ refundedAmount: 0, ...paymentOverrides }] : [],
    ...extra,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  mockDb.invoice.findFirst.mockResolvedValue({ id: "cn1" }); // credit note exists (gate open)
  mockDb.registration.updateMany.mockResolvedValue({ count: 1 });
  mockDb.registration.update.mockResolvedValue({});
  mockDb.payment.update.mockResolvedValue({});
  stripeRefundsCreate.mockResolvedValue({ id: "re_1", status: "succeeded" });
  // Verification (verify-before-rollback): Stripe reachable, refund absent.
  stripeRefundsList.mockResolvedValue({ data: [] });
  mockDb.refundAttempt.create.mockResolvedValue({ id: "att1" });
  mockDb.refundAttempt.update.mockResolvedValue({});
  // The service's claim+attempt transaction routes to the shared mocks.
  mockDb.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      registration: { updateMany: mockDb.registration.updateMany },
      refundAttempt: { create: mockDb.refundAttempt.create },
    }),
  );
});

describe("refund — credit-note gate", () => {
  it("409 CREDIT_NOTE_REQUIRED when no credit note exists; Stripe + lock untouched", async () => {
    mockDb.invoice.findFirst.mockResolvedValue(null);
    mockDb.registration.findUnique.mockResolvedValue(
      registration({ id: "pay1", stripePaymentId: "pi_1", amount: 100, currency: "USD" }),
    );
    const res = await POST(req(), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CREDIT_NOTE_REQUIRED");
    expect(stripeRefundsCreate).not.toHaveBeenCalled();
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });
});

describe("refund — manual/offline payment", () => {
  it("full manual refund flips reg + payment → REFUNDED, no Stripe", async () => {
    mockDb.registration.findUnique.mockResolvedValue(
      registration({ id: "pay1", stripePaymentId: null, amount: 100, currency: "USD" }),
    );
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      refundId: null, manual: true, status: "recorded",
      amount: 100, currency: "USD", refundedAmount: 100, paidTotal: 100, fullyRefunded: true,
      slices: [{ paymentId: "pay1", kind: "manual", amount: 100, stripeRefundId: null }],
    });
    expect(stripeRefundsCreate).not.toHaveBeenCalled();
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { id: "reg1", paymentStatus: "PAID", refundedAmount: 0 },
      data: { refundedAmount: 100, paymentStatus: "REFUNDED" },
    });
    // Per-payment counter bumped + flipped in one write.
    expect(mockDb.payment.update).toHaveBeenCalledWith({ where: { id: "pay1" }, data: { refundedAmount: 100, status: "REFUNDED" } });
  });

  it("PARTIAL manual refund keeps reg PAID + payment PAID, tracks refundedAmount", async () => {
    mockDb.registration.findUnique.mockResolvedValue(
      registration({ id: "pay1", stripePaymentId: null, amount: 100, currency: "USD" }),
    );
    const res = await POST(req({ amount: 40 }), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ amount: 40, refundedAmount: 40, paidTotal: 100, fullyRefunded: false });
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { id: "reg1", paymentStatus: "PAID", refundedAmount: 0 },
      data: { refundedAmount: 40 }, // no paymentStatus flip on partial
    });
    // Per-payment counter tracks the partial; the payment's STATUS stays PAID.
    expect(mockDb.payment.update).toHaveBeenCalledWith({ where: { id: "pay1" }, data: { refundedAmount: 40 } });
  });

  it("a partial that completes the balance flips to REFUNDED", async () => {
    // Post-migration reality: the earlier $60 partial is tracked on the
    // payment's own counter too (the backfill attributes single-payment regs).
    mockDb.registration.findUnique.mockResolvedValue(
      registration({ id: "pay1", stripePaymentId: null, amount: 100, currency: "USD", refundedAmount: 60 }, { refundedAmount: 60 }),
    );
    const res = await POST(req({ amount: 40 }), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ refundedAmount: 100, fullyRefunded: true });
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { id: "reg1", paymentStatus: "PAID", refundedAmount: 60 },
      data: { refundedAmount: 100, paymentStatus: "REFUNDED" },
    });
    expect(mockDb.payment.update).toHaveBeenCalledWith({ where: { id: "pay1" }, data: { refundedAmount: 100, status: "REFUNDED" } });
  });
});

describe("refund — Stripe payment", () => {
  it("full Stripe refund passes amount + cumulative idempotency key", async () => {
    mockDb.registration.findUnique.mockResolvedValue(
      registration({ id: "pay1", stripePaymentId: "pi_123", amount: 100, currency: "USD" }),
    );
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ refundId: "re_1", manual: false, status: "succeeded", amount: 100, fullyRefunded: true });
    expect(stripeRefundsCreate).toHaveBeenCalledWith(
      { payment_intent: "pi_123", amount: 10000, metadata: { refundAttemptId: "att1", registrationId: "reg1" } },
      { idempotencyKey: "refund-attempt-att1" },
    );
  });

  it("PARTIAL Stripe refund reverses only the entered amount, keeps PAID", async () => {
    mockDb.registration.findUnique.mockResolvedValue(
      registration({ id: "pay1", stripePaymentId: "pi_123", amount: 100, currency: "USD" }),
    );
    const res = await POST(req({ amount: 30 }), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ amount: 30, refundedAmount: 30, fullyRefunded: false });
    expect(stripeRefundsCreate).toHaveBeenCalledWith(
      { payment_intent: "pi_123", amount: 3000, metadata: { refundAttemptId: "att1", registrationId: "reg1" } },
      { idempotencyKey: "refund-attempt-att1" },
    );
    // Per-payment counter tracks the partial; the payment's STATUS stays PAID.
    expect(mockDb.payment.update).toHaveBeenCalledWith({ where: { id: "pay1" }, data: { refundedAmount: 30 } });
  });

  it("rolls the refunded total back (conditionally) and 502s when Stripe fails and the refund is provably absent", async () => {
    mockDb.registration.findUnique.mockResolvedValue(
      registration({ id: "pay1", stripePaymentId: "pi_123", amount: 100, currency: "USD" }),
    );
    stripeRefundsCreate.mockRejectedValue(new Error("stripe down"));
    // stripeRefundsList default: reachable + empty → verified absent → rollback.
    const res = await POST(req(), { params });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("STRIPE_FAILED");
    // Guarded decrement of the un-executed portion (multi-slice safe).
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { id: "reg1", refundedAmount: { gte: 100 } },
      data: { refundedAmount: { decrement: 100 }, paymentStatus: "PAID" },
    });
  });

  it("502 REFUND_STATE_UNKNOWN — Stripe fails AND verification unreachable → booking kept for the sweep", async () => {
    mockDb.registration.findUnique.mockResolvedValue(
      registration({ id: "pay1", stripePaymentId: "pi_123", amount: 100, currency: "USD" }),
    );
    stripeRefundsCreate.mockRejectedValue(new Error("stripe down"));
    stripeRefundsList.mockRejectedValue(new Error("stripe still down"));
    const res = await POST(req(), { params });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("REFUND_STATE_UNKNOWN");
    // Only the claim ran — no rollback write.
    expect(mockDb.registration.updateMany).toHaveBeenCalledTimes(1);
    expect(mockDb.refundAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "att1" }, data: expect.objectContaining({ status: "UNKNOWN" }) }),
    );
  });
});

describe("refund — guards", () => {
  it("400 when the registration is not PAID", async () => {
    mockDb.registration.findUnique.mockResolvedValue(registration(null, { paymentStatus: "UNPAID" }));
    const res = await POST(req(), { params });
    expect(res.status).toBe(400);
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });

  it("400 INVALID_AMOUNT when the amount exceeds the remaining balance", async () => {
    mockDb.registration.findUnique.mockResolvedValue(
      registration({ id: "pay1", stripePaymentId: null, amount: 100, currency: "USD" }, { refundedAmount: 80 }),
    );
    const res = await POST(req({ amount: 40 }), { params }); // only 20 remains
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_AMOUNT");
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });

  it("409 when the optimistic lock is lost (concurrent refund)", async () => {
    mockDb.registration.findUnique.mockResolvedValue(
      registration({ id: "pay1", stripePaymentId: null, amount: 100, currency: "USD" }),
    );
    mockDb.registration.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(req(), { params });
    expect(res.status).toBe(409);
    expect(stripeRefundsCreate).not.toHaveBeenCalled();
  });

  it("401 unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(req(), { params });
    expect(res.status).toBe(401);
  });

  it("403 for a restricted role (MEMBER)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", organizationId: "org1" } });
    const res = await POST(req(), { params });
    expect(res.status).toBe(403);
  });

  it("sends NO automatic email — the organizer communicates the refund manually", async () => {
    mockDb.registration.findUnique.mockResolvedValue(
      registration({ id: "pay1", stripePaymentId: null, amount: 100, currency: "USD" }),
    );
    await POST(req(), { params });
    await flush();
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });
});
