/**
 * Prisma appliers for the seat model in registration-seat.ts. Kept separate so
 * the model stays pure/unit-testable. Both operate on the correct counter
 * (PricingTier or TicketType) as decided by `seatCounter` / `planSeatTransition`.
 */
import type { Prisma } from "@prisma/client";
import { planSeatTransition, type SeatCounter, type SeatState } from "./registration-seat";

/**
 * Release a seat — guarded decrement that can NEVER take a counter below 0
 * (the `soldCount > 0` predicate). This is the fix for the "leaks down →
 * negative → oversell" half of the bug.
 */
export async function releaseSeats(
  tx: Prisma.TransactionClient,
  counter: SeatCounter,
  count: number,
): Promise<void> {
  if (count <= 0) return;
  // `soldCount >= count` so the counter can never drop below 0.
  const where = { id: counter.id, soldCount: { gte: count } };
  const data = { soldCount: { decrement: count } };
  if (counter.kind === "tier") {
    await tx.pricingTier.updateMany({ where, data });
  } else {
    await tx.ticketType.updateMany({ where, data });
  }
}

export async function releaseSeat(
  tx: Prisma.TransactionClient,
  counter: SeatCounter,
): Promise<void> {
  return releaseSeats(tx, counter, 1);
}

/**
 * Claim a seat — atomic capacity-guarded increment on the correct counter.
 * Returns false when the counter is at capacity (or missing) so the caller can
 * map it to CAPACITY_EXCEEDED. The `soldCount < quantity` predicate is the
 * oversell guard; quantity is read first because Prisma `updateMany` can't
 * compare two columns in `where`.
 */
export async function claimSeat(
  tx: Prisma.TransactionClient,
  counter: SeatCounter,
): Promise<boolean> {
  if (counter.kind === "tier") {
    const tier = await tx.pricingTier.findUnique({
      where: { id: counter.id },
      select: { quantity: true },
    });
    if (!tier) return false;
    const res = await tx.pricingTier.updateMany({
      where: { id: counter.id, soldCount: { lt: tier.quantity } },
      data: { soldCount: { increment: 1 } },
    });
    return res.count > 0;
  }
  const ticket = await tx.ticketType.findUnique({
    where: { id: counter.id },
    select: { quantity: true },
  });
  if (!ticket) return false;
  const res = await tx.ticketType.updateMany({
    where: { id: counter.id, soldCount: { lt: ticket.quantity } },
    data: { soldCount: { increment: 1 } },
  });
  return res.count > 0;
}

export interface RegistrationTransitionInput {
  prev: SeatState;
  next: SeatState;
  promoCodeId?: string | null;
}

/**
 * Single source of truth for the **seat + promo** side effects of a registration
 * status/type/tier/mode transition, applied inside the caller's `tx`. Replaces
 * the hand-mirrored copies that used to live in the REST PUT route, the MCP
 * `update_registration` tool, and `payment-service.cancelRegistration` (the
 * "MUST mirror the REST route" duplication — see src/services/README.md "THE RULE").
 *
 * - Releases the previous seat counter and/or claims the next (atomic oversell
 *   guard via `claimSeat`). Throws `Error("CAPACITY_EXCEEDED")` — the sentinel
 *   every caller already maps — when a claim can't be satisfied.
 * - Releases the promo `usedCount` when the registration is becoming CANCELLED.
 *
 * Does NOT sync `attendee.registrationType` (that stays with the type-change
 * path) and does NOT set the registration's own status/fields (the caller owns
 * the row update + its optimistic/claim lock). Bulk status changes use their own
 * batched aggregation (`releaseSeats`) — a documented mechanics exception.
 */
export async function applyRegistrationTransition(
  tx: Prisma.TransactionClient,
  input: RegistrationTransitionInput,
): Promise<void> {
  const seat = planSeatTransition(input.prev, input.next);
  if (seat.release) await releaseSeat(tx, seat.release);
  if (seat.claim) {
    const claimed = await claimSeat(tx, seat.claim);
    if (!claimed) throw new Error("CAPACITY_EXCEEDED");
  }
  const becomingCancelled = input.next.status === "CANCELLED" && input.prev.status !== "CANCELLED";
  if (becomingCancelled && input.promoCodeId) {
    await tx.promoCode.update({ where: { id: input.promoCodeId }, data: { usedCount: { decrement: 1 } } });
  }
}
