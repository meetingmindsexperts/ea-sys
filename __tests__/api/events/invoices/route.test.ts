import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockAuth, mockDenyReviewer, mockDb, mockCreateInvoice } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDenyReviewer: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    invoice: { findMany: vi.fn() },
  },
  mockCreateInvoice: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual };
});
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth-guards", () => ({ denyReviewer: mockDenyReviewer }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("@/lib/invoice-service", () => ({
  createInvoice: mockCreateInvoice,
}));

import { GET, POST } from "@/app/api/events/[eventId]/invoices/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeParams(eventId = "evt-1") {
  return { params: Promise.resolve({ eventId }) };
}

const adminSession = {
  user: { id: "user-1", role: "ADMIN", organizationId: "org-1" },
};

const reviewerSession = {
  user: { id: "user-2", role: "REVIEWER", organizationId: null },
};

// ── GET tests ────────────────────────────────────────────────────────────────

describe("GET /api/events/[eventId]/invoices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDenyReviewer.mockReturnValue(null);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = new Request("http://localhost/api/events/evt-1/invoices");
    const res = await GET(req, makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 404 when event not found", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const req = new Request("http://localhost/api/events/evt-1/invoices");
    const res = await GET(req, makeParams());
    expect(res.status).toBe(404);
  });

  it("returns invoice list for valid request", async () => {
    const invoices = [
      { id: "inv-1", type: "INVOICE", invoiceNumber: "INV-2026-0001", status: "SENT" },
      { id: "rec-1", type: "RECEIPT", invoiceNumber: "REC-2026-0001", status: "PAID" },
    ];
    mockDb.invoice.findMany.mockResolvedValue(invoices);

    const req = new Request("http://localhost/api/events/evt-1/invoices");
    const res = await GET(req, makeParams());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body[0].invoiceNumber).toBe("INV-2026-0001");
  });

  it("passes type filter to query", async () => {
    mockDb.invoice.findMany.mockResolvedValue([]);
    const req = new Request("http://localhost/api/events/evt-1/invoices?type=RECEIPT");
    await GET(req, makeParams());

    expect(mockDb.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ type: "RECEIPT" }),
      })
    );
  });

  it("passes status filter to query", async () => {
    mockDb.invoice.findMany.mockResolvedValue([]);
    const req = new Request("http://localhost/api/events/evt-1/invoices?status=PAID");
    await GET(req, makeParams());

    expect(mockDb.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "PAID" }),
      })
    );
  });
});

// ── POST tests ───────────────────────────────────────────────────────────────

describe("POST /api/events/[eventId]/invoices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDenyReviewer.mockReturnValue(null);
    mockCreateInvoice.mockResolvedValue({
      id: "inv-1", type: "INVOICE", invoiceNumber: "INV-2026-0001", status: "SENT",
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = new Request("http://localhost/api/events/evt-1/invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registrationId: "reg-1" }),
    });
    const res = await POST(req, makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 403 for reviewer role", async () => {
    mockAuth.mockResolvedValue(reviewerSession);
    const forbiddenResponse = new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
    mockDenyReviewer.mockReturnValue(forbiddenResponse);

    const req = new Request("http://localhost/api/events/evt-1/invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registrationId: "reg-1" }),
    });
    const res = await POST(req, makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 400 for missing registrationId", async () => {
    const req = new Request("http://localhost/api/events/evt-1/invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await POST(req, makeParams());
    expect(res.status).toBe(400);
  });

  it("creates invoice for valid request", async () => {
    const req = new Request("http://localhost/api/events/evt-1/invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registrationId: "reg-1" }),
    });
    const res = await POST(req, makeParams());
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.invoiceNumber).toBe("INV-2026-0001");
  });

  it("calls createInvoice with correct params", async () => {
    const req = new Request("http://localhost/api/events/evt-1/invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registrationId: "reg-1" }),
    });
    await POST(req, makeParams());

    expect(mockCreateInvoice).toHaveBeenCalledWith({
      registrationId: "reg-1",
      eventId: "evt-1",
      organizationId: "org-1",
      dueDate: undefined,
    });
  });
});
