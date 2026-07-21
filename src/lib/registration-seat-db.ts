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
 * Claim N seats — atomic capacity-guarded increment on the correct counter.
 * Returns false when the claim doesn't fit (or the counter is missing) so the
 * caller can map it to CAPACITY_EXCEEDED. All-or-nothing: `soldCount <=
 * quantity - count` ensures soldCount + count never exceeds the cap even under
 * a concurrent claim; quantity is read first (inside the caller's tx) because
 * Prisma `updateMany` can't compare two columns in `where`.
 */
export async function claimSeats(
  tx: Prisma.TransactionClient,
  counter: SeatCounter,
  count: number,
): Promise<boolean> {
  if (count <= 0) return true;
  if (counter.kind === "tier") {
    const tier = await tx.pricingTier.findUnique({
      where: { id: counter.id },
      select: { quantity: true },
    });
    if (!tier) return false;
    const res = await tx.pricingTier.updateMany({
      where: { id: counter.id, soldCount: { lte: tier.quantity - count } },
      data: { soldCount: { increment: count } },
    });
    return res.count > 0;
  }
  const ticket = await tx.ticketType.findUnique({
    where: { id: counter.id },
    select: { quantity: true },
  });
  if (!ticket) return false;
  const res = await tx.ticketType.updateMany({
    where: { id: counter.id, soldCount: { lte: ticket.quantity - count } },
    data: { soldCount: { increment: count } },
  });
  return res.count > 0;
}

export async function claimSeat(
  tx: Prisma.TransactionClient,
  counter: SeatCounter,
): Promise<boolean> {
  return claimSeats(tx, counter, 1);
}

export interface OversellingClaimResult {
  /** true when the increment pushed soldCount past quantity — caller must log it. */
  oversold: boolean;
  counterName: string | null;
  newSoldCount: number | null;
  quantity: number | null;
}

/**
 * Claim N seats WITHOUT a capacity guard — the bulk-reactivation policy: a bulk
 * status change can't cleanly partial-fail 200 rows on a capacity guard, so it
 * proceeds and reports the oversell for the caller to warn-log (single-row paths
 * still hard-block via `claimSeats`). Extracted from the hand-rolled tier/ticket
 * branches in the MCP `bulk_update_registration_status` executor so the
 * oversell-allowed mechanics live next to the guarded ones.
 */
export async function claimSeatsOverselling(
  tx: Prisma.TransactionClient,
  counter: SeatCounter,
  count: number,
): Promise<OversellingClaimResult> {
  const none: OversellingClaimResult = { oversold: false, counterName: null, newSoldCount: null, quantity: null };
  if (count <= 0) return none;
  if (counter.kind === "tier") {
    const tier = await tx.pricingTier.findUnique({
      where: { id: counter.id },
      select: { quantity: true, soldCount: true, name: true },
    });
    await tx.pricingTier.updateMany({
      where: { id: counter.id },
      data: { soldCount: { increment: count } },
    });
    if (!tier) return none;
    return {
      oversold: tier.soldCount + count > tier.quantity,
      counterName: tier.name,
      newSoldCount: tier.soldCount + count,
      quantity: tier.quantity,
    };
  }
  const ticket = await tx.ticketType.findUnique({
    where: { id: counter.id },
    select: { quantity: true, soldCount: true, name: true },
  });
  await tx.ticketType.updateMany({
    where: { id: counter.id },
    data: { soldCount: { increment: count } },
  });
  if (!ticket) return none;
  return {
    oversold: ticket.soldCount + count > ticket.quantity,
    counterName: ticket.name,
    newSoldCount: ticket.soldCount + count,
    quantity: ticket.quantity,
  };
}

/**
 * Release N promo-code redemptions — guarded so the counter can NEVER go
 * negative. Single source of truth for the promo half of cancel/delete: the MCP
 * bulk executor and the REST delete route used to hand-roll an UNGUARDED
 * `promoCode.update({ decrement })` here, which could drive `usedCount` below 0
 * (a maxUses-capped code then admits extra redemptions).
 *
 * When the counter holds fewer than `count` (pre-guard drift, double release),
 * the release clamps toward 0 instead of no-oping — "release everything still
 * held" is the correct bulk semantics.
 */
export async function releasePromoUsage(
  tx: Prisma.TransactionClient,
  promoCodeId: string,
  count = 1,
): Promise<void> {
  if (count <= 0) return;
  const res = await tx.promoCode.updateMany({
    where: { id: promoCodeId, usedCount: { gte: count } },
    data: { usedCount: { decrement: count } },
  });
  if (res.count === 0) {
    // Counter holds fewer than `count` — release what's actually held. This is
    // a RELATIVE guarded decrement, deliberately NOT an absolute `set 0`
    // (review M1): an absolute set could erase a redemption a concurrent
    // registration committed between these two statements; a relative
    // decrement leaves it intact, and the `gte` guard still floors at 0.
    const row = await tx.promoCode.findUnique({
      where: { id: promoCodeId },
      select: { usedCount: true },
    });
    const dec = Math.min(count, row?.usedCount ?? 0);
    if (dec > 0) {
      await tx.promoCode.updateMany({
        where: { id: promoCodeId, usedCount: { gte: dec } },
        data: { usedCount: { decrement: dec } },
      });
    }
  }
}

/**
 * Re-claim N promo-code redemptions on reactivation (review H6 symmetry — the
 * registration kept its promoCodeId + discountAmount through the cancel, so its
 * redemption goes live again). `updateMany` (not `update`) so a hard-deleted
 * promo row is a no-op, not a throw. Deliberately NOT capacity-gated on maxUses:
 * it restores a redemption the registration already held.
 */
export async function claimPromoUsage(
  tx: Prisma.TransactionClient,
  promoCodeId: string,
  count = 1,
): Promise<void> {
  if (count <= 0) return;
  await tx.promoCode.updateMany({
    where: { id: promoCodeId },
    data: { usedCount: { increment: count } },
  });
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
 * - Promo `usedCount` moves SYMMETRICALLY with the status (review H6):
 *   becoming CANCELLED releases it (guarded — never below 0, matching
 *   `releaseExistingRedemption` in promo-code-service); leaving CANCELLED
 *   re-claims it, because the registration kept its `promoCodeId` +
 *   `discountAmount` through the cancel, so its redemption goes live again on
 *   reactivation. Without the re-claim, cancel → reactivate → cancel
 *   double-decremented (a maxUses-capped code admitted extra redemptions and
 *   the counter could go negative). The re-claim is deliberately NOT capacity-
 *   gated on maxUses — it restores a redemption the registration already held,
 *   same policy as bulk seat reactivation (proceed + visible counter).
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
  if (!input.promoCodeId) return;
  const becomingCancelled = input.next.status === "CANCELLED" && input.prev.status !== "CANCELLED";
  const becomingActive = input.prev.status === "CANCELLED" && input.next.status !== "CANCELLED";
  if (becomingCancelled) {
    await releasePromoUsage(tx, input.promoCodeId);
  } else if (becomingActive) {
    await claimPromoUsage(tx, input.promoCodeId);
  }
}
