/**
 * Prisma appliers for the seat model in registration-seat.ts. Kept separate so
 * the model stays pure/unit-testable. They operate on the counter decided by
 * `seatCounter` / `planSeatTransition`, and EXPAND a tier counter to the pair
 * (tier, its ticket type): a tier sale is claimed on the tier's own limit AND
 * on the type's limit, and released from both. That is what makes the ticket
 * type's seat limit a hard ceiling over all of its tiers (registration-seat.ts
 * header, owner decision Sep 8, 2026) without any caller having to know.
 */
import type { Prisma } from "@prisma/client";
import { planSeatTransition, type SeatCounter, type SeatState } from "./registration-seat";

/**
 * Row-truth mirror of `holdsSeat()` + `seatCounter()`: a registration holds a
 * seat under its ticket type when it is not cancelled, attending in person,
 * and not a speaker companion (companions are created uncapped and live on no
 * counter). The explicit OR keeps null `createdSource` rows IN, because Prisma
 * `not` excludes nulls. ONE definition, spread by every recount (the event-cap
 * PUT, the ticket-type PUT); the migration and scripts/reconcile-soldcounts.ts
 * restate it in SQL / via the helpers and a test pins the three predicates.
 */
export const HELD_SEAT_WHERE = {
  status: { not: "CANCELLED" },
  attendanceMode: "IN_PERSON",
  OR: [{ createdSource: null }, { createdSource: { not: "SPEAKER_COMPANION" } }],
} as const satisfies Prisma.RegistrationWhereInput;

/**
 * Lock order, and why it is the parent first. A tier claim or release touches
 * TWO rows, the tier and its ticket type. Every path that moves seats takes
 * them in the order TYPE then TIER: a same-type re-tier (release tier A, claim
 * tier B) and a public purchase of tier B then both wait on the type row
 * before touching any tier, so neither can hold a tier the other needs. With
 * the reverse order the two form a cycle and Postgres kills one of them, which
 * a registrant sees as an error page.
 */
export interface SeatApplyOptions {
  /**
   * Move the tier counter only, leave the ticket type alone. Used for exactly
   * one case: a registration moving between two tiers of the SAME type, where
   * the type's total does not change. Releasing then re-claiming the type there
   * would be refused whenever the type already sits at or over its limit, which
   * would freeze re-tiering on precisely the over-full type an organiser is
   * trying to tidy.
   */
  tierOnly?: boolean;
}

/**
 * Release a seat — guarded decrement that can NEVER take a counter below 0
 * (the `soldCount > 0` predicate). This is the fix for the "leaks down →
 * negative → oversell" half of the bug.
 */
export async function releaseSeats(
  tx: Prisma.TransactionClient,
  counter: SeatCounter,
  count: number,
  opts: SeatApplyOptions = {},
): Promise<void> {
  if (count <= 0) return;
  // `soldCount >= count` so a counter can never drop below 0.
  const guarded = (id: string) => ({ id, soldCount: { gte: count } });
  const data = { soldCount: { decrement: count } };
  if (counter.kind === "tier") {
    const tier = await tx.pricingTier.findUnique({
      where: { id: counter.id },
      select: { ticketTypeId: true },
    });
    // Parent first (lock order, see the header). The type counted this seat
    // too, it is the ceiling over every tier, so it gives the seat back as
    // well. A tier row that no longer exists has no parent to release on.
    if (tier?.ticketTypeId && !opts.tierOnly) {
      await tx.ticketType.updateMany({ where: guarded(tier.ticketTypeId), data });
    }
    await tx.pricingTier.updateMany({ where: guarded(counter.id), data });
    return;
  }
  await tx.ticketType.updateMany({ where: guarded(counter.id), data });
}

export async function releaseSeat(
  tx: Prisma.TransactionClient,
  counter: SeatCounter,
  opts: SeatApplyOptions = {},
): Promise<void> {
  return releaseSeats(tx, counter, 1, opts);
}

/**
 * Claim N seats — atomic capacity-guarded increment on the correct counter.
 * Returns false when the claim doesn't fit (or the counter is missing) so the
 * caller can map it to CAPACITY_EXCEEDED.
 *
 * The guard and the write are ONE statement: `soldCount + N <= quantity`
 * compared in SQL (Prisma `updateMany` cannot compare two columns, so this is
 * raw, the same shape as `claimEventSeats`). Reading `quantity` first and then
 * writing `soldCount <= quantity - N` looked equivalent and was not: a claim
 * that blocked on an organiser's limit change re-checked its WHERE against the
 * new row but with the OLD quantity baked into the literal, and was admitted
 * above the limit that had just been set.
 */
export async function claimSeats(
  tx: Prisma.TransactionClient,
  counter: SeatCounter,
  count: number,
  opts: SeatApplyOptions = {},
): Promise<boolean> {
  if (count <= 0) return true;
  if (counter.kind === "tier") {
    const tier = await tx.pricingTier.findUnique({
      where: { id: counter.id },
      select: { ticketTypeId: true },
    });
    // A tier without a parent type cannot exist (NOT NULL FK). Refusing here
    // rather than skipping the ceiling keeps a malformed row from selling
    // past the type's limit; it can never fire on real data.
    if (!tier || !tier.ticketTypeId) return false;
    if (opts.tierOnly) return claimTierRows(tx, counter.id, count);
    // Parent first (lock order, see the header). The ceiling (owner decision
    // Sep 8, 2026): a tier sale must ALSO fit under its ticket type's limit,
    // which spans every tier plus staff adds. Before this, an organiser's "35
    // seats" on the type was never read by the public form when the type had
    // tiers, and 107 people registered.
    if (!(await claimTypeRows(tx, tier.ticketTypeId, count))) return false;
    if (await claimTierRows(tx, counter.id, count)) return true;
    // The tier refused: give the type's seats back. Every caller aborts its
    // transaction on a false return, which would undo it anyway; doing it
    // here means the two counters cannot disagree even for a caller that
    // does not.
    await tx.ticketType.updateMany({
      where: { id: tier.ticketTypeId, soldCount: { gte: count } },
      data: { soldCount: { decrement: count } },
    });
    return false;
  }
  return claimTypeRows(tx, counter.id, count);
}

/** Guarded claim on a ticket type, one statement: `soldCount + N <= quantity`. */
async function claimTypeRows(
  tx: Prisma.TransactionClient,
  ticketTypeId: string,
  count: number,
): Promise<boolean> {
  const affected = await tx.$executeRaw`
    UPDATE "TicketType"
    SET "soldCount" = "soldCount" + ${count}
    WHERE "id" = ${ticketTypeId}
      AND "soldCount" + ${count} <= "quantity"
  `;
  return affected > 0;
}

/** Guarded claim on a pricing tier, one statement: `soldCount + N <= quantity`. */
async function claimTierRows(
  tx: Prisma.TransactionClient,
  tierId: string,
  count: number,
): Promise<boolean> {
  const affected = await tx.$executeRaw`
    UPDATE "PricingTier"
    SET "soldCount" = "soldCount" + ${count}
    WHERE "id" = ${tierId}
      AND "soldCount" + ${count} <= "quantity"
  `;
  return affected > 0;
}

export async function claimSeat(
  tx: Prisma.TransactionClient,
  counter: SeatCounter,
  opts: SeatApplyOptions = {},
): Promise<boolean> {
  return claimSeats(tx, counter, 1, opts);
}

/**
 * Claim N seats against the EVENT-wide cap (`Event.maxAttendees` /
 * `Event.seatCount`) — atomic conditional increment. Returns false when the
 * event is full so the caller can map it to EVENT_FULL. Raw SQL because the
 * guard compares two columns (`seatCount + N <= maxAttendees`), which Prisma
 * `updateMany` cannot express (same reason as the accommodation
 * `bookedRooms < totalRooms` fix). A null `maxAttendees` (unlimited — the
 * default for every event) still increments so the counter stays warm, but
 * never blocks.
 */
export async function claimEventSeats(
  tx: Prisma.TransactionClient,
  eventId: string,
  count = 1,
): Promise<boolean> {
  if (count <= 0) return true;
  const affected = await tx.$executeRaw`
    UPDATE "Event"
    SET "seatCount" = "seatCount" + ${count}
    WHERE "id" = ${eventId}
      AND ("maxAttendees" IS NULL OR "seatCount" + ${count} <= "maxAttendees")
  `;
  return affected > 0;
}

/**
 * Release N event-wide seats — guarded decrement (`seatCount >= N`), never
 * below 0, mirroring `releaseSeats`. Silent no-op on pre-guard drift; the
 * recompute-on-cap-set in the event PUT self-heals any residue.
 */
export async function releaseEventSeats(
  tx: Prisma.TransactionClient,
  eventId: string,
  count = 1,
): Promise<void> {
  if (count <= 0) return;
  await tx.event.updateMany({
    where: { id: eventId, seatCount: { gte: count } },
    data: { seatCount: { decrement: count } },
  });
}

export interface EventOversellResult {
  /** true when the increment pushed seatCount past maxAttendees — caller must warn-log. */
  oversold: boolean;
  newSeatCount: number | null;
  maxAttendees: number | null;
}

/**
 * Increment the EVENT-wide seat counter WITHOUT the cap guard — the
 * imports-bypass policy (owner decision July 24, 2026): admin bulk imports
 * (CSV / contacts / EventsAir) and bulk reactivation always succeed and the
 * over-cap condition is reported for the caller to warn-log, mirroring
 * `claimSeatsOverselling`. Single manual adds + public register + single
 * reactivations hard-block via `claimEventSeats` instead.
 */
export async function incrementEventSeatsOverselling(
  tx: Prisma.TransactionClient,
  eventId: string,
  count = 1,
): Promise<EventOversellResult> {
  const none: EventOversellResult = { oversold: false, newSeatCount: null, maxAttendees: null };
  if (count <= 0) return none;
  const event = await tx.event.findUnique({
    where: { id: eventId },
    select: { seatCount: true, maxAttendees: true },
  });
  await tx.event.updateMany({
    where: { id: eventId },
    data: { seatCount: { increment: count } },
  });
  if (!event) return none;
  return {
    oversold: event.maxAttendees != null && event.seatCount + count > event.maxAttendees,
    newSeatCount: event.seatCount + count,
    maxAttendees: event.maxAttendees,
  };
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
      select: { quantity: true, soldCount: true, name: true, ticketTypeId: true },
    });
    // Same refusal as claimSeats: a tier with no parent cannot exist, and an
    // `updateMany` keyed on an undefined id would be unfiltered.
    if (!tier || !tier.ticketTypeId) return none;
    // Parent first (lock order). The type (the ceiling) counts the seat too,
    // unguarded like the tier: bulk paths proceed and report, never partial-fail.
    const type = await tx.ticketType.findUnique({
      where: { id: tier.ticketTypeId },
      select: { quantity: true, soldCount: true, name: true },
    });
    await tx.ticketType.updateMany({
      where: { id: tier.ticketTypeId },
      data: { soldCount: { increment: count } },
    });
    await tx.pricingTier.updateMany({
      where: { id: counter.id },
      data: { soldCount: { increment: count } },
    });
    const tierOver = tier.soldCount + count > tier.quantity;
    const typeOver = type != null && type.soldCount + count > type.quantity;
    // Report whichever limit overflowed; the tier first when both did.
    if (tierOver || !typeOver || !type) {
      return {
        oversold: tierOver,
        counterName: tier.name,
        newSoldCount: tier.soldCount + count,
        quantity: tier.quantity,
      };
    }
    return {
      oversold: true,
      counterName: type.name,
      newSoldCount: type.soldCount + count,
      quantity: type.quantity,
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
  /** The registration's event — required so the EVENT-wide seat counter
   *  (`Event.seatCount`) moves with the ticket/tier counter. */
  eventId: string;
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
  // A move between two tiers of the SAME type leaves the type's total as it
  // is, so only the tier counters move (see SeatApplyOptions.tierOnly).
  const tierOnly =
    seat.release?.kind === "tier" &&
    seat.claim?.kind === "tier" &&
    !!input.prev.ticketTypeId &&
    input.prev.ticketTypeId === input.next.ticketTypeId;
  if (seat.release) await releaseSeat(tx, seat.release, { tierOnly });
  if (seat.claim) {
    const claimed = await claimSeat(tx, seat.claim, { tierOnly });
    if (!claimed) throw new Error("CAPACITY_EXCEEDED");
  }
  // Event-wide cap: single-path transitions hard-block when reactivating into a
  // full event (bulk paths use incrementEventSeatsOverselling instead).
  if (seat.eventDelta === -1) {
    await releaseEventSeats(tx, input.eventId);
  } else if (seat.eventDelta === 1) {
    const eventClaimed = await claimEventSeats(tx, input.eventId);
    if (!eventClaimed) throw new Error("EVENT_FULL");
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
