/**
 * Unit tests for POST
 *   /api/events/[eventId]/registrations/[registrationId]/documents/resend
 * — the single-registration "resend invoice + receipt" action. Covers auth,
 * the finance/role guard, rate limiting, org-scoping, the no-paid-payment 400,
 * and the happy path (delegates to issuePaidRegistrationDocuments with the
 * PAID payment's details).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockIssueDocuments, mockCheckRateLimit } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { event: { findFirst: vi.fn() }, registration: { findFirst: vi.fn() } },
  mockIssueDocuments: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/security", () => ({ checkRateLimit: (args: unknown) => mockCheckRateLimit(args) }));
vi.mock("@/lib/auth-guards", () => ({
  denyReviewer: (session: { user?: { role?: string } } | null) => {
    const role = session?.user?.role;
    const restricted = ["REVIEWER", "SUBMITTER", "REGISTRANT", "MEMBER", "ONSITE"];
    return role && restricted.includes(role) ? { status: 403, json: async () => ({ error: "Forbidden" }) } : null;
  },
}));
vi.mock("@/lib/invoice-service", () => {
  // Local stand-in for the real class (importing the original would drag in
  // pdfkit + the whole service graph). The route resolves THIS mocked module,
  // so its `instanceof InvoiceVoidedError` check matches instances of this
  // class thrown from the test.
  class InvoiceVoidedError extends Error {
    code = "INVOICE_VOIDED" as const;
    meta: { invoiceNumber: string; invoiceStatus: string };
    constructor(meta: { invoiceNumber: string; invoiceStatus: string }) {
      super(`Invoice ${meta.invoiceNumber} is ${meta.invoiceStatus}`);
      this.name = "InvoiceVoidedError";
      this.meta = meta;
    }
  }
  return {
    issuePaidRegistrationDocuments: (args: unknown) => mockIssueDocuments(args),
    InvoiceVoidedError,
  };
});

import { POST } from "@/app/api/events/[eventId]/registrations/[registrationId]/documents/resend/route";
import { InvoiceVoidedError } from "@/lib/invoice-service";

const adminSession = { user: { id: "user-1", role: "ADMIN", organizationId: "org-1" } };
const params = { params: Promise.resolve({ eventId: "evt-1", registrationId: "reg-1" }) };
const req = () => new Request("http://localhost/api/x", { method: "POST" });

const paidPayment = {
  id: "pay-1", amount: "105.00", currency: "USD", receiptUrl: "https://stripe.test/r/1",
  paymentMethodType: "card", stripePaymentId: "pi_1", paidAt: new Date("2026-07-07"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(adminSession);
  mockCheckRateLimit.mockReturnValue({ allowed: true, remaining: 29, retryAfterSeconds: 3600 });
  mockDb.event.findFirst.mockResolvedValue({ id: "evt-1", organizationId: "org-1" });
  mockDb.registration.findFirst.mockResolvedValue({ id: "reg-1", payments: [paidPayment] });
  mockIssueDocuments.mockResolvedValue({
    invoice: { id: "inv-1", invoiceNumber: "E-INV-001" },
    receipt: { id: "rec-1", invoiceNumber: "E-REC-001" },
  });
});

describe("POST resend documents", () => {
  it("401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(req(), params);
    expect(res.status).toBe(401);
  });

  it("403 for a restricted role (REVIEWER/MEMBER/ONSITE…)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u", role: "MEMBER", organizationId: "org-1" } });
    const res = await POST(req(), params);
    expect(res.status).toBe(403);
    expect(mockIssueDocuments).not.toHaveBeenCalled();
  });

  it("429 when rate-limited", async () => {
    mockCheckRateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterSeconds: 120 });
    const res = await POST(req(), params);
    expect(res.status).toBe(429);
    expect(mockIssueDocuments).not.toHaveBeenCalled();
  });

  it("404 when the event is not in the caller's org", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await POST(req(), params);
    expect(res.status).toBe(404);
  });

  it("404 when the registration is not found", async () => {
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await POST(req(), params);
    expect(res.status).toBe(404);
  });

  it("400 NO_PAID_PAYMENT when there is no completed payment", async () => {
    mockDb.registration.findFirst.mockResolvedValue({ id: "reg-1", payments: [] });
    const res = await POST(req(), params);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NO_PAID_PAYMENT");
    expect(mockIssueDocuments).not.toHaveBeenCalled();
  });

  it("409 INVOICE_VOIDED when the payment's invoice was cancelled/refunded", async () => {
    // Prod repro: a credit note flipped the paid invoice to REFUNDED; the
    // voided row still holds the unique paymentId, so a resend must refuse
    // clearly instead of 500ing on the P2002.
    mockIssueDocuments.mockRejectedValue(
      new InvoiceVoidedError({ invoiceNumber: "4GHH2026-INV-001", invoiceStatus: "REFUNDED" }),
    );
    const res = await POST(req(), params);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("INVOICE_VOIDED");
    expect(body.error).toContain("4GHH2026-INV-001");
    expect(body.error).toContain("refunded");
  });

  it("issues the combined packet with the PAID payment's details", async () => {
    const res = await POST(req(), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.invoiceNumber).toBe("E-INV-001");
    expect(body.receiptNumber).toBe("E-REC-001");
    expect(mockIssueDocuments).toHaveBeenCalledWith({
      registrationId: "reg-1",
      eventId: "evt-1",
      organizationId: "org-1",
      paymentId: "pay-1",
      paymentMethod: "card",
      paymentReference: "pi_1",
      paidAt: new Date("2026-07-07"),
      amount: 105,
      currency: "USD",
      receiptUrl: "https://stripe.test/r/1",
    });
  });
});
