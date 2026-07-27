/**
 * Import fallback registration type — the ONE rule for "which registration type
 * does an imported row land on when the file doesn't say".
 *
 * Both importers used to grab an arbitrary row as their default: the CSV import
 * took `findMany({ where: { eventId, isActive: true } })[0]` and the EventsAir
 * import an equally unordered `findFirst`. Postgres returns heap order with no
 * `orderBy`, and heap order shifts whenever a row is UPDATEd — so the pick was
 * effectively random, and neither excluded faculty types. On July 27, 2026 that
 * put 502 imported delegates (physicians, pharmacists, students) onto a type
 * named "Faculty" on a live event.
 *
 * The rule now: **never guess.** An imported row takes a registration type only
 * when the file names one, or the organizer explicitly picks a fallback for the
 * rows that don't. Otherwise `ticketTypeId` stays null, which the system
 * already supports end-to-end:
 *
 *   • schema  — `Registration.ticketTypeId` is nullable
 *   • seats   — `seatCounter()` returns null (no ticket-type counter to move);
 *               the event-wide cap still counts the person
 *   • stats   — `EXCLUDE_FACULTY_WHERE` deliberately keeps null-ticketType rows,
 *               so an uncategorised import still counts as a delegate
 *   • UI      — the list renders "—", and bulk "Change Type" assigns one later
 *
 * An honest blank beats a confident wrong answer: a wrong type silently
 * propagates into badges, delegate counts, revenue and public capacity, and
 * nothing in the import report hints that it happened.
 *
 * Faculty types are never selectable as the fallback. The hidden `isFaculty`
 * type backs speaker companions (comp, uncapped, excluded from delegate counts
 * via `EXCLUDE_FACULTY_WHERE`), so a delegate that lands there is invisible in
 * every delegate-facing statistic.
 */
import { db } from "@/lib/db";

/** The ticket-type shape both importers need to price + seat a row. */
export interface ImportTicketType {
  id: string;
  name: string;
  /** Prisma `Decimal` at runtime; read via `Number(...)`. */
  price: unknown;
  quantity: number;
  requiresApproval: boolean;
  isFaculty: boolean;
}

/** Prisma `select` producing an `ImportTicketType`. */
export const IMPORT_TICKET_TYPE_SELECT = {
  id: true,
  name: true,
  price: true,
  quantity: true,
  requiresApproval: true,
  isFaculty: true,
} as const;

export type ImportFallbackResult =
  | { ok: true; ticketType: ImportTicketType | null }
  | { ok: false; code: "TICKET_TYPE_NOT_FOUND" | "TICKET_TYPE_IS_FACULTY"; message: string };

/**
 * Resolve the organizer-picked fallback registration type for an import.
 *
 * Returns `{ ticketType: null }` when none was requested — that is the normal,
 * intended outcome, NOT an error: rows without a type stay uncategorised.
 *
 * An inactive type IS accepted when explicitly chosen (same courtesy the manual
 * Add-Registration form extends to closed pricing tiers — the organizer is
 * stating a fact about people who already registered). A faculty type is not,
 * at any time.
 */
export async function resolveImportFallbackTicketType(
  eventId: string,
  requestedId?: string | null,
): Promise<ImportFallbackResult> {
  const id = requestedId?.trim();
  if (!id) return { ok: true, ticketType: null };

  const ticketType = await db.ticketType.findFirst({
    where: { id, eventId },
    select: IMPORT_TICKET_TYPE_SELECT,
  });

  if (!ticketType) {
    return {
      ok: false,
      code: "TICKET_TYPE_NOT_FOUND",
      message: "The selected registration type does not belong to this event.",
    };
  }

  if (ticketType.isFaculty) {
    return {
      ok: false,
      code: "TICKET_TYPE_IS_FACULTY",
      message:
        "The Faculty registration type is reserved for speakers and cannot be used as an import default.",
    };
  }

  return { ok: true, ticketType };
}

/**
 * Does this event charge for registration?
 *
 * Gates whether an import may leave rows uncategorised. On a FREE event a null
 * `ticketTypeId` costs nothing — the row owes nothing either way. On a PAID
 * event it is a silent revenue hole: the row defaults to COMPLIMENTARY, the
 * registrant's Pay Now 400s ("Registration has no ticket type"), no quote or
 * invoice is produced, and no payment reminder ever chases it. So a paid event
 * must be told which type an otherwise-typeless row belongs to.
 *
 * Checks pricing TIERS as well as the type's own price, because the standard
 * tier setup leaves the type's base price at 0 and puts the real money on the
 * tiers (Early Bird / Standard / Onsite). Reading `price` alone would report a
 * fully-priced conference as free — the recurring "tier-priced base looks
 * free" trap. Inactive tiers count: a closed Early Bird still proves the event
 * charges.
 */
export async function eventChargesForRegistration(eventId: string): Promise<boolean> {
  const priced = await db.ticketType.count({
    where: {
      eventId,
      isFaculty: false,
      OR: [{ price: { gt: 0 } }, { pricingTiers: { some: { price: { gt: 0 } } } }],
    },
  });
  return priced > 0;
}
