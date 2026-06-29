/**
 * Seat accounting — the single source of truth for when a registration
 * consumes a capacity seat and WHICH counter that seat is tallied on.
 *
 * Two counters exist. Every `TicketType` has `soldCount`; a `TicketType` that
 * uses pricing tiers ALSO has a `soldCount` on each `PricingTier`. A given
 * registration is counted on exactly ONE of them:
 *
 *   • Only the PUBLIC registration path increments `PricingTier.soldCount`
 *     (`createdSource === PUBLIC_REGISTER` with a `pricingTierId`). The
 *     admin/service path always uses `TicketType.soldCount` even when a tier is
 *     chosen (intentional — see registration-service.ts), and virtual nulls the
 *     tier. So the discriminator for "this seat lives on the tier counter" is:
 *         createdSource === PUBLIC_REGISTER && pricingTierId != null
 *     Everything else → the ticket-type counter.
 *
 * A registration HOLDS a seat IFF it is NOT cancelled AND attending IN_PERSON
 * (virtual is uncapped; cancelled holds nothing).
 *
 * Before this model the decrement/transition paths (cancel / reactivate /
 * type-change / delete / bulk) unconditionally moved `TicketType.soldCount`,
 * so a public+tier registration leaked BOTH ways on cancel — the tier counter
 * leaked up (phantom sell-out) and the ticket-type counter leaked down (could
 * go negative → oversell). Routing every delta through `planSeatTransition` +
 * the `releaseSeat`/`claimSeat` appliers (registration-seat-db.ts) fixes it.
 *
 * The apply helpers live in registration-seat-db.ts so this module stays pure
 * (no Prisma import) and unit-testable.
 */
import type {
  RegistrationStatus,
  AttendanceMode,
  RegistrationCreatedSource,
} from "@prisma/client";

/** True when this (status, mode) consumes a capacity seat. */
export function holdsSeat(
  status: RegistrationStatus,
  attendanceMode: AttendanceMode,
): boolean {
  return status !== "CANCELLED" && attendanceMode === "IN_PERSON";
}

/** Which physical counter a seat is tallied on. */
export type SeatCounter =
  | { kind: "tier"; id: string }
  | { kind: "ticketType"; id: string };

export interface SeatState {
  status: RegistrationStatus;
  attendanceMode: AttendanceMode;
  ticketTypeId: string | null;
  pricingTierId: string | null;
  // Nullable in the schema (legacy/untagged rows). A null source is never
  // PUBLIC_REGISTER, so it correctly falls through to the ticket-type counter.
  createdSource: RegistrationCreatedSource | null;
}

/**
 * Which counter a seat for this registration is tallied on — INDEPENDENT of
 * whether it currently holds a seat (caller gates on `holdsSeat`). Public
 * register + tier → the tier counter; everything else → the ticket-type
 * counter. Returns null when there is no ticket type at all (nothing to count).
 */
export function seatCounter(
  state: Pick<SeatState, "createdSource" | "pricingTierId" | "ticketTypeId">,
): SeatCounter | null {
  // A speaker's companion ("attendee facet") is created uncapped with NO
  // soldCount increment (speaker-companion.ts) — faculty don't consume a venue
  // seat. So it lives on no counter: cancel/reactivate/delete move nothing, and
  // reconciliation never counts it. (Excluding by createdSource, not the
  // isFaculty ticket type, is exact — an admin who manually puts someone on the
  // Faculty type via the normal create path DOES increment that counter.)
  if (state.createdSource === "SPEAKER_COMPANION") return null;
  if (state.createdSource === "PUBLIC_REGISTER" && state.pricingTierId) {
    return { kind: "tier", id: state.pricingTierId };
  }
  if (state.ticketTypeId) return { kind: "ticketType", id: state.ticketTypeId };
  return null;
}

export interface SeatTransition {
  /** Release a seat on this counter (guarded decrement). null = none. */
  release: SeatCounter | null;
  /** Claim a seat on this counter (atomic capacity-guarded increment by the
   *  caller, which maps a failed claim to CAPACITY_EXCEEDED). null = none. */
  claim: SeatCounter | null;
}

function sameCounter(a: SeatCounter | null, b: SeatCounter | null): boolean {
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}

/**
 * Compute the seat-counter adjustment for a registration moving from `prev` to
 * `next` — any of status / attendanceMode / ticketTypeId / pricingTierId may
 * change. Returns which counter (if any) to release a seat on and which to claim
 * a seat on. When the held seat lands on the same counter before and after it's
 * a no-op (no redundant -1/+1).
 *
 * IMPORTANT for type-change: callers must pass `next.pricingTierId = null` when
 * the ticket type is changing to a different type — the old tier belongs to the
 * old type, so the seat must move to the NEW ticket-type counter (and the stored
 * row's `pricingTierId` must be nulled to match, or a later cancel would release
 * the wrong counter).
 */
export function planSeatTransition(prev: SeatState, next: SeatState): SeatTransition {
  const prevTarget = holdsSeat(prev.status, prev.attendanceMode) ? seatCounter(prev) : null;
  const nextTarget = holdsSeat(next.status, next.attendanceMode) ? seatCounter(next) : null;

  if (sameCounter(prevTarget, nextTarget)) {
    return { release: null, claim: null };
  }
  return { release: prevTarget, claim: nextTarget };
}

/**
 * The lazy entry-barcode mint: a registration needs a qrCode when it is (or
 * becomes) IN_PERSON and doesn't have one yet — e.g. switching virtual→in-person
 * (virtual is created with a null qrCode). Going the other way keeps the
 * existing qrCode for audit (badge/check-in are suppressed for virtual elsewhere).
 */
export function needsQrCode(
  nextMode: AttendanceMode,
  currentQrCode: string | null,
): boolean {
  return nextMode === "IN_PERSON" && !currentQrCode;
}
