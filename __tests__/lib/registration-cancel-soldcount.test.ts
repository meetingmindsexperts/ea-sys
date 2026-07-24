/**
 * MCP `bulk_update_registration_status` seat accounting. Originally pinned the
 * May-2026 BLOCKER (bulk cancel left soldCount inflated). Now also pins the
 * ROADMAP P1.1 fix: each row releases/claims the counter it actually holds
 * (PricingTier vs TicketType), virtual rows move nothing, and releases are
 * guarded so a counter can't go negative. paymentStatus-only updates skip it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApiLogger, mockRefreshEventStats } = vi.hoisted(() => {
  const ttUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const ttFindUnique = vi.fn();
  const tierUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const tierFindUnique = vi.fn();
  const regUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
  const promoUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const tx = {
    ticketType: { updateMany: ttUpdateMany, findUnique: ttFindUnique },
    event: {
      findUnique: vi.fn().mockResolvedValue({ seatCount: 0, maxAttendees: null }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $executeRaw: vi.fn(async () => 1),
    pricingTier: { updateMany: tierUpdateMany, findUnique: tierFindUnique },
    registration: { updateMany: regUpdateMany },
    promoCode: { updateMany: promoUpdateMany },
  };
  const db = {
    registration: { findMany: vi.fn(), updateMany: regUpdateMany },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
    $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
    _tx: tx,
  };
  return {
    mockDb: db,
    mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    mockRefreshEventStats: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: mockRefreshEventStats }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn() }));

import { REGISTRATION_EXECUTORS } from "@/lib/agent/tools/registrations";

const bulk = REGISTRATION_EXECUTORS.bulk_update_registration_status;
const ctx = {
  eventId: "ev1",
  organizationId: "org1",
  userId: "u1",
  counters: { creates: 0, emailsSent: 0 },
};

// Defaults model an in-person, admin/no-tier registration (counts on the ticket
// type). Override createdSource/pricingTierId/attendanceMode per case.
function row(over: Record<string, unknown>) {
  return {
    status: "CONFIRMED",
    ticketTypeId: "tt1",
    promoCodeId: null,
    pricingTierId: null,
    createdSource: "ADMIN_DASHBOARD",
    attendanceMode: "IN_PERSON",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.registration.updateMany.mockResolvedValue({ count: 0 });
  mockDb._tx.ticketType.updateMany.mockResolvedValue({ count: 1 });
  mockDb._tx.pricingTier.updateMany.mockResolvedValue({ count: 1 });
  mockDb._tx.promoCode.updateMany.mockResolvedValue({ count: 1 });
});

describe("bulk_update_registration_status — soldCount on cancel", () => {
  it("releases the ticket-type counter (guarded) only for rows transitioning INTO cancelled", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      row({ id: "r1", status: "CONFIRMED", ticketTypeId: "tt1" }), // → release
      row({ id: "r2", status: "PENDING", ticketTypeId: "tt1" }), // → release
      row({ id: "r3", status: "CANCELLED", ticketTypeId: "tt1" }), // already cancelled → skip
      row({ id: "r4", status: "CONFIRMED", ticketTypeId: null }), // no type → skip
      row({ id: "r5", status: "CONFIRMED", ticketTypeId: "tt2" }), // → release (other type)
      row({ id: "r6", status: "CONFIRMED", ticketTypeId: "tt1", attendanceMode: "VIRTUAL" }), // virtual → skip
    ]);
    mockDb.registration.updateMany.mockResolvedValue({ count: 6 });

    const res = (await bulk(
      { registrationIds: ["r1", "r2", "r3", "r4", "r5", "r6"], status: "CANCELLED" },
      ctx,
    )) as { success: boolean; updated: number };

    expect(res.success).toBe(true);
    expect(res.updated).toBe(6);
    // tt1 had 2 in-flight cancellations (r1, r2 — r6 is virtual, no seat); tt2 had 1 (r5).
    expect(mockDb._tx.ticketType.updateMany).toHaveBeenCalledWith({
      where: { id: "tt1", soldCount: { gte: 2 } },
      data: { soldCount: { decrement: 2 } },
    });
    expect(mockDb._tx.ticketType.updateMany).toHaveBeenCalledWith({
      where: { id: "tt2", soldCount: { gte: 1 } },
      data: { soldCount: { decrement: 1 } },
    });
    expect(mockDb._tx.ticketType.updateMany).toHaveBeenCalledTimes(2);
    expect(mockDb._tx.pricingTier.updateMany).not.toHaveBeenCalled();
  });

  it("cancelling a PUBLIC+TIER reg releases the TIER counter, never the ticket type (P1.1)", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      row({ id: "r1", status: "CONFIRMED", ticketTypeId: "tt1", pricingTierId: "pt1", createdSource: "PUBLIC_REGISTER" }),
    ]);
    mockDb.registration.updateMany.mockResolvedValue({ count: 1 });

    await bulk({ registrationIds: ["r1"], status: "CANCELLED" }, ctx);

    expect(mockDb._tx.pricingTier.updateMany).toHaveBeenCalledWith({
      where: { id: "pt1", soldCount: { gte: 1 } },
      data: { soldCount: { decrement: 1 } },
    });
    expect(mockDb._tx.ticketType.updateMany).not.toHaveBeenCalled();
  });

  it("re-acquires the counter when reactivating cancelled rows", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      row({ id: "r1", status: "CANCELLED", ticketTypeId: "tt1" }), // → claim
      row({ id: "r2", status: "CONFIRMED", ticketTypeId: "tt1" }), // already active → skip
    ]);
    mockDb._tx.ticketType.findUnique.mockResolvedValue({ quantity: 100, soldCount: 10, name: "Standard" });
    mockDb.registration.updateMany.mockResolvedValue({ count: 2 });

    await bulk({ registrationIds: ["r1", "r2"], status: "CONFIRMED" }, ctx);

    expect(mockDb._tx.ticketType.updateMany).toHaveBeenCalledWith({
      where: { id: "tt1" },
      data: { soldCount: { increment: 1 } },
    });
  });

  it("logs (does not silently swallow) a bulk reactivation that oversells", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      row({ id: "r1", status: "CANCELLED", ticketTypeId: "tt1" }),
    ]);
    mockDb._tx.ticketType.findUnique.mockResolvedValue({ quantity: 10, soldCount: 10, name: "Standard" });
    mockDb.registration.updateMany.mockResolvedValue({ count: 1 });

    await bulk({ registrationIds: ["r1"], status: "CONFIRMED" }, ctx);

    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "registration:bulk-reactivate-oversold", ticketTypeId: "tt1" }),
    );
  });

  it("bulk cancel releases each promo's usage via the GUARDED helper (never negative)", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      row({ id: "r1", status: "CONFIRMED", promoCodeId: "promo1" }),
      row({ id: "r2", status: "CONFIRMED", promoCodeId: "promo1" }),
      row({ id: "r3", status: "CONFIRMED", promoCodeId: "promo2" }),
      row({ id: "r4", status: "CANCELLED", promoCodeId: "promo1" }), // already cancelled → no release
    ]);
    mockDb.registration.updateMany.mockResolvedValue({ count: 4 });

    await bulk({ registrationIds: ["r1", "r2", "r3", "r4"], status: "CANCELLED" }, ctx);

    // Guarded (gte) — the unguarded promoCode.update({ decrement }) shape is gone.
    expect(mockDb._tx.promoCode.updateMany).toHaveBeenCalledWith({
      where: { id: "promo1", usedCount: { gte: 2 } },
      data: { usedCount: { decrement: 2 } },
    });
    expect(mockDb._tx.promoCode.updateMany).toHaveBeenCalledWith({
      where: { id: "promo2", usedCount: { gte: 1 } },
      data: { usedCount: { decrement: 1 } },
    });
    expect(mockDb._tx.promoCode.updateMany).toHaveBeenCalledTimes(2);
  });

  it("bulk reactivation RE-CLAIMS promo usage (H6 symmetry with the single-row paths)", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      row({ id: "r1", status: "CANCELLED", promoCodeId: "promo1" }),
    ]);
    mockDb._tx.ticketType.findUnique.mockResolvedValue({ quantity: 100, soldCount: 10, name: "Standard" });
    mockDb.registration.updateMany.mockResolvedValue({ count: 1 });

    await bulk({ registrationIds: ["r1"], status: "CONFIRMED" }, ctx);

    expect(mockDb._tx.promoCode.updateMany).toHaveBeenCalledWith({
      where: { id: "promo1" },
      data: { usedCount: { increment: 1 } },
    });
  });

  it("paymentStatus-only bulk update does NOT touch soldCount", async () => {
    mockDb.registration.updateMany.mockResolvedValue({ count: 3 });

    const res = (await bulk(
      { registrationIds: ["r1", "r2", "r3"], paymentStatus: "PAID" },
      ctx,
    )) as { success: boolean; updated: number };

    expect(res.success).toBe(true);
    expect(res.updated).toBe(3);
    expect(mockDb.registration.findMany).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});
