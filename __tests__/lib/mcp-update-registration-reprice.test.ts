/**
 * MCP `update_registration` — re-tier / type-change repricing PARITY with the
 * REST PUT (both call the shared `resolveRepricing`). Also pins the real
 * seat-counter move on a PUBLIC_REGISTER + tier registration (registration-seat
 * + registration-seat-db are REAL here, so a re-tier moves between PricingTier
 * counters — prior review M4/M-B). Covers input parsing (id / "" / null),
 * reprice on type+tier and bare type change, and the unpaid / promo guards.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => {
  const tx = {
    ticketType: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn() },
    pricingTier: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn() },
    registration: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn(),
    },
    attendee: { update: vi.fn().mockResolvedValue({}) },
    promoCode: { update: vi.fn().mockResolvedValue({}) },
  };
  return {
    mockDb: {
      registration: { findFirst: vi.fn() },
      ticketType: { findFirst: vi.fn() },
      pricingTier: { findFirst: vi.fn() },
      auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
      $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
      _tx: tx,
    },
  };
});

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn() }));
// registration-seat + registration-seat-db are REAL — the tx counter calls below
// are what the seat model actually does.

import { REGISTRATION_EXECUTORS } from "@/lib/agent/tools/registrations";

const update = REGISTRATION_EXECUTORS.update_registration;
const ctx = { eventId: "ev1", organizationId: "org1", userId: "u1", counters: { creates: 0, emailsSent: 0 } };
const OLD_TYPE = "tt_old";
const NEW_TYPE = "tt_new";
const OLD_TIER = "pt_old";
const NEW_TIER = "pt_new";

function existing(over: Record<string, unknown> = {}) {
  return {
    id: "reg1", eventId: "ev1", status: "CONFIRMED", paymentStatus: "UNPAID",
    sponsorId: null, ticketTypeId: OLD_TYPE, attendeeId: "att1", promoCodeId: null,
    discountAmount: null, attendanceMode: "IN_PERSON", qrCode: "QR",
    pricingTierId: OLD_TIER, createdSource: "PUBLIC_REGISTER",
    attendee: { id: "att1", firstName: "A", lastName: "B", email: "a@b.com", tags: [] },
    event: { settings: {} },
    ...over,
  };
}

// Capture regData passed to the final updateMany.
function captured() {
  return mockDb._tx.registration.updateMany.mock.calls[0]?.[0]?.data as Record<string, unknown> | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.ticketType.findFirst.mockResolvedValue({ id: NEW_TYPE, price: 250 });
  mockDb.pricingTier.findFirst.mockResolvedValue({ id: NEW_TIER, price: 500 });
  mockDb._tx.ticketType.updateMany.mockResolvedValue({ count: 1 });
  mockDb._tx.pricingTier.updateMany.mockResolvedValue({ count: 1 });
  mockDb._tx.ticketType.findUnique.mockResolvedValue({ quantity: 100, name: "Nurse" });
  mockDb._tx.pricingTier.findUnique.mockResolvedValue({ quantity: 100 });
  mockDb._tx.registration.findUniqueOrThrow.mockResolvedValue({
    id: "reg1", status: "CONFIRMED", paymentStatus: "UNPAID", ticketTypeId: NEW_TYPE,
    notes: null, attendee: { id: "att1", firstName: "A", lastName: "B", email: "a@b.com" },
  });
});

describe("MCP update_registration — re-tier / reprice parity", () => {
  it("re-tier (same type) sets the tier + re-stamps originalPrice", async () => {
    mockDb.registration.findFirst.mockResolvedValue(existing());
    const res = await update({ registrationId: "reg1", pricingTierId: NEW_TIER, expectedUpdatedAt: "2026-07-07T10:00:00.000Z" }, ctx);
    expect((res as { success?: boolean }).success).toBe(true);
    // validated against the CURRENT type
    expect(mockDb.pricingTier.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: NEW_TIER, ticketTypeId: OLD_TYPE } }));
    expect(captured()).toMatchObject({ pricingTierId: NEW_TIER, originalPrice: 500 });
  });

  it("PUBLIC_REGISTER re-tier moves between TIER counters (releases old, claims new)", async () => {
    mockDb.registration.findFirst.mockResolvedValue(existing());
    await update({ registrationId: "reg1", pricingTierId: NEW_TIER, expectedUpdatedAt: "2026-07-07T10:00:00.000Z" }, ctx);
    // release the OLD tier counter (guarded decrement)
    expect(mockDb._tx.pricingTier.updateMany).toHaveBeenCalledWith({
      where: { id: OLD_TIER, soldCount: { gte: 1 } },
      data: { soldCount: { decrement: 1 } },
    });
    // claim the NEW tier counter (atomic capacity-guarded increment)
    expect(mockDb._tx.pricingTier.updateMany).toHaveBeenCalledWith({
      where: { id: NEW_TIER, soldCount: { lt: 100 } },
      data: { soldCount: { increment: 1 } },
    });
    // never touched the ticket-type counter
    expect(mockDb._tx.ticketType.updateMany).not.toHaveBeenCalled();
  });

  it("type + tier change validates the tier against the NEW type + reprices", async () => {
    mockDb.registration.findFirst.mockResolvedValue(existing());
    await update({ registrationId: "reg1", ticketTypeId: NEW_TYPE, pricingTierId: NEW_TIER, expectedUpdatedAt: "2026-07-07T10:00:00.000Z" }, ctx);
    expect(mockDb.pricingTier.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: NEW_TIER, ticketTypeId: NEW_TYPE } }));
    expect(captured()).toMatchObject({ ticketTypeId: NEW_TYPE, pricingTierId: NEW_TIER, originalPrice: 500 });
  });

  it("bare type change (no tier) nulls the tier + reprices to the new type's base (M2)", async () => {
    mockDb.registration.findFirst.mockResolvedValue(existing());
    await update({ registrationId: "reg1", ticketTypeId: NEW_TYPE, expectedUpdatedAt: "2026-07-07T10:00:00.000Z" }, ctx);
    expect(captured()).toMatchObject({ ticketTypeId: NEW_TYPE, pricingTierId: null, originalPrice: 250 });
  });

  it('pricingTierId "" parses to base (null) + reprices to the type base', async () => {
    mockDb.registration.findFirst.mockResolvedValue(existing());
    await update({ registrationId: "reg1", pricingTierId: "", expectedUpdatedAt: "2026-07-07T10:00:00.000Z" }, ctx);
    // base lookup on the current type
    expect(captured()).toMatchObject({ pricingTierId: null, originalPrice: 250 });
  });

  it("re-tier on a PAID reg → TIER_CHANGE_REQUIRES_UNPAID, no transaction", async () => {
    mockDb.registration.findFirst.mockResolvedValue(existing({ paymentStatus: "PAID" }));
    const res = await update({ registrationId: "reg1", pricingTierId: NEW_TIER }, ctx);
    expect((res as { code?: string }).code).toBe("TIER_CHANGE_REQUIRES_UNPAID");
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("re-tier with a promo applied → TIER_CHANGE_HAS_DISCOUNT, no transaction", async () => {
    mockDb.registration.findFirst.mockResolvedValue(existing({ promoCodeId: "promo1" }));
    const res = await update({ registrationId: "reg1", pricingTierId: NEW_TIER }, ctx);
    expect((res as { code?: string }).code).toBe("TIER_CHANGE_HAS_DISCOUNT");
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});
