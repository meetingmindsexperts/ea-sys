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
    registration: { update: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
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

import { checkInGate, executeCheckIn, isPaymentAdmissible, undoCheckIn } from "@/lib/check-in";

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

describe("isPaymentAdmissible — badge eligibility == door admission (H1)", () => {
  const pay = (paymentStatus: string, extra: Partial<{ ticketTypePrice: unknown; pricingTierPrice: unknown }> = {}) => ({
    paymentStatus,
    ticketTypePrice: 100,
    pricingTierPrice: null,
    ...extra,
  });

  it("admits everyone the gate admits — incl. the two the old badge filter DROPPED", () => {
    // The bug: badge filter was `PAID || complimentary`, so these two were
    // admitted at the door but got no badge.
    expect(isPaymentAdmissible(pay("INCLUSIVE"))).toBe(true); // sponsor-paid
    expect(isPaymentAdmissible(pay("UNASSIGNED"))).toBe(true); // pay-at-desk
    // …and the rest the gate also admits
    expect(isPaymentAdmissible(pay("PAID"))).toBe(true);
    expect(isPaymentAdmissible(pay("COMPLIMENTARY"))).toBe(true);
    expect(isPaymentAdmissible(pay("REFUNDED"))).toBe(true);
    expect(isPaymentAdmissible(pay("FAILED"))).toBe(true);
  });

  it("excludes exactly what the gate blocks: UNPAID + PENDING", () => {
    expect(isPaymentAdmissible(pay("UNPAID"))).toBe(false);
    expect(isPaymentAdmissible(pay("PENDING"))).toBe(false);
  });

  it("free ticket / free tier is admissible regardless of status", () => {
    expect(isPaymentAdmissible(pay("UNPAID", { ticketTypePrice: 0 }))).toBe(true);
    expect(isPaymentAdmissible(pay("PENDING", { ticketTypePrice: 100, pricingTierPrice: 0 }))).toBe(true);
  });

  it("is the exact inverse of the gate's PAYMENT_REQUIRED branch (no drift)", () => {
    // For any status, the gate returns PAYMENT_REQUIRED iff badge is excluded.
    for (const status of ["PAID", "UNPAID", "PENDING", "COMPLIMENTARY", "INCLUSIVE", "REFUNDED", "FAILED", "UNASSIGNED"]) {
      const reg = { status: "CONFIRMED", paymentStatus: status, checkedInAt: null, ticketTypePrice: 100, pricingTierPrice: null };
      const gateDenied = checkInGate(reg)?.code === "PAYMENT_REQUIRED";
      const badgeExcluded = !isPaymentAdmissible(reg);
      expect(badgeExcluded).toBe(gateDenied);
    }
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
    mockDb.registration.updateMany.mockResolvedValue({ count: 1 }); // claim wins by default
    mockDb.registration.findUniqueOrThrow.mockResolvedValue(UPDATED);
    mockDb.auditLog.create.mockResolvedValue({});
    mockDb.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) =>
      cb({ registration: { updateMany: mockDb.registration.updateMany } }),
    );
  });

  it("plain check-in: claims the row (checkedInAt: null), audits with source, notifies", async () => {
    const res = await executeCheckIn({
      eventId: "ev1",
      registrationId: "reg1",
      actorUserId: "u1",
      attendeeName: "A B",
      source: "rest",
      auditExtras: { ip: "1.2.3.4" },
    });
    expect(res).toBe(UPDATED);
    // H3: the commit is a conditional claim, not an unconditional update.
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "reg1", checkedInAt: null } }),
    );
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

  it("H3: a lost claim (concurrent scan) returns the existing row idempotently — no duplicate audit or notify", async () => {
    mockDb.registration.updateMany.mockResolvedValue({ count: 0 }); // someone else won
    const res = await executeCheckIn({
      eventId: "ev1",
      registrationId: "reg1",
      actorUserId: "u1",
      attendeeName: "A B",
      source: "rest",
    });
    expect(res).toBe(UPDATED); // the already-checked-in row
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
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

  it("M7: a lost claim in the reactivation path does NOT run the seat/promo transition", async () => {
    mockDb.registration.updateMany.mockResolvedValue({ count: 0 }); // concurrent reactivation won
    await executeCheckIn({
      eventId: "ev1",
      registrationId: "reg1",
      actorUserId: "u1",
      attendeeName: "A B",
      source: "mcp",
      reactivation: {
        prev: { status: "CANCELLED", attendanceMode: "IN_PERSON", ticketTypeId: "tt1", pricingTierId: null, createdSource: null },
        next: { status: "CHECKED_IN", attendanceMode: "IN_PERSON", ticketTypeId: "tt1", pricingTierId: null, createdSource: null },
        promoCodeId: "promo1",
      } as never,
    });
    // The claim matched 0 rows → the transition (seat + promo increment) is skipped.
    expect(mockApplyTransition).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
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

describe("undoCheckIn (H2)", () => {
  const REVERTED = {
    id: "reg1",
    status: "CONFIRMED",
    checkedInAt: null,
    attendee: { firstName: "A", lastName: "B" },
    ticketType: { name: "Std" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.registration.updateMany.mockResolvedValue({ count: 1 });
    mockDb.registration.findUniqueOrThrow.mockResolvedValue(REVERTED);
    mockDb.auditLog.create.mockResolvedValue({});
  });

  it("clears status AND checkedInAt together via a conditional claim, and audits", async () => {
    const res = await undoCheckIn({
      eventId: "ev1",
      registrationId: "reg1",
      actorUserId: "u1",
      attendeeName: "A B",
      source: "rest",
      auditExtras: { ip: "1.2.3.4" },
    });
    expect(res).toEqual({ ok: true, registration: REVERTED });
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { id: "reg1", eventId: "ev1", checkedInAt: { not: null } },
      data: { status: "CONFIRMED", checkedInAt: null },
    });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "CHECK_IN_UNDO" }) }),
    );
    // Undo is a quiet correction — no admin notification.
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("NOT_CHECKED_IN when the row isn't checked in (or a concurrent undo already won)", async () => {
    mockDb.registration.updateMany.mockResolvedValue({ count: 0 });
    const res = await undoCheckIn({
      eventId: "ev1",
      registrationId: "reg1",
      actorUserId: "u1",
      attendeeName: "A B",
      source: "rest",
    });
    expect(res).toEqual({ ok: false, code: "NOT_CHECKED_IN", message: expect.any(String) });
    expect(mockDb.registration.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });
});
