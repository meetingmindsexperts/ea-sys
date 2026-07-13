/**
 * Room-counter accounting — the pure `planRoomTransition` model plus the
 * guarded appliers.
 *
 * The planner is the fix for the review's H3: the REST PUT used to move
 * `bookedRooms` from TWO independent blocks (one for a room-type change, one for
 * a status change) that didn't know about each other, so a single request that
 * did both double-released the old room type. The planner derives the ONE net
 * movement from the whole (before → after) pair, so double-counting is
 * structurally impossible. These tests enumerate every combination.
 */
import { describe, it, expect, vi } from "vitest";
import {
  planRoomTransition,
  holdsRoom,
  applyRoomTransition,
  applyRoomStatusTransition,
  releaseRoom,
} from "@/lib/accommodation-rooms";

function makeTx(totalRooms: number | null = 10, claimCount = 1) {
  const calls: string[] = [];
  const tx = {
    calls,
    roomType: {
      findUnique: vi.fn().mockResolvedValue(totalRooms == null ? null : { totalRooms }),
      updateMany: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
        const isRelease = JSON.stringify(args.data).includes("decrement");
        calls.push(isRelease ? "release" : "claim");
        return Promise.resolve({ count: isRelease ? 1 : claimCount });
      }),
    },
  };
  return tx as unknown as Parameters<typeof applyRoomTransition>[0] & {
    calls: string[];
    roomType: { findUnique: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  };
}

describe("holdsRoom", () => {
  it("a booking holds a room unless it is cancelled", () => {
    expect(holdsRoom("PENDING")).toBe(true);
    expect(holdsRoom("CONFIRMED")).toBe(true);
    expect(holdsRoom("CHECKED_IN")).toBe(true);
    expect(holdsRoom("CHECKED_OUT")).toBe(true);
    expect(holdsRoom("CANCELLED")).toBe(false);
  });
});

describe("planRoomTransition — the whole truth table", () => {
  const A = "rtA";
  const B = "rtB";

  it("no change → no movement", () => {
    expect(planRoomTransition({ status: "CONFIRMED", roomTypeId: A }, { status: "CONFIRMED", roomTypeId: A }))
      .toEqual({ release: null, claim: null });
  });

  it("status change that keeps it active (CONFIRMED → CHECKED_IN) → no movement", () => {
    expect(planRoomTransition({ status: "CONFIRMED", roomTypeId: A }, { status: "CHECKED_IN", roomTypeId: A }))
      .toEqual({ release: null, claim: null });
  });

  it("active → CANCELLED → release the held room", () => {
    expect(planRoomTransition({ status: "CONFIRMED", roomTypeId: A }, { status: "CANCELLED", roomTypeId: A }))
      .toEqual({ release: A, claim: null });
  });

  it("CANCELLED → active → claim the wanted room", () => {
    expect(planRoomTransition({ status: "CANCELLED", roomTypeId: A }, { status: "CONFIRMED", roomTypeId: A }))
      .toEqual({ release: null, claim: A });
  });

  it("active room change A → B → release A, claim B", () => {
    expect(planRoomTransition({ status: "CONFIRMED", roomTypeId: A }, { status: "CONFIRMED", roomTypeId: B }))
      .toEqual({ release: A, claim: B });
  });

  // ── The two bugs H3 was about ──

  it("H3a: room change on a CANCELLED booking moves NOTHING (it holds no room)", () => {
    // Old code decremented A (a room it had already released at cancel time) and
    // claimed B — phantom occupancy on B, and A drifting negative.
    expect(planRoomTransition({ status: "CANCELLED", roomTypeId: A }, { status: "CANCELLED", roomTypeId: B }))
      .toEqual({ release: null, claim: null });
  });

  it("H3b: room change + cancel in ONE request releases A exactly once (never twice, never claims B)", () => {
    // Old code: room-change block did A−1 / B+1, then the status applier released
    // A *again* → A −2, B +1 forever.
    expect(planRoomTransition({ status: "CONFIRMED", roomTypeId: A }, { status: "CANCELLED", roomTypeId: B }))
      .toEqual({ release: A, claim: null });
  });

  it("room change + reinstate in one request claims B only", () => {
    expect(planRoomTransition({ status: "CANCELLED", roomTypeId: A }, { status: "CONFIRMED", roomTypeId: B }))
      .toEqual({ release: null, claim: B });
  });
});

describe("releaseRoom — guarded, can never go negative", () => {
  it("decrements only while bookedRooms > 0", async () => {
    const tx = makeTx();
    await releaseRoom(tx, "rt1");
    expect(tx.roomType.updateMany).toHaveBeenCalledWith({
      where: { id: "rt1", bookedRooms: { gt: 0 } },   // the floor
      data: { bookedRooms: { decrement: 1 } },
    });
  });
});

describe("applyRoomTransition", () => {
  it("releases before claiming (so a failed claim rolls the release back with the tx)", async () => {
    const tx = makeTx();
    await applyRoomTransition(tx, { release: "rtA", claim: "rtB" });
    expect(tx.calls).toEqual(["release", "claim"]);
  });

  it("claims atomically with the bookedRooms < totalRooms predicate", async () => {
    const tx = makeTx(10);
    await applyRoomTransition(tx, { release: null, claim: "rt1" });
    expect(tx.roomType.updateMany).toHaveBeenCalledWith({
      where: { id: "rt1", bookedRooms: { lt: 10 } },
      data: { bookedRooms: { increment: 1 } },
    });
  });

  it("throws NO_ROOMS_AVAILABLE when the claim can't be satisfied (full)", async () => {
    const tx = makeTx(10, 0);
    await expect(applyRoomTransition(tx, { release: null, claim: "rt1" })).rejects.toThrow("NO_ROOMS_AVAILABLE");
  });

  it("throws NO_ROOMS_AVAILABLE when the room type vanished", async () => {
    const tx = makeTx(null);
    await expect(applyRoomTransition(tx, { release: null, claim: "rt1" })).rejects.toThrow("NO_ROOMS_AVAILABLE");
  });

  it("an empty plan touches nothing", async () => {
    const tx = makeTx();
    await applyRoomTransition(tx, { release: null, claim: null });
    expect(tx.calls).toEqual([]);
  });
});

describe("applyRoomStatusTransition (status-only wrapper, used by MCP)", () => {
  it("active → CANCELLED releases the room (guarded)", async () => {
    const tx = makeTx();
    await applyRoomStatusTransition(tx, { prevStatus: "CONFIRMED", nextStatus: "CANCELLED", roomTypeId: "rt1" });
    expect(tx.calls).toEqual(["release"]);
    expect(tx.roomType.updateMany).toHaveBeenCalledWith({
      where: { id: "rt1", bookedRooms: { gt: 0 } },
      data: { bookedRooms: { decrement: 1 } },
    });
  });

  it("CANCELLED → active reclaims a room atomically", async () => {
    const tx = makeTx();
    await applyRoomStatusTransition(tx, { prevStatus: "CANCELLED", nextStatus: "CONFIRMED", roomTypeId: "rt1" });
    expect(tx.calls).toEqual(["claim"]);
  });

  it("no status change is a no-op", async () => {
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
