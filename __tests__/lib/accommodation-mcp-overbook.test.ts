/**
 * MCP update_accommodation_status — reactivate (CANCELLED→active) must re-book
 * the room ATOMICALLY. The old read-bookedRooms-then-increment could overbook
 * the last room under concurrency; the REST route already used the atomic
 * `bookedRooms < totalRooms` predicate. This pins parity.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => {
  const tx = {
    roomType: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    accommodation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUniqueOrThrow: vi.fn() },
  };
  return {
    mockDb: {
      accommodation: { findFirst: vi.fn() },
      auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
      $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
      _tx: tx,
    },
  };
});

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { ACCOMMODATION_EXECUTORS } from "@/lib/agent/tools/accommodations";

const update = ACCOMMODATION_EXECUTORS.update_accommodation_status;
const ctx = { eventId: "ev1", organizationId: "org1", userId: "u1", counters: { creates: 0, emailsSent: 0 } };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.accommodation.findFirst.mockResolvedValue({ id: "a1", eventId: "ev1", status: "CANCELLED", roomTypeId: "rt1" });
  mockDb._tx.roomType.findUnique.mockResolvedValue({ totalRooms: 10 });
  mockDb._tx.accommodation.updateMany.mockResolvedValue({ count: 1 });
  mockDb._tx.accommodation.findUniqueOrThrow.mockResolvedValue({ id: "a1", status: "CONFIRMED", checkIn: null, checkOut: null });
});

describe("MCP update_accommodation_status — atomic re-book on reactivate", () => {
  it("re-books with the bookedRooms<totalRooms atomic guard (no read-then-increment)", async () => {
    mockDb._tx.roomType.updateMany.mockResolvedValue({ count: 1 });
    const res = (await update({ accommodationId: "a1", status: "CONFIRMED" }, ctx)) as { success?: boolean; error?: string };
    expect(res.error).toBeUndefined();
    expect(mockDb._tx.roomType.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "rt1", bookedRooms: { lt: 10 } }),
        data: { bookedRooms: { increment: 1 } },
      }),
    );
    // The old code called roomType.update (unconditional increment); it must not.
    expect(mockDb._tx.roomType.update).not.toHaveBeenCalled();
  });

  it("on a full room type, fails NO_ROOMS_AVAILABLE and does NOT change the booking status", async () => {
    mockDb._tx.roomType.updateMany.mockResolvedValue({ count: 0 }); // full — predicate matched nothing
    const res = (await update({ accommodationId: "a1", status: "CONFIRMED" }, ctx)) as { error?: string };
    expect(res.error).toMatch(/no rooms available/i);
    expect(mockDb._tx.accommodation.updateMany).not.toHaveBeenCalled(); // threw before the status write
  });
});
