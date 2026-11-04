import { pickMainRegisterTier, readMainRegisterTiers } from "@/lib/main-register-tiers";

/**
 * Whether the public can register, and at which rate: ONE rule for every
 * public surface (Nov 4, 2026). The public event API computes each rate's
 * availability with `tierAvailability`; the register page decides where its
 * main link lands with `mainRegisterTarget`; the event page at /e/{slug} asks
 * the same two functions, so it can never say "Register" when the form would
 * say closed or full. Before this the event page re-implemented the rules and
 * missed two of them on its first day (the event-wide cap, sponsor-code-only
 * rates): the review of 9c68930b.
 *
 * Client-safe: pure, no Node imports (the register page is a client page).
 */

/** "No seat limit": the default quantity on a type or tier. */
export const UNLIMITED_SEAT_SENTINEL = 999999;

type Window = { salesStart: Date | string | null; salesEnd: Date | string | null };

/**
 * One rate's availability under its registration type. The type's own limit
 * is the ceiling over all its rates (registration-seat.ts): a rate with 40
 * seats free under a type with 3 left has 3 available.
 */
export function tierAvailability(
  tier: { quantity: number; soldCount: number } & Window,
  type: { quantity: number; soldCount: number },
  now: Date,
) {
  const typeAvailable = type.quantity - type.soldCount;
  const available = Math.min(tier.quantity - tier.soldCount, typeAvailable);
  const salesStarted = !tier.salesStart || new Date(tier.salesStart) <= now;
  const salesEnded = tier.salesEnd ? new Date(tier.salesEnd) < now : false;
  return {
    available,
    // True when EITHER limit is real, so the public form can show "N seats
    // left" for an unlimited rate under a limited type.
    seatLimited: type.quantity < UNLIMITED_SEAT_SENTINEL || tier.quantity < UNLIMITED_SEAT_SENTINEL,
    soldOut: available <= 0,
    salesStarted,
    salesEnded,
    canPurchase: available > 0 && salesStarted && !salesEnded,
  };
}

/** The event-wide attendee cap (Settings → Maximum Attendees) is reached. */
export function eventIsFull(event: { maxAttendees: number | null; seatCount: number }): boolean {
  return event.maxAttendees != null && event.seatCount >= event.maxAttendees;
}

/**
 * The rate the main /register link lands on, or undefined when it shows the
 * closed page: the master switch is off, the event-wide cap is reached (except
 * on a HYBRID event, where uncapped virtual attendance stays open), or no
 * ticked rate is on sale. Sponsor-code-only rates are never a landing: a
 * visitor without the code could not use them.
 */
export function mainRegisterTarget<T extends { name: string; sortOrder?: number | null; canPurchase: boolean }>(event: {
  registrationOpen: boolean;
  eventFull: boolean;
  eventType: string | null | undefined;
  ticketTypes: ReadonlyArray<{ pricingTiers?: T[] | null }>;
  mainRegisterTiers?: unknown;
  codeRequiredTiers?: readonly string[] | null;
}): T | undefined {
  if (!event.registrationOpen) return undefined;
  if (event.eventFull && event.eventType !== "HYBRID") return undefined;
  const ticked = readMainRegisterTiers({ mainRegisterTiers: event.mainRegisterTiers }).filter(
    (slug) => !(event.codeRequiredTiers ?? []).includes(slug),
  );
  return pickMainRegisterTier(event.ticketTypes, ticked);
}
