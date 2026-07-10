/**
 * MCP check_in_registration — desk parity (review H9). The executor used to
 * skip the payment gate (an agent "check everyone in" admitted UNPAID
 * attendees the desk refused), wrote no AuditLog row, and its allowCancelled
 * override reactivated via a raw update outside the seat/promo transition.
 * These pin the executor against the REAL check-in core (checkInGate +
 * executeCheckIn real; db + seat applier mocked).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApplyTransition } = vi.hoisted(() => ({
  mockDb: {
    registration: { findFirst: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  },
  mockApplyTransition: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/registration-seat-db", () => ({
  applyRegistrationTransition: mockApplyTransition,
  releaseSeats: vi.fn(),
  claimSeat: vi.fn(),
  releaseSeat: vi.fn(),
}));

import { REGISTRATION_EXECUTORS } from "@/lib/agent/tools/registrations";

const checkIn = REGISTRATION_EXECUTORS.check_in_registration;
const ctx = { eventId: "ev1", organizationId: "org1", userId: "u1", counters: { creates: 0, emailsSent: 0 } };

function regRow(over: Record<string, unknown> = {}) {
  return {
    id: "reg1", status: "CONFIRMED", paymentStatus: "PAID", checkedInAt: null,
    attendanceMode: "IN_PERSON", ticketTypeId: "tt1", pricingTierId: null,
    createdSource: null, promoCodeId: null,
    ticketType: { price: 100 }, pricingTier: null,
    attendee: { firstName: "A", lastName: "B" },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.registration.update.mockResolvedValue({
    id: "reg1", checkedInAt: new Date(), attendee: { firstName: "A", lastName: "B" }, ticketType: {},
  });
  mockDb.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) =>
    cb({ registration: { update: mockDb.registration.update } }),
  );
});

describe("MCP check_in_registration — desk parity (H9)", () => {
  it("refuses UNPAID with PAYMENT_REQUIRED and writes nothing (the desk gate)", async () => {
    mockDb.registration.findFirst.mockResolvedValue(regRow({ paymentStatus: "UNPAID" }));
    const res = await checkIn({ registrationId: "reg1" }, ctx);
    expect(res).toMatchObject({ code: "PAYMENT_REQUIRED" });
    expect(mockDb.registration.update).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("lets a free-ticket UNPAID reg through (complimentary rule parity)", async () => {
    mockDb.registration.findFirst.mockResolvedValue(
      regRow({ paymentStatus: "UNPAID", ticketType: { price: 0 } }),
    );
    const res = await checkIn({ registrationId: "reg1" }, ctx);
    expect(res).toMatchObject({ success: true });
  });

  it("writes a CHECK_IN audit row (source mcp) on success", async () => {
    mockDb.registration.findFirst.mockResolvedValue(regRow());
    const res = await checkIn({ registrationId: "reg1" }, ctx);
    expect(res).toMatchObject({ success: true });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "CHECK_IN",
          userId: "u1",
          changes: expect.objectContaining({ source: "mcp" }),
        }),
      }),
    );
  });

  it("still blocks CANCELLED without the override", async () => {
    mockDb.registration.findFirst.mockResolvedValue(regRow({ status: "CANCELLED" }));
    const res = await checkIn({ registrationId: "reg1" }, ctx);
    expect(res).toMatchObject({ code: "REGISTRATION_CANCELLED" });
    expect(mockDb.registration.update).not.toHaveBeenCalled();
  });

  it("allowCancelled reactivates THROUGH the seat/promo transition inside a tx", async () => {
    mockDb.registration.findFirst.mockResolvedValue(
      regRow({ status: "CANCELLED", promoCodeId: "promo1" }),
    );
    const res = await checkIn({ registrationId: "reg1", allowCancelled: true }, ctx);
    expect(res).toMatchObject({ success: true });
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(mockApplyTransition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prev: expect.objectContaining({ status: "CANCELLED" }),
        next: expect.objectContaining({ status: "CHECKED_IN" }),
        promoCodeId: "promo1",
      }),
    );
    // Override is visible in the audit trail.
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          changes: expect.objectContaining({ allowCancelledOverride: true }),
        }),
      }),
    );
  });

  it("maps a sold-out reactivation to CAPACITY_EXCEEDED", async () => {
    mockDb.registration.findFirst.mockResolvedValue(regRow({ status: "CANCELLED" }));
    mockApplyTransition.mockRejectedValueOnce(new Error("CAPACITY_EXCEEDED"));
    const res = await checkIn({ registrationId: "reg1", allowCancelled: true }, ctx);
    expect(res).toMatchObject({ code: "CAPACITY_EXCEEDED" });
  });

  it("keeps the friendly alreadyCheckedIn early-return", async () => {
    const when = new Date("2026-07-10T08:00:00Z");
    mockDb.registration.findFirst.mockResolvedValue(regRow({ checkedInAt: when }));
    const res = await checkIn({ registrationId: "reg1" }, ctx);
    expect(res).toMatchObject({ alreadyCheckedIn: true, checkedInAt: when });
  });
});
