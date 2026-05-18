/**
 * Pins the fix for the BLOCKER found in the May 2026 audit: the MCP
 * `bulk_update_registration_status` tool was a bare updateMany with NO
 * soldCount adjustment, so "cancel all unpaid registrations" via the AI
 * agent / n8n silently left TicketType.soldCount inflated → the event
 * falsely reported sold-out and rejected legitimate paying registrants.
 *
 * It must now release soldCount per ticket type for rows transitioning
 * INTO cancelled (and re-acquire on reactivation), mirroring the REST PUT
 * route. paymentStatus-only bulk updates must NOT touch soldCount.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApiLogger, mockRefreshEventStats } = vi.hoisted(() => {
  const ticketTypeUpdate = vi.fn().mockResolvedValue({});
  const ticketTypeFindUnique = vi.fn();
  const regUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
  const db = {
    registration: { findMany: vi.fn(), updateMany: regUpdateMany },
    ticketType: { update: ticketTypeUpdate, findUnique: ticketTypeFindUnique },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
      cb({
        ticketType: { update: ticketTypeUpdate, findUnique: ticketTypeFindUnique },
        registration: { updateMany: regUpdateMany },
      }),
    ),
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

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.registration.updateMany.mockResolvedValue({ count: 0 });
  mockDb.ticketType.update.mockResolvedValue({});
});

describe("bulk_update_registration_status — soldCount on cancel", () => {
  it("releases soldCount per ticket type only for rows transitioning INTO cancelled", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      { id: "r1", status: "CONFIRMED", ticketTypeId: "tt1" }, // → decrement
      { id: "r2", status: "PENDING", ticketTypeId: "tt1" }, // → decrement
      { id: "r3", status: "CANCELLED", ticketTypeId: "tt1" }, // already cancelled → skip
      { id: "r4", status: "CONFIRMED", ticketTypeId: null }, // no ticket type → skip
      { id: "r5", status: "CONFIRMED", ticketTypeId: "tt2" }, // → decrement (other type)
    ]);
    mockDb.registration.updateMany.mockResolvedValue({ count: 5 });

    const res = (await bulk(
      { registrationIds: ["r1", "r2", "r3", "r4", "r5"], status: "CANCELLED" },
      ctx,
    )) as { success: boolean; updated: number };

    expect(res.success).toBe(true);
    expect(res.updated).toBe(5);
    // tt1 had 2 in-flight cancellations (r1, r2); tt2 had 1 (r5).
    expect(mockDb.ticketType.update).toHaveBeenCalledWith({
      where: { id: "tt1" },
      data: { soldCount: { decrement: 2 } },
    });
    expect(mockDb.ticketType.update).toHaveBeenCalledWith({
      where: { id: "tt2" },
      data: { soldCount: { decrement: 1 } },
    });
    expect(mockDb.ticketType.update).toHaveBeenCalledTimes(2);
  });

  it("re-acquires soldCount per ticket type when reactivating cancelled rows", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      { id: "r1", status: "CANCELLED", ticketTypeId: "tt1" }, // → increment
      { id: "r2", status: "CONFIRMED", ticketTypeId: "tt1" }, // already active → skip
    ]);
    mockDb.ticketType.findUnique.mockResolvedValue({
      quantity: 100,
      soldCount: 10,
      name: "Standard",
    });
    mockDb.registration.updateMany.mockResolvedValue({ count: 2 });

    await bulk({ registrationIds: ["r1", "r2"], status: "CONFIRMED" }, ctx);

    expect(mockDb.ticketType.update).toHaveBeenCalledWith({
      where: { id: "tt1" },
      data: { soldCount: { increment: 1 } },
    });
  });

  it("logs (does not silently swallow) a bulk reactivation that oversells", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      { id: "r1", status: "CANCELLED", ticketTypeId: "tt1" },
    ]);
    mockDb.ticketType.findUnique.mockResolvedValue({
      quantity: 10,
      soldCount: 10,
      name: "Standard",
    });
    mockDb.registration.updateMany.mockResolvedValue({ count: 1 });

    await bulk({ registrationIds: ["r1"], status: "CONFIRMED" }, ctx);

    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "registration:bulk-reactivate-oversold", ticketTypeId: "tt1" }),
    );
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
    expect(mockDb.ticketType.update).not.toHaveBeenCalled();
    // plain path: updateMany called directly, not inside a transaction
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});
