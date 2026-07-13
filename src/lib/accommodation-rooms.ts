import type { Prisma } from "@prisma/client";

/**
 * Room-counter accounting for accommodations — the single source of truth for
 * how `RoomType.bookedRooms` moves.
 *
 * THE INVARIANT: `bookedRooms` == the number of accommodations on that room type
 * that actually hold a room. A booking holds a room iff it is not CANCELLED.
 *
 * WHY THIS FILE EXISTS IN THIS SHAPE (accommodation review, July 13 2026):
 * the counter used to be moved by TWO independent blocks in the REST PUT — one
 * for a room-type change, one for a status change — that didn't know about each
 * other. A single request that changed the room type AND cancelled the booking
 * released the OLD room type twice and left a permanent phantom claim on the
 * new one; changing the room type of an already-CANCELLED booking moved
 * counters for a room it didn't hold. No race required.
 *
 * The fix is not "add a status check to the room-change block" — that patches a
 * symptom and leaves the next combination (room-change + reinstate) to be found
 * in production. Instead we compute the movement ONCE from the whole
 * (before → after) pair, exactly like `planSeatTransition()` does for ticket
 * seats. `planRoomTransition` is a pure function: easy to test exhaustively,
 * impossible to double-apply.
 *
 * Every release is GUARDED (`bookedRooms > 0`) so a counting bug can never
 * drive the counter negative — negative is worse than wrong, because
 * `available = totalRooms - bookedRooms` would then exceed totalRooms and the
 * `bookedRooms < totalRooms` claim predicate would admit more bookings than
 * there are rooms (a counting bug silently becoming physical overbooking).
 */

/** A booking holds a room iff it isn't cancelled. */
export function holdsRoom(status: string): boolean {
  return status !== "CANCELLED";
}

/** The (status, roomType) pair that determines what a booking holds. */
export interface RoomHolding {
  status: string;
  roomTypeId: string;
}

/**
 * What the counters must do to get from `prev` to `next`. At most one release
 * and at most one claim — never two of either, which is the bug class this
 * replaces.
 */
export interface RoomTransitionPlan {
  release: string | null;
  claim: string | null;
}

/**
 * Derive the net counter movement from the before/after state.
 *
 * Covers every combination in one rule — "what room did it hold, what room
 * should it hold":
 *   active → cancelled ............ release the held room
 *   cancelled → active ............ claim the wanted room
 *   active, room A → room B ....... release A, claim B
 *   cancelled, room A → room B .... nothing (it held nothing, it wants nothing)
 *   active A → cancelled + room B . release A only (NOT twice, NOT B)
 *   cancelled A → active + room B . claim B only
 *   no meaningful change .......... nothing
 */
export function planRoomTransition(prev: RoomHolding, next: RoomHolding): RoomTransitionPlan {
  const held = holdsRoom(prev.status) ? prev.roomTypeId : null;
  const wanted = holdsRoom(next.status) ? next.roomTypeId : null;

  if (held === wanted) return { release: null, claim: null };
  return { release: held, claim: wanted };
}

/**
 * Release one room. GUARDED: the `bookedRooms > 0` predicate means a double
 * release clamps at zero instead of going negative. (The seat model does the
 * same — see `releaseSeat` in registration-seat-db.ts.)
 */
export async function releaseRoom(
  tx: Prisma.TransactionClient,
  roomTypeId: string,
): Promise<void> {
  await tx.roomType.updateMany({
    where: { id: roomTypeId, bookedRooms: { gt: 0 } },
    data: { bookedRooms: { decrement: 1 } },
  });
}

/**
 * Claim one room ATOMICALLY. The `bookedRooms < totalRooms` predicate is the
 * oversell guard — NOT a prior read — so two concurrent claims can't both take
 * the last room. Throws `NO_ROOMS_AVAILABLE` when the room type is full or gone.
 */
export async function claimRoom(
  tx: Prisma.TransactionClient,
  roomTypeId: string,
): Promise<void> {
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

/**
 * Apply a plan inside the caller's transaction. Release first, then claim: if
 * the claim fails (room full) the whole transaction rolls back, so the released
 * room is restored — the booking never ends up holding nothing.
 */
export async function applyRoomTransition(
  tx: Prisma.TransactionClient,
  plan: RoomTransitionPlan,
): Promise<void> {
  if (plan.release) await releaseRoom(tx, plan.release);
  if (plan.claim) await claimRoom(tx, plan.claim);
}

/**
 * Status-only transition (the room type doesn't change). Thin wrapper over the
 * planner, kept because the MCP `update_accommodation_status` tool only ever
 * moves status — it has no room-change surface.
 */
export async function applyRoomStatusTransition(
  tx: Prisma.TransactionClient,
  input: { prevStatus: string; nextStatus: string; roomTypeId: string },
): Promise<void> {
  const { prevStatus, nextStatus, roomTypeId } = input;
  const plan = planRoomTransition(
    { status: prevStatus, roomTypeId },
    { status: nextStatus, roomTypeId },
  );
  await applyRoomTransition(tx, plan);
}
