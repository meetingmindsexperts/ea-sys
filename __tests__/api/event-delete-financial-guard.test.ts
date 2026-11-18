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
    dtcmOrder: { count: vi.fn() },
    externalStream: { findMany: vi.fn().mockResolvedValue([]) },
    zoomMeeting: { findMany: vi.fn().mockResolvedValue([]) },
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
import { getTenantOrgId } from "@/lib/tenant-context";

const params = Promise.resolve({ eventId: "ev1" });
const session = { user: { id: "u1", role: "ORGANIZER", organizationId: "org1" } };
const delReq = () => new Request("http://localhost/api/events/ev1?confirm=true", { method: "DELETE" });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(session);
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", name: "Test Event" });
  mockDb.invoice.count.mockResolvedValue(0);
  mockDb.payment.count.mockResolvedValue(0);
  mockDb.dtcmOrder.count.mockResolvedValue(0);
  mockDb.invoice.findMany.mockResolvedValue([]);
  mockDb.zoomMeeting.findMany.mockResolvedValue([]);
  mockDb.externalStream.findMany.mockResolvedValue([]);
  mockDb.auditLog.create.mockResolvedValue({});
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

describe("event DELETE: DET tickets guard", () => {
  it("blocks (409) while the event holds bought, uncertain or pending DET tickets", async () => {
    mockDb.dtcmOrder.count.mockResolvedValue(2);

    const res = await DELETE(delReq(), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("EVENT_HAS_DTCM_TICKETS");
    expect(body.liveDtcmTickets).toBe(2);
    expect(mockDb.dtcmOrder.count).toHaveBeenCalledWith({
      where: { eventId: "ev1", environment: "production", status: { in: ["PURCHASED", "UNCERTAIN", "PENDING"] } },
    });
    expect(mockDb.event.delete).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "DELETE_BLOCKED", changes: expect.objectContaining({ reason: "has-dtcm-tickets" }) }) }),
    );
  });
});

describe("event DELETE: every read that guards the delete is made inside the organisation's lane", () => {
  // Invoice, Payment, DtcmOrder and ExternalStream carry a row policy. A count
  // made outside a tenant lane reads 0 under row security, so the guard let
  // the delete through and the financial records went with the event (proven
  // on Nov 18, 2026 by e2e/event-delete-guard.spec.ts under `npm run e2e:rls`).
  // That run is not part of the gate; this is. The mocks answer with the lane
  // they were called in.
  const laneOf = (mock: { mockImplementation: (fn: () => Promise<unknown>) => unknown }, seen: Record<string, unknown>, name: string, answer: unknown) =>
    mock.mockImplementation(async () => {
      seen[name] = getTenantOrgId() ?? "NO LANE";
      return answer;
    });

  it("the counts, the partner stream read and the audit record of a delete that goes through", async () => {
    const seen: Record<string, unknown> = {};
    laneOf(mockDb.invoice.count, seen, "invoice.count", 0);
    laneOf(mockDb.payment.count, seen, "payment.count", 0);
    laneOf(mockDb.dtcmOrder.count, seen, "dtcmOrder.count", 0);
    laneOf(mockDb.externalStream.findMany, seen, "externalStream.findMany", []);
    laneOf(mockDb.auditLog.create, seen, "auditLog.create", {});

    const res = await DELETE(delReq(), { params });
    await new Promise((resolve) => setTimeout(resolve, 0)); // the audit record is not awaited

    expect(res.status).toBe(200);
    expect(seen).toEqual({
      "invoice.count": "org1",
      "payment.count": "org1",
      "dtcmOrder.count": "org1",
      "externalStream.findMany": "org1",
      "auditLog.create": "org1",
    });
  });

  it("the invoice list and the audit record of a delete that is refused", async () => {
    const seen: Record<string, unknown> = {};
    mockDb.invoice.count.mockResolvedValue(2);
    laneOf(mockDb.invoice.findMany, seen, "invoice.findMany", [{ invoiceNumber: "EVT-INV-001" }]);
    laneOf(mockDb.auditLog.create, seen, "auditLog.create", {});

    const res = await DELETE(delReq(), { params });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toBe(409);
    expect(seen).toEqual({ "invoice.findMany": "org1", "auditLog.create": "org1" });
  });
});
