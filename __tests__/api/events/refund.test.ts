import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockAuth, mockDb, mockApiLogger, mockStripeRefundsCreate, mockStripeInstance } = vi.hoisted(() => {
  const mockStripeRefundsCreate = vi.fn();
  const mockStripeInstance = { refunds: { create: mockStripeRefundsCreate } };
  return {
    mockAuth: vi.fn(),
    mockDb: {
      event: { findFirst: vi.fn() },
      registration: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
      payment: { update: vi.fn() },
    },
    mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    mockStripeRefundsCreate,
    mockStripeInstance,
  };
});

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
}));
vi.mock("@/lib/event-access", () => ({
  buildEventAccessWhere: vi.fn(() => ({ organizationId: "org-1" })),
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: vi.fn(() => mockStripeInstance),
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
  attendee: { firstName: "Alice", lastName: "Smith", email: "alice@example.com" },
  ticketType: { name: "Standard", currency: "USD" },
  pricingTier: null,
  event: { id: "evt-1", name: "Test Conference", startDate: new Date("2026-06-01") },
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
    mockDb.registration.findUnique.mockResolvedValue(null);
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "Registration not found" });
  });

  it("returns 404 when registration belongs to different event", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
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

  it("returns 400 when no Stripe payment record exists", async () => {
    mockDb.registration.findUnique.mockResolvedValue({ ...sampleRegistration, payments: [] });
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "No Stripe payment found for this registration" });
  });

  it("returns 400 when payment has no stripePaymentId", async () => {
    mockDb.registration.findUnique.mockResolvedValue({
      ...sampleRegistration,
      payments: [{ id: "pay-1", stripePaymentId: null, amount: 150, currency: "USD" }],
    });
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(400);
  });
});

describe("Refund: optimistic lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.registration.findUnique.mockResolvedValue(sampleRegistration);
  });

  it("returns 409 when concurrent request already acquired the lock", async () => {
    // updateMany returns count=0 — another request beat us to it
    mockDb.registration.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "Registration is no longer in a paid state" });
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
    mockDb.registration.findUnique.mockResolvedValue(sampleRegistration);
    mockDb.registration.updateMany.mockResolvedValue({ count: 1 });
    mockDb.registration.update.mockResolvedValue({});
  });

  it("rolls back registration status to PAID when Stripe fails", async () => {
    mockStripeRefundsCreate.mockRejectedValue(new Error("Stripe error: card_declined"));
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(502);
    // Rollback: registration.update called to restore PAID status
    expect(mockDb.registration.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { paymentStatus: "PAID" } })
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
    mockDb.registration.findUnique.mockResolvedValue(sampleRegistration);
    mockDb.registration.updateMany.mockResolvedValue({ count: 1 });
    mockStripeRefundsCreate.mockResolvedValue({ id: "re_test123", status: "succeeded" });
    mockDb.payment.update.mockResolvedValue({});
  });

  it("passes idempotency key derived from payment id", async () => {
    await POST(makeRequest(), makeParams());
    expect(mockStripeRefundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_test123" }),
      expect.objectContaining({ idempotencyKey: "refund-pay-1" })
    );
  });
});

describe("Refund: success path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
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

  it("updates payment record to REFUNDED", async () => {
    await POST(makeRequest(), makeParams());
    expect(mockDb.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "REFUNDED" } })
    );
  });

  it("logs the successful refund with issuedBy", async () => {
    await POST(makeRequest(), makeParams());
    expect(mockApiLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Refund issued", issuedBy: "user-1" })
    );
  });
});
