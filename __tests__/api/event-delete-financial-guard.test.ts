/**
 * Data-loss guard on event DELETE: every Invoice (eventId) + Payment (via its
 * registration) cascade-deletes with the event. The route must BLOCK (409
 * EVENT_HAS_FINANCIAL_RECORDS) when any exist AND write a DELETE_BLOCKED audit
 * snapshot. A financially-empty event still deletes normally.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn(), delete: vi.fn().mockResolvedValue({}) },
    invoice: { count: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    payment: { count: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  mockAuth: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/event-access", () => ({ buildEventAccessWhere: () => ({ id: "ev1" }) }));

import { DELETE } from "@/app/api/events/[eventId]/route";

const params = Promise.resolve({ eventId: "ev1" });
const session = { user: { id: "u1", role: "ORGANIZER", organizationId: "org1" } };
const delReq = () => new Request("http://localhost/api/events/ev1?confirm=true", { method: "DELETE" });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(session);
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", name: "Test Event" });
  mockDb.invoice.count.mockResolvedValue(0);
  mockDb.payment.count.mockResolvedValue(0);
  mockDb.invoice.findMany.mockResolvedValue([]);
});

describe("event DELETE — financial-records guard", () => {
  it("blocks (409) when invoices exist and does NOT delete", async () => {
    mockDb.invoice.count.mockResolvedValue(3);
    mockDb.invoice.findMany.mockResolvedValue([
      { invoiceNumber: "EVT-INV-003" },
      { invoiceNumber: "EVT-INV-002" },
      { invoiceNumber: "EVT-INV-001" },
    ]);

    const res = await DELETE(delReq(), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("EVENT_HAS_FINANCIAL_RECORDS");
    expect(body.invoiceCount).toBe(3);
    expect(mockDb.event.delete).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "DELETE_BLOCKED", entityType: "Event" }),
      }),
    );
  });

  it("blocks (409) when payments exist (even with no invoices)", async () => {
    mockDb.payment.count.mockResolvedValue(5);

    const res = await DELETE(delReq(), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.paymentCount).toBe(5);
    expect(mockDb.event.delete).not.toHaveBeenCalled();
  });

  it("deletes normally when there are no financial records", async () => {
    const res = await DELETE(delReq(), { params });

    expect(res.status).toBe(200);
    expect(mockDb.event.delete).toHaveBeenCalledWith({ where: { id: "ev1" } });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "DELETE", entityType: "Event" }) }),
    );
  });
});
