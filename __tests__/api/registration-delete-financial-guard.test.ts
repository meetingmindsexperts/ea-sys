/**
 * Data-loss guard on registration DELETE: Invoice + Payment both cascade-delete
 * from Registration, so deleting a registration with financial records would
 * silently destroy invoices/receipts/credit-notes + payment history. The route
 * must BLOCK (409 HAS_FINANCIAL_RECORDS) when any exist AND write a
 * DELETE_BLOCKED audit snapshot. A clean registration still deletes normally.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
// Row locks are Postgres FOR UPDATE; a mocked transaction cannot take them.
// Pinned against the real database in
// tests/integration-db/registration-row-lock.db.test.ts.
const { mockLockRegistrationRows } = vi.hoisted(() => ({ mockLockRegistrationRows: vi.fn(async () => undefined) }));
vi.mock("@/lib/registration-row-lock", () => ({
  lockRegistrationRows: mockLockRegistrationRows,
  lockRegistrationIfUnchanged: vi.fn(async () => "unchanged"),
}));

const { mockDb, mockAuth } = vi.hoisted(() => {
  // The delete re-reads the row under its lock; the same fixture serves both reads.
  const registrationRead = vi.fn();
  const tx = {
    registration: {
      delete: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(0),
      findUnique: (...a: unknown[]) => registrationRead(...a),
    },
    promoCode: { update: vi.fn().mockResolvedValue({}) },
    attendee: { delete: vi.fn().mockResolvedValue({}) },
    // H4: the delete tx now releases any room the person held before the DB
    // cascade removes their Accommodation row. Default: no booking.
    accommodation: { findFirst: vi.fn().mockResolvedValue(null) },
    roomType: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  return {
    mockDb: {
      event: { findFirst: vi.fn() },
      registration: { findFirst: registrationRead },
      invoice: { findMany: vi.fn() },
      payment: { findMany: vi.fn() },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
      _tx: tx,
    },
    mockAuth: vi.fn(),
  };
});

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({
  db: mockDb,
  // tenantTransaction with the flag off IS db.$transaction — delegate so the
  // test's tx interception keeps working for the migrated sites.
  tenantTransaction: (fn: (tx: unknown) => unknown) => mockDb.$transaction(fn),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/storage", () => ({ deletePhoto: vi.fn(), uploadPhoto: vi.fn() }));
vi.mock("@/lib/registration-seat-db", () => ({ releaseSeat: vi.fn(), claimSeat: vi.fn() }));
vi.mock("@/lib/registration-seat", () => ({
  holdsSeat: () => false,
  seatCounter: () => null,
  planSeatTransition: () => ({ release: null, claim: null }),
  needsQrCode: () => false,
}));

import { DELETE } from "@/app/api/events/[eventId]/registrations/[registrationId]/route";

const params = Promise.resolve({ eventId: "ev1", registrationId: "reg1" });
const session = { user: { id: "u1", role: "ORGANIZER", organizationId: "org1" } };
const delReq = () => new Request("http://localhost/x", { method: "DELETE" });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(session);
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1" });
  mockDb.registration.findFirst.mockResolvedValue({
    id: "reg1",
    eventId: "ev1",
    status: "CONFIRMED",
    attendanceMode: "IN_PERSON",
    promoCodeId: null,
    attendeeId: "att1",
    attendee: { id: "att1", photo: null },
    importedSpeakers: [],
  });
  mockDb.invoice.findMany.mockResolvedValue([]);
  mockDb.payment.findMany.mockResolvedValue([]);
});

describe("registration DELETE — financial-records guard", () => {
  it("blocks (409) when an invoice exists and does NOT delete", async () => {
    mockDb.invoice.findMany.mockResolvedValue([
      { id: "inv1", invoiceNumber: "EVT-INV-001", type: "INVOICE", status: "PAID", total: "100.00", currency: "USD" },
    ]);

    const res = await DELETE(delReq(), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("HAS_FINANCIAL_RECORDS");
    expect(body.error).toContain("EVT-INV-001");
    // No destructive delete happened.
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb._tx.registration.delete).not.toHaveBeenCalled();
    // A DELETE_BLOCKED audit snapshot was written.
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "DELETE_BLOCKED", entityType: "Registration" }),
      }),
    );
  });

  it("blocks (409) when a payment exists (even with no invoice)", async () => {
    mockDb.payment.findMany.mockResolvedValue([
      { id: "pay1", amount: "100.00", currency: "USD", status: "PAID", stripePaymentId: "pi_1", receiptUrl: null, paidAt: null, createdAt: new Date() },
    ]);

    const res = await DELETE(delReq(), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("HAS_FINANCIAL_RECORDS");
    expect(body.paymentCount).toBe(1);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("a registration deleted by someone else meanwhile is a 404, not a 500 (review of 5ca4281f)", async () => {
    // The route's first read finds it; the read under the lock does not.
    const original = mockDb.registration.findFirst.getMockImplementation();
    let calls = 0;
    mockDb.registration.findFirst.mockImplementation(async (...a: unknown[]) => (calls++ === 0 ? original?.(...a) : null));
    const res = await DELETE(delReq(), { params });
    expect(res.status).toBe(404);
    expect(mockDb._tx.registration.delete).not.toHaveBeenCalled();
  });

  it("deletes normally when there are no financial records", async () => {
    const res = await DELETE(delReq(), { params });

    expect(res.status).toBe(200);
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(mockDb._tx.registration.delete).toHaveBeenCalledWith({ where: { id: "reg1" } });
    // The normal delete audit (action DELETE) is written, not DELETE_BLOCKED.
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "DELETE" }) }),
    );
  });

  it("warn-logs stranded linked speakers but still deletes (SetNull strands the facet)", async () => {
    mockDb.registration.findFirst.mockResolvedValue({
      id: "reg1",
      eventId: "ev1",
      status: "CONFIRMED",
      attendanceMode: "IN_PERSON",
      promoCodeId: null,
      attendeeId: "att1",
      attendee: { id: "att1", photo: null },
      importedSpeakers: [{ id: "spk1", firstName: "Dina", lastName: "Ortiz" }],
    });

    const res = await DELETE(delReq(), { params });

    expect(res.status).toBe(200);
    const { apiLogger } = await import("@/lib/logger");
    expect(apiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "registration-delete:linked-speakers-stranded",
        speakerIds: ["spk1"],
      }),
    );
    expect(mockDb._tx.registration.delete).toHaveBeenCalledWith({ where: { id: "reg1" } });
  });
});
