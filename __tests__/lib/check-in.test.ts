/**
 * Check-in core (review H9) — src/lib/check-in.ts is the single home for the
 * check-in business gates + commit fan-out, shared by the two REST handlers
 * and the MCP tool. These pin the gate truth table (the exact rules the desk
 * enforced) and executeCheckIn's contracts: audit is fire-and-forget (an
 * insert blip never fails a committed check-in — review M13 for these
 * routes), and the CANCELLED-override path runs the seat/promo transition
 * inside the same transaction as the row update.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApplyTransition, mockNotify } = vi.hoisted(() => ({
  mockDb: {
    registration: { update: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  mockApplyTransition: vi.fn().mockResolvedValue(undefined),
  mockNotify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: mockNotify }));
vi.mock("@/lib/registration-seat-db", () => ({
  applyRegistrationTransition: mockApplyTransition,
}));

import { checkInGate, executeCheckIn } from "@/lib/check-in";

const base = {
  status: "CONFIRMED",
  paymentStatus: "PAID",
  checkedInAt: null as Date | null,
  ticketTypePrice: 100,
  pricingTierPrice: null as number | null,
};

describe("checkInGate — the desk truth table", () => {
  it("PAID confirmed → allowed", () => {
    expect(checkInGate(base)).toBeNull();
  });

  it("CANCELLED → blocked (code CANCELLED)", () => {
    expect(checkInGate({ ...base, status: "CANCELLED" })).toMatchObject({ code: "CANCELLED" });
  });

  it("CANCELLED + allowCancelled → passes the cancel gate", () => {
    expect(checkInGate({ ...base, status: "CANCELLED" }, { allowCancelled: true })).toBeNull();
  });

  it("UNPAID and PENDING → PAYMENT_REQUIRED", () => {
    expect(checkInGate({ ...base, paymentStatus: "UNPAID" })).toMatchObject({ code: "PAYMENT_REQUIRED" });
    expect(checkInGate({ ...base, paymentStatus: "PENDING" })).toMatchObject({ code: "PAYMENT_REQUIRED" });
  });

  it("UNPAID but COMPLIMENTARY status / free ticket / free tier → allowed", () => {
    expect(checkInGate({ ...base, paymentStatus: "COMPLIMENTARY" })).toBeNull();
    expect(checkInGate({ ...base, paymentStatus: "UNPAID", ticketTypePrice: 0 })).toBeNull();
    expect(
      checkInGate({ ...base, paymentStatus: "UNPAID", ticketTypePrice: 100, pricingTierPrice: 0 }),
    ).toBeNull();
  });

  it("already checked in → ALREADY_CHECKED_IN with the original timestamp", () => {
    const when = new Date("2026-07-10T08:00:00Z");
    expect(checkInGate({ ...base, checkedInAt: when })).toMatchObject({
      code: "ALREADY_CHECKED_IN",
      checkedInAt: when,
    });
  });

  it("UNPAID takes precedence over already-checked-in (REST gate order preserved)", () => {
    const when = new Date();
    expect(
      checkInGate({ ...base, paymentStatus: "UNPAID", checkedInAt: when }),
    ).toMatchObject({ code: "PAYMENT_REQUIRED" });
  });
});

describe("executeCheckIn", () => {
  const UPDATED = {
    id: "reg1",
    checkedInAt: new Date(),
    attendee: { firstName: "A", lastName: "B" },
    ticketType: { name: "Std" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.registration.update.mockResolvedValue(UPDATED);
    mockDb.auditLog.create.mockResolvedValue({});
    mockDb.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) =>
      cb({ registration: { update: mockDb.registration.update } }),
    );
  });

  it("plain check-in: updates the row, audits with source, notifies", async () => {
    const res = await executeCheckIn({
      eventId: "ev1",
      registrationId: "reg1",
      actorUserId: "u1",
      attendeeName: "A B",
      source: "rest",
      auditExtras: { ip: "1.2.3.4" },
    });
    expect(res).toBe(UPDATED);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockApplyTransition).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "CHECK_IN",
          userId: "u1",
          changes: expect.objectContaining({ source: "rest", ip: "1.2.3.4" }),
        }),
      }),
    );
    expect(mockNotify).toHaveBeenCalled();
  });

  it("a failed audit insert never fails the committed check-in (M13)", async () => {
    mockDb.auditLog.create.mockRejectedValue(new Error("P2024 pool timeout"));
    await expect(
      executeCheckIn({
        eventId: "ev1",
        registrationId: "reg1",
        actorUserId: "u1",
        attendeeName: "A B",
        source: "rest",
      }),
    ).resolves.toBe(UPDATED);
  });

  it("reactivation path runs the seat/promo transition INSIDE the tx with the update", async () => {
    const reactivation = {
      prev: { status: "CANCELLED", attendanceMode: "IN_PERSON", ticketTypeId: "tt1", pricingTierId: null, createdSource: null },
      next: { status: "CHECKED_IN", attendanceMode: "IN_PERSON", ticketTypeId: "tt1", pricingTierId: null, createdSource: null },
      promoCodeId: "promo1",
    } as never;
    await executeCheckIn({
      eventId: "ev1",
      registrationId: "reg1",
      actorUserId: "u1",
      attendeeName: "A B",
      source: "mcp",
      reactivation,
    });
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(mockApplyTransition).toHaveBeenCalledWith(expect.anything(), reactivation);
  });

  it("CAPACITY_EXCEEDED from the transition propagates (caller maps it)", async () => {
    mockApplyTransition.mockRejectedValueOnce(new Error("CAPACITY_EXCEEDED"));
    await expect(
      executeCheckIn({
        eventId: "ev1",
        registrationId: "reg1",
        actorUserId: null,
        attendeeName: "A B",
        source: "mcp",
        reactivation: {
          prev: { status: "CANCELLED", attendanceMode: "IN_PERSON", ticketTypeId: "tt1", pricingTierId: null, createdSource: null },
          next: { status: "CHECKED_IN", attendanceMode: "IN_PERSON", ticketTypeId: "tt1", pricingTierId: null, createdSource: null },
          promoCodeId: null,
        } as never,
      }),
    ).rejects.toThrow("CAPACITY_EXCEEDED");
  });
});
