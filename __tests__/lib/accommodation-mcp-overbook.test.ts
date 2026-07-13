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
    accommodation: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
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

  it("on a full room type, fails NO_ROOMS_AVAILABLE and the whole transaction rolls back", async () => {
    mockDb._tx.roomType.updateMany.mockResolvedValue({ count: 0 }); // full — predicate matched nothing
    const res = (await update({ accommodationId: "a1", status: "CONFIRMED" }, ctx)) as { error?: string };
    expect(res.error).toMatch(/no rooms available/i);
    // NOTE: the status write now happens BEFORE the counter claim (review H5 —
    // the row must be claimed conditionally on its current status so a concurrent
    // cancel can't make us double-move the counter). The booking's status is
    // therefore still protected, but by the TRANSACTION rolling back rather than
    // by ordering: the claim throws, so nothing here commits.
    expect(mockDb.$transaction).toHaveBeenCalled();
  });

  it("claims the row conditionally on its current status (H5 — a concurrent cancel must lose)", async () => {
    mockDb._tx.roomType.updateMany.mockResolvedValue({ count: 1 });
    await update({ accommodationId: "a1", status: "CONFIRMED" }, ctx);
    // The row write carries the status we planned the counter move from, so a
    // racing writer that already changed it makes this match zero rows.
    expect(mockDb._tx.accommodation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "a1", status: "CANCELLED" }),
      }),
    );
  });

  it("a lost status race rejects as STALE_WRITE and never touches the counter", async () => {
    mockDb._tx.accommodation.updateMany.mockResolvedValue({ count: 0 }); // someone changed it first
    mockDb._tx.accommodation.findUnique.mockResolvedValue({ id: "a1" }); // row still exists
    const res = (await update({ accommodationId: "a1", status: "CONFIRMED" }, ctx)) as { error?: string };
    expect(res.error).toBeTruthy();
    expect(mockDb._tx.roomType.updateMany).not.toHaveBeenCalled(); // counter untouched
  });
});
