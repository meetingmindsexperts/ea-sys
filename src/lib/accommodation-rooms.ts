import type { Prisma } from "@prisma/client";

/**
 * Adjust `RoomType.bookedRooms` for an accommodation STATUS transition, inside
 * the caller's transaction. Single source of truth for the release-on-cancel /
 * reclaim-on-reactivate accounting shared by the REST accommodation status route
 * and the MCP `update_accommodation_status` tool (see src/services/README.md
 * "THE RULE" — this replaces two hand-mirrored copies).
 *
 * - active → CANCELLED: release the booked room (`bookedRooms` decrement).
 * - CANCELLED → active: re-claim a room ATOMICALLY — the `bookedRooms <
 *   totalRooms` predicate is the oversell guard (two concurrent reactivations
 *   can't both grab the last room). Throws `Error("NO_ROOMS_AVAILABLE")` when a
 *   room can't be reclaimed.
 * - any other transition (or no status change): no-op.
 *
 * The ROOM-TYPE-change accounting (release the old room type + claim the new one)
 * is a separate concern and stays with the caller that supports it (REST only).
 */
export async function applyRoomStatusTransition(
  tx: Prisma.TransactionClient,
  input: { prevStatus: string; nextStatus: string; roomTypeId: string },
): Promise<void> {
  const { prevStatus, nextStatus, roomTypeId } = input;
  const wasActive = prevStatus !== "CANCELLED";
  const willBeActive = nextStatus !== "CANCELLED";

  if (wasActive && !willBeActive) {
    await tx.roomType.update({
      where: { id: roomTypeId },
      data: { bookedRooms: { decrement: 1 } },
    });
  } else if (!wasActive && willBeActive) {
    const fresh = await tx.roomType.findUnique({
      where: { id: roomTypeId },
      select: { totalRooms: true },
    });
    if (!fresh) throw new Error("NO_ROOMS_AVAILABLE");
    const claimed = await tx.roomType.updateMany({
      where: { id: roomTypeId, bookedRooms: { lt: fresh.totalRooms } },
      data: { bookedRooms: { increment: 1 } },
    });
    if (claimed.count === 0) throw new Error("NO_ROOMS_AVAILABLE");
  }
}
