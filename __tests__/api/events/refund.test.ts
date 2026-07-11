import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockAuth, mockDb, mockApiLogger, mockStripeRefundsCreate, mockStripeRefundsList, mockStripeInstance } = vi.hoisted(() => {
  const mockStripeRefundsCreate = vi.fn();
  const mockStripeRefundsList = vi.fn();
  const mockStripeInstance = { refunds: { create: mockStripeRefundsCreate, list: mockStripeRefundsList } };
  return {
    mockAuth: vi.fn(),
    mockDb: {
      event: { findFirst: vi.fn() },
      registration: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
      payment: { update: vi.fn() },
      invoice: { findFirst: vi.fn(), findMany: vi.fn() },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      refundAttempt: { create: vi.fn(), update: vi.fn() },
      $transaction: vi.fn(),
    },
    mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    mockStripeRefundsCreate,
    mockStripeRefundsList,
    mockStripeInstance,
  };
});

// Implementations survive vi.clearAllMocks() (it clears call history only), so
// these defaults hold across every describe's own beforeEach:
// - verification (verify-before-rollback) sees Stripe reachable + refund absent;
// - the claim+attempt transaction routes to the shared mocks.
mockStripeRefundsList.mockResolvedValue({ data: [] });
mockDb.refundAttempt.create.mockResolvedValue({ id: "att-1" });
mockDb.refundAttempt.update.mockResolvedValue({});
mockDb.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
  cb({
    registration: { updateMany: mockDb.registration.updateMany },
    refundAttempt: { create: mockDb.refundAttempt.create },
  }),
);

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/auth-guards", () => ({
  denyReviewer: vi.fn((session: { user: { role: string } }) => {
    if (["REVIEWER", "SUBMITTER"].includes(session.user.role)) {
      return { status: 403, json: async () => ({ error: "Forbidden" }) };
    }
    return null;
  }),
  // M7: the refund route is finance-gated too now.
  denyFinance: vi.fn(() => null),
}));
vi.mock("@/lib/security", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true })),
  getClientIp: vi.fn(() => "127.0.0.1"),
}));
vi.mock("@/lib/event-access", () => ({
  buildEventAccessWhere: vi.fn(() => ({ organizationId: "org-1" })),
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: vi.fn(() => mockStripeInstance),
  toStripeAmount: (amount: number) => Math.round(amount * 100),
}));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(),
  getEventTemplate: vi.fn().mockResolvedValue(null),
  getDefaultTemplate: vi.fn().mockReturnValue(null),
  renderAndWrap: vi.fn().mockReturnValue({ subject: "Refund", htmlContent: "", textContent: "" }),
  brandingFrom: vi.fn().mockReturnValue({}),
}));
vi.mock("@/lib/notifications", () => ({
  notifyEventAdmins: vi.fn().mockResolvedValue(undefined),
}));
import { POST } from "@/app/api/events/[eventId]/registrations/[registrationId]/refund/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeParams(eventId = "evt-1", registrationId = "reg-1") {
  return { params: Promise.resolve({ eventId, registrationId }) };
}

function makeRequest() {
  return new Request("http://localhost/api/events/evt-1/registrations/reg-1/refund", { method: "POST" });
}

const adminSession = { user: { id: "user-1", role: "ADMIN", organizationId: "org-1" } };
const reviewerSession = { user: { id: "rev-1", role: "REVIEWER", organizationId: null } };

const sampleRegistration = {
  id: "reg-1",
  eventId: "evt-1",
  paymentStatus: "PAID",
  refundedAmount: 0,
  originalPrice: 150,
  discountAmount: null,
  attendee: { firstName: "Alice", lastName: "Smith", email: "alice@example.com", additionalEmail: null, title: null },
  ticketType: { name: "Standard", price: 150, currency: "USD" },
  pricingTier: null,
  event: { id: "evt-1", name: "Test Conference", startDate: new Date("2026-06-01"), taxRate: null, taxLabel: null },
  payments: [{ id: "pay-1", stripePaymentId: "pi_test123", amount: 150, currency: "USD" }],
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Refund: authentication", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "Unauthorized" });
  });

  it("returns 403 for REVIEWER role", async () => {
    mockAuth.mockResolvedValue(reviewerSession);
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(403);
  });
});

describe("Refund: not found cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession);
  });

  it("returns 404 when event not found", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    mockDb.registration.findUnique.mockResolvedValue(sampleRegistration);
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "Event not found" });
  });

  it("returns 404 when registration not found", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.invoice.findFirst.mockResolvedValue({ id: "cn1" }); // credit note exists (gate open)
    mockDb.invoice.findMany.mockResolvedValue([{ total: 100000 }]); // amount gate open (July 11)
    mockDb.registration.findUnique.mockResolvedValue(null);
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "Registration not found" });
  });

  it("returns 404 when registration belongs to different event", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.invoice.findFirst.mockResolvedValue({ id: "cn1" }); // credit note exists (gate open)
    mockDb.invoice.findMany.mockResolvedValue([{ total: 100000 }]); // amount gate open (July 11)
    mockDb.registration.findUnique.mockResolvedValue({ ...sampleRegistration, eventId: "evt-other" });
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(404);
  });
});

describe("Refund: business rule validations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.invoice.findFirst.mockResolvedValue({ id: "cn1" }); // credit note exists (gate open)
    mockDb.invoice.findMany.mockResolvedValue([{ total: 100000 }]); // amount gate open (July 11)
  });

  it("returns 400 when registration is not PAID", async () => {
    mockDb.registration.findUnique.mockResolvedValue({ ...sampleRegistration, paymentStatus: "UNPAID" });
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Registration is not in a paid state" });
  });

  it("returns 400 when registration has REFUNDED status", async () => {
    mockDb.registration.findUnique.mockResolvedValue({ ...sampleRegistration, paymentStatus: "REFUNDED" });
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(400);
  });

  // Manual/offline refund (option A): a PAID reg with no payment row (admin
  // hand-flipped) or a payment with no stripePaymentId (cash/bank/card-onsite)
  // is refundable WITHOUT Stripe — it used to 400 "No Stripe payment found".
  it("records a manual/offline refund when there's no payment row (hand-flipped PAID)", async () => {
    mockDb.registration.findUnique.mockResolvedValue({ ...sampleRegistration, originalPrice: 150, payments: [] });
    mockDb.registration.updateMany.mockResolvedValue({ count: 1 });
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(200);
    expect((await res.json()).manual).toBe(true);
    expect(mockStripeRefundsCreate).not.toHaveBeenCalled();
    expect(mockDb.payment.update).not.toHaveBeenCalled(); // nothing to flip
  });

  it("records a manual/offline refund when the payment has no stripePaymentId (cash/bank/card-onsite)", async () => {
    mockDb.registration.findUnique.mockResolvedValue({
      ...sampleRegistration,
      payments: [{ id: "pay-1", stripePaymentId: null, amount: 150, currency: "USD" }],
    });
    mockDb.registration.updateMany.mockResolvedValue({ count: 1 });
    mockDb.payment.update.mockResolvedValue({});
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(200);
    expect((await res.json()).manual).toBe(true);
    expect(mockStripeRefundsCreate).not.toHaveBeenCalled();
    expect(mockDb.payment.update).toHaveBeenCalledWith({ where: { id: "pay-1" }, data: { refundedAmount: 150, status: "REFUNDED" } });
  });
});

describe("Refund: optimistic lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.invoice.findFirst.mockResolvedValue({ id: "cn1" }); // credit note exists (gate open)
    mockDb.invoice.findMany.mockResolvedValue([{ total: 100000 }]); // amount gate open (July 11)
    mockDb.registration.findUnique.mockResolvedValue(sampleRegistration);
  });

  it("returns 409 when concurrent request already acquired the lock", async () => {
    // updateMany returns count=0 — another request beat us to it
    mockDb.registration.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "A refund for this registration is already in progress." });
  });

  it("proceeds when lock is acquired (count=1)", async () => {
    mockDb.registration.updateMany.mockResolvedValue({ count: 1 });
    mockStripeRefundsCreate.mockResolvedValue({ id: "re_test123", status: "succeeded" });
    mockDb.payment.update.mockResolvedValue({});
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refundId).toBe("re_test123");
    expect(body.status).toBe("succeeded");
  });
});

describe("Refund: Stripe error rollback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.invoice.findFirst.mockResolvedValue({ id: "cn1" }); // credit note exists (gate open)
    mockDb.invoice.findMany.mockResolvedValue([{ total: 100000 }]); // amount gate open (July 11)
    mockDb.registration.findUnique.mockResolvedValue(sampleRegistration);
    mockDb.registration.updateMany.mockResolvedValue({ count: 1 });
    mockDb.registration.update.mockResolvedValue({});
  });

  it("rolls back registration status to PAID when Stripe fails", async () => {
    mockStripeRefundsCreate.mockRejectedValue(new Error("Stripe error: card_declined"));
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(502);
    // Rollback is now a CONDITIONAL updateMany (verify-before-rollback flow):
    // restores PAID + the prior refunded total, guarded on our booked value.
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ paymentStatus: "PAID" }) })
    );
  });

  it("returns generic error message — does not leak Stripe error details", async () => {
    mockStripeRefundsCreate.mockRejectedValue(new Error("Stripe internal error xyz"));
    const res = await POST(makeRequest(), makeParams());
    const body = await res.json();
    expect(body.error).not.toContain("Stripe internal error");
    expect(body.error).toContain("Refund could not be processed");
  });

  it("logs the Stripe error", async () => {
    mockStripeRefundsCreate.mockRejectedValue(new Error("Stripe error"));
    await POST(makeRequest(), makeParams());
    expect(mockApiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Stripe refund failed" })
    );
  });
});

describe("Refund: idempotency key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.invoice.findFirst.mockResolvedValue({ id: "cn1" }); // credit note exists (gate open)
    mockDb.invoice.findMany.mockResolvedValue([{ total: 100000 }]); // amount gate open (July 11)
    mockDb.registration.findUnique.mockResolvedValue(sampleRegistration);
    mockDb.registration.updateMany.mockResolvedValue({ count: 1 });
    mockStripeRefundsCreate.mockResolvedValue({ id: "re_test123", status: "succeeded" });
    mockDb.payment.update.mockResolvedValue({});
  });

  it("passes the per-attempt idempotency key + verification metadata", async () => {
    await POST(makeRequest(), makeParams());
    expect(mockStripeRefundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: "pi_test123",
        metadata: { refundAttemptId: "att-1", registrationId: "reg-1" },
      }),
      expect.objectContaining({ idempotencyKey: "refund-attempt-att-1" })
    );
  });
});

describe("Refund: success path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.invoice.findFirst.mockResolvedValue({ id: "cn1" }); // credit note exists (gate open)
    mockDb.invoice.findMany.mockResolvedValue([{ total: 100000 }]); // amount gate open (July 11)
    mockDb.registration.findUnique.mockResolvedValue(sampleRegistration);
    mockDb.registration.updateMany.mockResolvedValue({ count: 1 });
    mockStripeRefundsCreate.mockResolvedValue({ id: "re_abc", status: "succeeded" });
    mockDb.payment.update.mockResolvedValue({});
  });

  it("returns refundId and status on success", async () => {
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ refundId: "re_abc", status: "succeeded" });
  });

  it("updates payment record to REFUNDED (counter + status)", async () => {
    await POST(makeRequest(), makeParams());
    expect(mockDb.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "REFUNDED" }) })
    );
  });

  it("logs the successful refund with issuedBy", async () => {
    await POST(makeRequest(), makeParams());
    expect(mockApiLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Refund issued", issuedBy: "user-1" })
    );
  });
});
