/**
 * The DTCM spare-code pool.
 *
 * DTCM issues a BLOCK of compliance codes a day or two before a Dubai event.
 * The pre-event CSV import maps most of them onto people who have already
 * registered; what is left over is what the desk needs on the day, when
 * someone walks up and registers on the spot. A leftover code has no
 * registration to hang on, so `Registration.dtcmBarcode` cannot hold it, and
 * before this there was nowhere for it to live at all.
 *
 * ## The one design decision worth knowing
 *
 * AVAILABILITY IS DERIVED, NEVER STORED. A pool code is spare iff no
 * registration on that event holds it. `DtcmCode` deliberately has no
 * `assignedRegistrationId` column.
 *
 * The stored alternative is tempting because it makes "find a spare" a single
 * indexed query. It is wrong here because there are already three independent
 * writers of `Registration.dtcmBarcode` — the CSV importer, the registration
 * detail sheet's free-text field, and this module — and a stored flag would
 * have to be reconciled by every one of them. Miss one and the pool believes a
 * code is spare while an attendee is already wearing it, which hands the same
 * compliance credential to two people. That is not a display bug; it is the
 * failure the whole feature exists to avoid.
 *
 * Deriving it cannot go stale, which is the property that matters. Be honest
 * about what it costs, though: it is TWO reads that scan every pool row and
 * every coded registration on the event, not one indexed lookup, and it runs on
 * the public register path. At event scale — hundreds to a few thousand codes,
 * a handful of walk-ups a minute — that is comfortably cheap, and the trade is
 * not close. It would stop being cheap at a scale this feature does not have,
 * and the fix then is a covering index plus a windowed read, NOT a stored flag:
 * the flag's failure mode does not improve with scale, it gets worse.
 *
 * ## Why the claim retries rather than locks
 *
 * Two desk stations can compute the same spare code at the same time. This used
 * to lean on `Registration.dtcmBarcode` being globally UNIQUE — the second write
 * got P2002 and we took the next spare. That constraint was DROPPED on Aug 27
 * 2026 so a human can deliberately give two people one code, so the check is now
 * explicit: after claiming, re-read the holders and keep the code only if we are
 * the lowest registration id among them, else release and take the next.
 *
 * Deterministic on purpose. Both racers backing off would leave a walk-up with
 * no code at all, which is the outcome this whole module exists to prevent.
 * Still no advisory lock and no transaction held across a desk interaction, so
 * correctness does not depend on which connection ran what — the June-2026
 * pooler lesson.
 *
 * Note the asymmetry, which is the design: a HUMAN typing a code may duplicate
 * it; the POOL never does. Otherwise "12 spare" stops meaning anything.
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

/** Stop trying after this many collisions. Only reachable under contention. */
const MAX_CLAIM_ATTEMPTS = 10;

export interface DtcmPoolCounts {
  /** Codes imported into the pool for this event. */
  total: number;
  /** Pool codes a registration on this event currently holds. */
  assigned: number;
  /** Pool codes nobody holds — what the desk can hand out. */
  spare: number;
  /**
   * Registrations holding a DTCM code that is NOT in the pool.
   *
   * Not an error: the pre-event CSV can assign codes that were never imported
   * as spares, and that is the ordinary path. It is surfaced so the counts add
   * up on screen instead of looking like codes went missing.
   */
  assignedOutsidePool: number;
}

/**
 * Read the pool's state. Two indexed reads, no raw SQL — raw operations run
 * outside the tenant lane, which would fail closed under platform RLS.
 */
export async function getDtcmPoolCounts(eventId: string): Promise<DtcmPoolCounts> {
  const [pool, held] = await Promise.all([
    db.dtcmCode.findMany({ where: { eventId }, select: { code: true } }),
    db.registration.findMany({
      where: { eventId, dtcmBarcode: { not: null } },
      select: { dtcmBarcode: true },
    }),
  ]);

  const heldSet = new Set(held.map((r) => r.dtcmBarcode as string));
  const poolSet = new Set(pool.map((c) => c.code));
  const assigned = pool.filter((c) => heldSet.has(c.code)).length;

  return {
    total: pool.length,
    assigned,
    spare: pool.length - assigned,
    assignedOutsidePool: [...heldSet].filter((c) => !poolSet.has(c)).length,
  };
}

export interface ImportDtcmCodesResult {
  imported: number;
  /** Already in this event's pool. Re-importing the same block is harmless. */
  duplicates: number;
}

/**
 * Add codes to an event's pool.
 *
 * Idempotent by `@@unique([eventId, code])` + `skipDuplicates`, so re-running
 * the same file adds nothing — an organiser who is unsure whether the import
 * landed can simply run it again, which is the behaviour they will try anyway.
 *
 * A code that is ALREADY held by someone on this event is still accepted into
 * the pool: the pool records what was issued, and `getDtcmPoolCounts` will
 * correctly report it as assigned rather than spare.
 */
export async function importDtcmCodes(args: {
  eventId: string;
  organizationId: string | null;
  codes: string[];
  importedById: string | null;
}): Promise<ImportDtcmCodesResult> {
  const unique = [...new Set(args.codes.map((c) => c.trim()).filter(Boolean))];
  if (unique.length === 0) return { imported: 0, duplicates: 0 };

  const created = await db.dtcmCode.createMany({
    data: unique.map((code) => ({
      eventId: args.eventId,
      organizationId: args.organizationId,
      code,
      importedById: args.importedById,
    })),
    skipDuplicates: true,
  });

  return { imported: created.count, duplicates: unique.length - created.count };
}

export type ClaimDtcmOutcome =
  | { status: "assigned"; code: string }
  | { status: "already-has-code"; code: string }
  | { status: "pool-empty" }
  /** Not a Dubai event, or a virtual attendee who gets no badge to print on. */
  | { status: "not-applicable" }
  | { status: "failed" };

/**
 * Hand the next spare code to a registration.
 *
 * NEVER THROWS. A compliance code is not a precondition for existing: a walk-up
 * whose registration succeeded must not be rolled back because the pool ran dry
 * or the database hiccuped. Every failure resolves to an outcome the caller can
 * report and an operator can fix by assigning one by hand.
 *
 * Ordering is oldest-import first, then by code, so a block handed out over two
 * days is consumed in a predictable order and a re-import does not jump the
 * queue.
 */
export async function claimSpareDtcmCode(args: {
  eventId: string;
  registrationId: string;
  /**
   * The caller's own reading of `Event.requiresDtcmBarcode`.
   *
   * REQUIRED, and re-verified below against the row rather than trusted. It is
   * a fast path, not the guard: passing `false` costs zero queries on the 95%
   * of events that are not Dubai, and passing `true` wrongly is caught. The
   * asymmetry is deliberate — a wrong `false` means a missing code, which the
   * pool card makes visible; a wrong `true` would mean handing a compliance
   * credential to an event that has none, which nothing would surface.
   */
  requiresDtcm: boolean;
}): Promise<ClaimDtcmOutcome> {
  if (!args.requiresDtcm) return { status: "not-applicable" };
  try {
    const existing = await db.registration.findFirst({
      where: { id: args.registrationId, eventId: args.eventId },
      select: {
        dtcmBarcode: true,
        attendanceMode: true,
        event: { select: { requiresDtcmBarcode: true } },
      },
    });
    if (!existing) return { status: "failed" };
    // The guard proper. Both of these are also true of the badge renderer: a
    // non-Dubai event prints no QR, and a virtual attendee has no badge at all.
    if (!existing.event?.requiresDtcmBarcode) return { status: "not-applicable" };
    if (existing.attendanceMode === "VIRTUAL") return { status: "not-applicable" };
    // Never overwrite. A code already on the row was put there deliberately —
    // by the CSV import or by an organiser — and replacing it would revoke a
    // credential that may already be printed on a badge.
    if (existing.dtcmBarcode) {
      return { status: "already-has-code", code: existing.dtcmBarcode };
    }

    const [pool, held] = await Promise.all([
      db.dtcmCode.findMany({
        where: { eventId: args.eventId },
        select: { code: true },
        orderBy: [{ importedAt: "asc" }, { code: "asc" }],
      }),
      db.registration.findMany({
        where: { eventId: args.eventId, dtcmBarcode: { not: null } },
        select: { dtcmBarcode: true },
      }),
    ]);

    const heldSet = new Set(held.map((r) => r.dtcmBarcode as string));
    const spares = pool.map((c) => c.code).filter((c) => !heldSet.has(c));

    if (spares.length === 0) {
      apiLogger.warn(
        {
          msg: "dtcm-pool:empty",
          eventId: args.eventId,
          registrationId: args.registrationId,
          poolSize: pool.length,
        },
        "No spare DTCM code left for this event",
      );
      return { status: "pool-empty" };
    }

    for (const code of spares.slice(0, MAX_CLAIM_ATTEMPTS)) {
      try {
        // Conditional claim: `dtcmBarcode: null` means a code that landed on
        // this row between the read above and here (a concurrent CSV import)
        // wins, and we do not clobber it.
        const claim = await db.registration.updateMany({
          where: { id: args.registrationId, eventId: args.eventId, dtcmBarcode: null },
          data: { dtcmBarcode: code },
        });
        if (claim.count === 0) {
          const fresh = await db.registration.findFirst({
            where: { id: args.registrationId, eventId: args.eventId },
            select: { dtcmBarcode: true },
          });
          return fresh?.dtcmBarcode
            ? { status: "already-has-code", code: fresh.dtcmBarcode }
            : { status: "failed" };
        }
        // The constraint used to be the contention signal: a second station
        // writing the same code got P2002 and we moved on. `dtcmBarcode` stopped
        // being unique on Aug 27 2026, so that signal is gone and the check is
        // now explicit.
        //
        // Sharing is something a HUMAN may choose to do by typing a code; the
        // POOL must still hand each spare to exactly one person, or "N spare"
        // means nothing. The tie-break is deterministic — lowest registration id
        // keeps it — so two stations racing converge instead of both backing off
        // and leaving the desk with nothing.
        const holders = await db.registration.findMany({
          where: { eventId: args.eventId, dtcmBarcode: code },
          select: { id: true },
          orderBy: { id: "asc" },
        });
        if (holders.length > 1 && holders[0]?.id !== args.registrationId) {
          await db.registration.updateMany({
            where: { id: args.registrationId, eventId: args.eventId, dtcmBarcode: code },
            data: { dtcmBarcode: null },
          });
          apiLogger.warn(
            {
              msg: "dtcm-pool:claim-lost-race",
              eventId: args.eventId,
              registrationId: args.registrationId,
              codePrefix: code.slice(0, 8),
              holders: holders.length,
            },
            "Another registration claimed this spare first — taking the next",
          );
          continue;
        }

        apiLogger.info(
          {
            msg: "dtcm-pool:assigned",
            eventId: args.eventId,
            registrationId: args.registrationId,
            // Truncated: the full value is a compliance credential and this
            // line is read in /logs, which is broader than the code's audience.
            codePrefix: code.slice(0, 8),
            sparesBefore: spares.length,
          },
          "Assigned a spare DTCM code",
        );
        return { status: "assigned", code };
      } catch (err) {
        // Kept as a belt: `dtcmBarcode` is no longer unique, so this branch is
        // unreachable through that column — but a P2002 from any OTHER unique
        // on this row is still the same "someone got there first" outcome, and
        // treating it as fatal would fail a walk-up over a recoverable race.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          continue;
        }
        throw err;
      }
    }

    apiLogger.warn(
      {
        msg: "dtcm-pool:claim-exhausted",
        eventId: args.eventId,
        registrationId: args.registrationId,
        attempts: Math.min(spares.length, MAX_CLAIM_ATTEMPTS),
      },
      "Every spare DTCM code attempted collided — assign one by hand",
    );
    return { status: "failed" };
  } catch (err) {
    apiLogger.error(
      { err, msg: "dtcm-pool:claim-failed", eventId: args.eventId, registrationId: args.registrationId },
      "Could not assign a DTCM code",
    );
    return { status: "failed" };
  }
}
