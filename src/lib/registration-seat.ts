/**
 * Seat accounting — the single source of truth for when a registration
 * consumes a physical seat (i.e. counts toward `TicketType.soldCount`).
 *
 * A registration holds a seat IFF it is NOT cancelled AND attending IN_PERSON:
 *   • VIRTUAL attendance is uncapped — it never consumes a venue seat (this is
 *     the hybrid-events rule; create paths already skip soldCount for virtual).
 *   • CANCELLED holds nothing.
 *
 * The update paths (REST PUT + MCP `update_registration`) previously adjusted
 * soldCount off `status` alone, so cancelling / reactivating / type-changing a
 * VIRTUAL registration wrongly moved the counter (a virtual reg never
 * incremented it). Routing every soldCount delta through `planSeatTransition`
 * fixes that and keeps the create/update paths consistent.
 *
 * NOTE: this models the per-`TicketType` counter only. The separate
 * `PricingTier.soldCount` tier-vs-ticketType routing (ROADMAP P1.1) is an
 * orthogonal axis and is intentionally NOT handled here.
 */
import type { RegistrationStatus, AttendanceMode } from "@prisma/client";

/** True when this (status, mode) consumes a venue seat. */
export function holdsSeat(
  status: RegistrationStatus,
  attendanceMode: AttendanceMode,
): boolean {
  return status !== "CANCELLED" && attendanceMode === "IN_PERSON";
}

export interface SeatState {
  status: RegistrationStatus;
  attendanceMode: AttendanceMode;
  ticketTypeId: string | null;
}

export interface SeatTransition {
  /** Decrement this ticket type's soldCount (a seat was released). null = none. */
  release: string | null;
  /** Increment this ticket type's soldCount (a seat is claimed). The caller
   *  applies this with an atomic capacity guard. null = none. */
  claim: string | null;
}

/**
 * Compute the soldCount adjustment for a registration moving from `prev` to
 * `next` — any of status / attendanceMode / ticketTypeId may change. Returns
 * which ticket type (if any) to release a seat on and which to claim a seat on.
 * When the same seat is held before and after on the same ticket type it's a
 * no-op (no redundant -1/+1 on one counter).
 */
export function planSeatTransition(prev: SeatState, next: SeatState): SeatTransition {
  const prevHolds = holdsSeat(prev.status, prev.attendanceMode) && !!prev.ticketTypeId;
  const nextHolds = holdsSeat(next.status, next.attendanceMode) && !!next.ticketTypeId;

  if (prevHolds && nextHolds && prev.ticketTypeId === next.ticketTypeId) {
    return { release: null, claim: null };
  }
  return {
    release: prevHolds ? prev.ticketTypeId : null,
    claim: nextHolds ? next.ticketTypeId : null,
  };
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
