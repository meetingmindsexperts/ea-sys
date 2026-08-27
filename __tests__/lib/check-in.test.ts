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

vi.mock("@/lib/db", () => ({
  db: mockDb,
  // tenantTransaction with the flag off IS db.$transaction — delegate so the
  // test's tx interception keeps working for the migrated sites.
  tenantTransaction: (fn: (tx: unknown) => unknown) => mockDb.$transaction(fn),
}));
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

  it("allowPaymentDue (audited desk override, M1) skips ONLY the payment gate", () => {
    // Owner decision July 11: the override covers any payment block.
    expect(checkInGate({ ...base, paymentStatus: "UNPAID" }, { allowPaymentDue: true })).toBeNull();
    expect(checkInGate({ ...base, paymentStatus: "PENDING" }, { allowPaymentDue: true })).toBeNull();
    // It does NOT bypass the cancelled gate…
    expect(
      checkInGate({ ...base, status: "CANCELLED", paymentStatus: "UNPAID" }, { allowPaymentDue: true }),
    ).toMatchObject({ code: "CANCELLED" });
    // …nor the double-check-in gate.
    expect(
      checkInGate({ ...base, paymentStatus: "UNPAID", checkedInAt: new Date() }, { allowPaymentDue: true }),
    ).toMatchObject({ code: "ALREADY_CHECKED_IN" });
  });

  it("FAILED, REFUNDED and UNASSIGNED are REFUSED — owner decision, 2026-08-27", () => {
    // REVERSES the July 11 2026 ruling that a failed charge or a goodwill
    // refund should not bar someone from the venue, and additionally excludes
    // UNASSIGNED (the default for an admin-created registration whose payment
    // is still pending), which the old deny-list admitted only by omission.
    //
    // Pinned as explicitly as the old rule was, and for the same reason: this
    // is a product decision, so it should take a product decision to change it,
    // not a tidy-up.
    for (const status of ["FAILED", "UNASSIGNED"]) {
      expect(checkInGate({ ...base, paymentStatus: status })).toMatchObject({
        code: "PAYMENT_REQUIRED",
      });
    }
    // REFUNDED is the exception and turns on the registration status — see the
    // isPaymentAdmissible block below.
    expect(checkInGate({ ...base, paymentStatus: "REFUNDED", status: "CONFIRMED" })).toBeNull();
  });

  it("the desk can still admit any of them with the audited override", () => {
    // The rule narrows the DEFAULT, not the desk's authority. A registrant
    // whose Stripe webhook is lagging must still get through the door.
    for (const status of ["FAILED", "REFUNDED", "UNASSIGNED", "UNPAID", "PENDING"]) {
      expect(checkInGate({ ...base, paymentStatus: status }, { allowPaymentDue: true })).toBeNull();
    }
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
  const pay = (
    paymentStatus: string,
    extra: Partial<{ ticketTypePrice: unknown; pricingTierPrice: unknown; status: string; originalPrice: unknown }> = {},
  ) => ({
    paymentStatus,
    status: "CONFIRMED",
    ticketTypePrice: 100,
    pricingTierPrice: null,
    ...extra,
  });

  it("admits exactly three statuses — an ALLOW-list, not a deny-list", () => {
    // INCLUSIVE is sponsor-paid: the money arrived, just not from the attendee.
    expect(isPaymentAdmissible(pay("PAID"))).toBe(true);
    expect(isPaymentAdmissible(pay("COMPLIMENTARY"))).toBe(true);
    expect(isPaymentAdmissible(pay("INCLUSIVE"))).toBe(true);
  });

  it("excludes everything else, including a status invented tomorrow", () => {
    for (const status of ["UNPAID", "PENDING", "UNASSIGNED", "FAILED"]) {
      expect(isPaymentAdmissible(pay(status))).toBe(false);
    }
    // The shape that matters: the predicate is an allow-list, so a value added
    // to the PaymentStatus enum later is refused until someone decides
    // otherwise. Under the old deny-list it would have been admitted silently,
    // which is how UNASSIGNED, FAILED and REFUNDED came to be admitted at all.
    expect(isPaymentAdmissible(pay("SOME_FUTURE_STATUS"))).toBe(false);
  });

  it("REFUNDED turns on the REGISTRATION status, not the money", () => {
    // Owner, 2026-08-27. A refund and a cancellation are different facts: money
    // going back while the registration stays CONFIRMED is the organiser saying
    // the place still stands (a sponsor picked up the cost, or goodwill).
    // Someone who is not coming gets CANCELLED, which the gate refuses a branch
    // earlier. The live case: HEMNET 2026 holds exactly one CONFIRMED+REFUNDED
    // registration, already through the door.
    expect(isPaymentAdmissible(pay("REFUNDED", { status: "CONFIRMED" }))).toBe(true);
    expect(isPaymentAdmissible(pay("REFUNDED", { status: "CHECKED_IN" }))).toBe(true);
    expect(isPaymentAdmissible(pay("REFUNDED", { status: "CANCELLED" }))).toBe(false);
    expect(isPaymentAdmissible(pay("REFUNDED", { status: "PENDING" }))).toBe(false);
  });

  it("FAILED gets NO such exemption, however confirmed they are", () => {
    // The distinction is where the money is. REFUNDED means it arrived and went
    // back; FAILED means it never arrived, so they still owe and CONFIRMED only
    // means nobody has chased them yet.
    expect(isPaymentAdmissible(pay("FAILED", { status: "CONFIRMED" }))).toBe(false);
    expect(isPaymentAdmissible(pay("FAILED", { status: "CHECKED_IN" }))).toBe(false);
  });

  it("a TIER-PRICED registration on a 0-base ticket type is NOT free", () => {
    // The bug this suite missed until 2026-08-27. The standard shape here is a
    // base ticket type priced 0 with the real money on the tier (Early Bird,
    // Standard), so the old `ticketTypePrice === 0 || pricingTierPrice === 0`
    // read "Physician 0.00 + Standard 100.00" as FREE and admitted the person
    // regardless of payment status. Found when an UNPAID attendee owing 100
    // turned up checked in — 11 such registrations across four live events.
    expect(
      isPaymentAdmissible(pay("UNPAID", { ticketTypePrice: 0, pricingTierPrice: 100 })),
    ).toBe(false);
    // And it is the TIER that decides, not "either is zero": a free tier on a
    // priced type is still free.
    expect(
      isPaymentAdmissible(pay("UNPAID", { ticketTypePrice: 100, pricingTierPrice: 0 })),
    ).toBe(true);
  });

  it("the stamped price wins when it is present", () => {
    // originalPrice is what the person was actually charged. A row stamped at
    // 100 is not free just because the type has since been re-priced to 0.
    expect(
      isPaymentAdmissible(pay("UNPAID", { originalPrice: 100, ticketTypePrice: 0, pricingTierPrice: null })),
    ).toBe(false);
    // The stamping-gap guard: originalPrice 0 beside a priced tier means the
    // price was never re-stamped, so the tier wins rather than reading as free.
    expect(
      isPaymentAdmissible(pay("UNPAID", { originalPrice: 0, ticketTypePrice: 0, pricingTierPrice: 100 })),
    ).toBe(false);
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
    // H3: the commit is a conditional claim, not an unconditional update —
    // event-bound (tenancy C1) so a foreign registrationId can't claim.
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "reg1", eventId: "ev1", checkedInAt: null } }),
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
