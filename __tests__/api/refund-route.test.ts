/**
 * Refund route — manual/offline refunds (option A) alongside the existing Stripe
 * path. A registration paid MANUALLY (Payment.stripePaymentId null) or a PAID reg
 * with no Payment row must be refundable WITHOUT calling Stripe: flip
 * registration + Payment → REFUNDED and issue a credit note. A Stripe-paid reg
 * still calls stripe.refunds.create. Before this, the route 400'd every non-Stripe
 * payment ("No Stripe payment found").
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockDb,
  mockAuth,
  stripeRefundsCreate,
  createCreditNoteSpy,
  sendInvoiceEmailSpy,
  sendEmailSpy,
} = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    payment: { update: vi.fn() },
  },
  mockAuth: vi.fn(),
  stripeRefundsCreate: vi.fn(),
  createCreditNoteSpy: vi.fn().mockResolvedValue({ invoice: { id: "cn1" }, created: true }),
  sendInvoiceEmailSpy: vi.fn().mockResolvedValue(undefined),
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
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ refunds: { create: stripeRefundsCreate } }) }));
vi.mock("@/lib/email", () => ({
  sendEmail: sendEmailSpy,
  getEventTemplate: vi.fn().mockResolvedValue(null),
  getDefaultTemplate: vi.fn().mockReturnValue({ subject: "s", html: "h", text: "t" }),
  renderAndWrap: vi.fn().mockReturnValue({ subject: "s", html: "h", text: "t" }),
  brandingFrom: vi.fn().mockReturnValue({ email: "f@x.com" }),
  brandingCc: vi.fn().mockReturnValue([]),
}));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn().mockReturnValue({ catch: () => {} }) }));
vi.mock("@/lib/invoice-service", () => ({ createCreditNote: createCreditNoteSpy, sendInvoiceEmail: sendInvoiceEmailSpy }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
// denyReviewer, buildEventAccessWhere, registration-financials, utils are REAL (pure).

import { POST } from "@/app/api/events/[eventId]/registrations/[registrationId]/refund/route";

const params = Promise.resolve({ eventId: "ev1", registrationId: "reg1" });
const req = () => new Request("http://localhost/x", { method: "POST" });

function registration(paymentOverrides: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  return {
    id: "reg1",
    serialId: 7,
    eventId: "ev1",
    paymentStatus: "PAID",
    originalPrice: 100,
    discountAmount: null,
    attendee: { firstName: "A", lastName: "B", email: "a@b.com", additionalEmail: null, title: null },
    ticketType: { name: "Standard", price: 100, currency: "USD" },
    pricingTier: null,
    event: { id: "ev1", organizationId: "org1", name: "Ev", startDate: new Date("2026-11-01"), taxRate: null, taxLabel: null },
    payments: paymentOverrides ? [paymentOverrides] : [],
    ...extra,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  mockDb.registration.updateMany.mockResolvedValue({ count: 1 });
  mockDb.registration.update.mockResolvedValue({});
  mockDb.payment.update.mockResolvedValue({});
  stripeRefundsCreate.mockResolvedValue({ id: "re_1", status: "succeeded" });
});

describe("refund — manual/offline payment (option A)", () => {
  it("refunds a manual payment WITHOUT calling Stripe; flips reg + payment, issues credit note", async () => {
    mockDb.registration.findUnique.mockResolvedValue(
      registration({ id: "pay1", stripePaymentId: null, amount: 100, currency: "USD" }),
    );
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ refundId: null, manual: true, status: "recorded" });
    expect(stripeRefundsCreate).not.toHaveBeenCalled();
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { id: "reg1", paymentStatus: "PAID" },
      data: { paymentStatus: "REFUNDED" },
    });
    expect(mockDb.payment.update).toHaveBeenCalledWith({ where: { id: "pay1" }, data: { status: "REFUNDED" } });
    await flush();
    expect(createCreditNoteSpy).toHaveBeenCalledTimes(1);
    expect(sendInvoiceEmailSpy).toHaveBeenCalledWith("cn1"); // created:true → email sent
  });

  it("does NOT re-email when the credit note already exists (idempotent createCreditNote)", async () => {
    mockDb.registration.findUnique.mockResolvedValue(
      registration({ id: "pay1", stripePaymentId: null, amount: 100, currency: "USD" }),
    );
    createCreditNoteSpy.mockResolvedValueOnce({ invoice: { id: "cn1" }, created: false });
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    await flush();
    expect(createCreditNoteSpy).toHaveBeenCalledTimes(1);
    expect(sendInvoiceEmailSpy).not.toHaveBeenCalled(); // created:false → no duplicate email
  });

  it("refunds a PAID reg with NO payment row (hand-flipped) without Stripe; no payment.update", async () => {
    mockDb.registration.findUnique.mockResolvedValue(registration(null));
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    expect((await res.json()).manual).toBe(true);
    expect(stripeRefundsCreate).not.toHaveBeenCalled();
    expect(mockDb.payment.update).not.toHaveBeenCalled(); // nothing to flip
  });
});

describe("refund — Stripe payment (unchanged path)", () => {
  it("calls stripe.refunds.create and returns the refund id", async () => {
    mockDb.registration.findUnique.mockResolvedValue(
      registration({ id: "pay1", stripePaymentId: "pi_123", amount: 100, currency: "USD" }),
    );
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ refundId: "re_1", manual: false, status: "succeeded" });
    expect(stripeRefundsCreate).toHaveBeenCalledWith(
      { payment_intent: "pi_123" },
      { idempotencyKey: "refund-pay1" },
    );
    expect(mockDb.payment.update).toHaveBeenCalledWith({ where: { id: "pay1" }, data: { status: "REFUNDED" } });
  });

  it("rolls back to PAID and 502s when Stripe fails", async () => {
    mockDb.registration.findUnique.mockResolvedValue(
      registration({ id: "pay1", stripePaymentId: "pi_123", amount: 100, currency: "USD" }),
    );
    stripeRefundsCreate.mockRejectedValue(new Error("stripe down"));
    const res = await POST(req(), { params });
    expect(res.status).toBe(502);
    expect(mockDb.registration.update).toHaveBeenCalledWith({
      where: { id: "reg1" },
      data: { paymentStatus: "PAID" },
    });
  });
});

describe("refund — guards", () => {
  it("400 when the registration is not PAID", async () => {
    mockDb.registration.findUnique.mockResolvedValue(registration(null, { paymentStatus: "UNPAID" }));
    const res = await POST(req(), { params });
    expect(res.status).toBe(400);
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
});
