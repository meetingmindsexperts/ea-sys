/**
 * Issue-Credit-Note route — the organizer action that precedes a refund.
 * Full or partial amount, optional email, org-scoped, finance-gated. Maps
 * CreditNoteAmountError (over-limit / non-positive) to a 400.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, createCreditNoteSpy, sendInvoiceEmailSpy, CreditNoteAmountError } = vi.hoisted(() => {
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
      event: { findFirst: vi.fn() },
      registration: { findUnique: vi.fn() },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    },
    mockAuth: vi.fn(),
    createCreditNoteSpy: vi.fn(),
    sendInvoiceEmailSpy: vi.fn().mockResolvedValue(undefined),
    CreditNoteAmountError,
  };
});

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/invoice-service", () => ({
  createCreditNote: createCreditNoteSpy,
  sendInvoiceEmail: sendInvoiceEmailSpy,
  CreditNoteAmountError,
}));
// denyReviewer, denyFinance, buildEventAccessWhere, security are REAL (pure).

import { POST } from "@/app/api/events/[eventId]/registrations/[registrationId]/credit-notes/route";

const params = Promise.resolve({ eventId: "ev1", registrationId: "reg1" });
const req = (body?: unknown) =>
  new Request("http://localhost/x", {
    method: "POST",
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  mockDb.registration.findUnique.mockResolvedValue({ id: "reg1", eventId: "ev1", paymentStatus: "PAID" });
  mockDb.auditLog.create.mockResolvedValue({});
  createCreditNoteSpy.mockResolvedValue({
    invoice: { id: "cn1", invoiceNumber: "MM-CN-001", total: 105, currency: "USD" },
    created: true,
    creditedAfter: 105,
    paidTotal: 105,
  });
});

describe("credit-notes: happy paths", () => {
  it("issues a full credit note (no amount) and returns the running figures", async () => {
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      creditNoteId: "cn1", invoiceNumber: "MM-CN-001", amount: 105, currency: "USD",
      creditedAfter: 105, paidTotal: 105, emailed: false,
    });
    expect(createCreditNoteSpy).toHaveBeenCalledWith(expect.objectContaining({ registrationId: "reg1", eventId: "ev1", amount: undefined }));
    expect(sendInvoiceEmailSpy).not.toHaveBeenCalled();
  });

  it("passes a partial amount through", async () => {
    createCreditNoteSpy.mockResolvedValue({ invoice: { id: "cn2", invoiceNumber: "MM-CN-002", total: 40, currency: "USD" }, created: true, creditedAfter: 40, paidTotal: 105 });
    const res = await POST(req({ amount: 40 }), { params });
    expect(res.status).toBe(200);
    expect((await res.json()).amount).toBe(40);
    expect(createCreditNoteSpy).toHaveBeenCalledWith(expect.objectContaining({ amount: 40 }));
  });

  it("emails the credit note when send=true", async () => {
    const res = await POST(req({ send: true }), { params });
    expect(res.status).toBe(200);
    expect((await res.json()).emailed).toBe(true);
    expect(sendInvoiceEmailSpy).toHaveBeenCalledWith("cn1");
  });

  it("writes an audit log entry", async () => {
    await POST(req(), { params });
    await flush();
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "CREDIT_NOTE_ISSUED", entityId: "reg1" }) }),
    );
  });
});

describe("credit-notes: guards", () => {
  it("maps CREDIT_LIMIT_EXCEEDED to 400 with meta", async () => {
    createCreditNoteSpy.mockRejectedValue(
      new CreditNoteAmountError("CREDIT_LIMIT_EXCEEDED", "over", { paidTotal: 105, creditedBefore: 100, outstanding: 5, currency: "USD" }),
    );
    const res = await POST(req({ amount: 50 }), { params });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("CREDIT_LIMIT_EXCEEDED");
    expect(body.outstanding).toBe(5);
  });

  it("400 when the registration is not paid", async () => {
    mockDb.registration.findUnique.mockResolvedValue({ id: "reg1", eventId: "ev1", paymentStatus: "UNPAID" });
    const res = await POST(req(), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NOT_PAID");
    expect(createCreditNoteSpy).not.toHaveBeenCalled();
  });

  it("404 when the registration belongs to another event", async () => {
    mockDb.registration.findUnique.mockResolvedValue({ id: "reg1", eventId: "other", paymentStatus: "PAID" });
    const res = await POST(req(), { params });
    expect(res.status).toBe(404);
  });

  it("404 when the event is not accessible", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await POST(req(), { params });
    expect(res.status).toBe(404);
  });

  it("400 on a negative amount (schema)", async () => {
    const res = await POST(req({ amount: -5 }), { params });
    expect(res.status).toBe(400);
    expect(createCreditNoteSpy).not.toHaveBeenCalled();
  });

  it("401 unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(req(), { params });
    expect(res.status).toBe(401);
  });

  it("403 for MEMBER (finance-gated)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", organizationId: "org1" } });
    const res = await POST(req(), { params });
    expect(res.status).toBe(403);
  });

  it("403 for REVIEWER", async () => {
    mockAuth.mockResolvedValue({ user: { id: "r1", role: "REVIEWER", organizationId: "org1" } });
    const res = await POST(req(), { params });
    expect(res.status).toBe(403);
  });
});
