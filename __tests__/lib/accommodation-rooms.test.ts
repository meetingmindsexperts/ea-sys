/**
 * applyRoomStatusTransition — shared bookedRooms release/reclaim for an
 * accommodation status transition (replaces the REST↔MCP hand-mirrored copies).
 */
import { describe, it, expect, vi } from "vitest";
import { applyRoomStatusTransition } from "@/lib/accommodation-rooms";

function makeTx(totalRooms = 10, claimCount = 1) {
  const calls: string[] = [];
  const tx = {
    calls,
    roomType: {
      update: vi.fn().mockImplementation(() => { calls.push("release"); return Promise.resolve({}); }),
      findUnique: vi.fn().mockResolvedValue(totalRooms == null ? null : { totalRooms }),
      updateMany: vi.fn().mockImplementation(() => { calls.push("reclaim"); return Promise.resolve({ count: claimCount }); }),
    },
  };
  return tx as unknown as Parameters<typeof applyRoomStatusTransition>[0] & { calls: string[]; roomType: { update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> } };
}

describe("applyRoomStatusTransition", () => {
  it("active → CANCELLED releases the room", async () => {
    const tx = makeTx();
    await applyRoomStatusTransition(tx, { prevStatus: "CONFIRMED", nextStatus: "CANCELLED", roomTypeId: "rt1" });
    expect(tx.calls).toEqual(["release"]);
    expect(tx.roomType.update).toHaveBeenCalledWith({ where: { id: "rt1" }, data: { bookedRooms: { decrement: 1 } } });
  });

  it("CANCELLED → active reclaims a room atomically", async () => {
    const tx = makeTx();
    await applyRoomStatusTransition(tx, { prevStatus: "CANCELLED", nextStatus: "CONFIRMED", roomTypeId: "rt1" });
    expect(tx.calls).toEqual(["reclaim"]);
    expect(tx.roomType.updateMany).toHaveBeenCalledWith({
      where: { id: "rt1", bookedRooms: { lt: 10 } },
      data: { bookedRooms: { increment: 1 } },
    });
  });

  it("throws NO_ROOMS_AVAILABLE when the reclaim can't be satisfied (full)", async () => {
    const tx = makeTx(10, 0);
    await expect(
      applyRoomStatusTransition(tx, { prevStatus: "CANCELLED", nextStatus: "CONFIRMED", roomTypeId: "rt1" }),
    ).rejects.toThrow("NO_ROOMS_AVAILABLE");
  });

  it("throws NO_ROOMS_AVAILABLE when the room type vanished", async () => {
    const tx = makeTx(null as unknown as number);
    await expect(
      applyRoomStatusTransition(tx, { prevStatus: "CANCELLED", nextStatus: "CONFIRMED", roomTypeId: "rt1" }),
    ).rejects.toThrow("NO_ROOMS_AVAILABLE");
  });

  it("no status change (active→active) is a no-op", async () => {
    const tx = makeTx();
    await applyRoomStatusTransition(tx, { prevStatus: "CONFIRMED", nextStatus: "CHECKED_IN", roomTypeId: "rt1" });
    expect(tx.calls).toEqual([]);
  });

  it("CANCELLED → CANCELLED is a no-op", async () => {
    const tx = makeTx();
    await applyRoomStatusTransition(tx, { prevStatus: "CANCELLED", nextStatus: "CANCELLED", roomTypeId: "rt1" });
    expect(tx.calls).toEqual([]);
  });
});
