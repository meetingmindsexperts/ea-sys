/**
 * One-off: leave an event with ONE Faculty type (owner, Nov 12, 2026: "why so
 * many separate faculty, can we just keep one").
 *
 * Two events held two: the 4th GCC Hematology Hub ("Faculty", 37
 * registrations, and "Faculty.", 6) and HEMNET 2026 (one empty and switched
 * off, one with 7). Both began with an ordinary "Faculty" type from the
 * organisation's default list and were given a built-in one beside it before
 * Oct 22, 2026, when adopting the ordinary one replaced making a second;
 * scripts/adopt-ordinary-faculty-type.ts then made the ordinary one a Faculty
 * type as well. The system adds new faculty to the OLDEST Faculty type
 * (ensureFacultyTicketType), so on HEMNET they would land on the empty one,
 * apart from the other seven.
 *
 * What it does, for each event that holds more than one Faculty type:
 *   1. Picks the one to KEEP: the type with the most registrations; on a tie
 *      the active one, then the oldest. Or the one you name with --keep.
 *   2. For every other Faculty type (a "donor"), in one transaction:
 *        - moves its registrations, cancelled ones included, onto the kept
 *          type. Nothing else on a registration changes: not its status,
 *          payment, badge, barcode, number, speaker link or where it came from.
 *        - moves the donor's seat count onto the kept type (a Faculty
 *          registration normally holds no seat; one imported while the type
 *          was still an ordinary type does, and its seat moves with it).
 *        - where an attendee's own type text is just the donor's NAME, makes
 *          it the kept type's name, so the Registrations list does not show
 *          the old name as if it were a profession.
 *        - deletes the donor type, now empty, with its unused rates.
 *      One audit row per donor records what it was and which registrations
 *      moved.
 *
 * A donor is LEFT, and listed, when something else still points at it: a rate
 * of its own in use on a registration, a promo code limited to it, a shared
 * registration view or a scheduled email filtered on it, or a mention of its
 * id in the event's settings (the DTCM section map). Those are yours to move
 * first; the script does not guess.
 *
 * No email is sent. Dry run by default.
 *
 *   docker exec ea-sys-worker npx tsx scripts/merge-faculty-types.ts --all             # dry run, every such event
 *   docker exec ea-sys-worker npx tsx scripts/merge-faculty-types.ts --all --write     # apply
 *   docker exec ea-sys-worker npx tsx scripts/merge-faculty-types.ts --event <eventId> [--keep <ticketTypeId>] [--write]
 *
 * Safe to run again: an event with one Faculty type is not in the plan. To
 * undo: the audit rows (FACULTY_TYPES_MERGED) hold the donor's details and the
 * moved registration ids; recreate the type and move them back by hand.
 */
import { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { refreshEventStats } from "../src/lib/event-stats";
import { equalsIgnoringCase } from "../src/lib/like-escape";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export interface FacultyTypeInfo {
  id: string;
  name: string;
  createdAt: Date;
  isActive: boolean;
  soldCount: number;
  /** Every registration on it, cancelled ones included: all of them move. */
  registrations: number;
}

/** The type to keep: most registrations, then the active one, then the oldest. */
export function chooseKeeper(types: readonly FacultyTypeInfo[], keepId?: string): FacultyTypeInfo {
  if (keepId) {
    const named = types.find((t) => t.id === keepId);
    if (!named) throw new Error(`--keep ${keepId} is not a Faculty type of this event`);
    return named;
  }
  return [...types].sort(
    (a, b) => b.registrations - a.registrations || Number(b.isActive) - Number(a.isActive) || a.createdAt.getTime() - b.createdAt.getTime(),
  )[0];
}

/** What else points at a donor type. Any of these and the donor is left for the operator. */
export interface DonorReferences {
  /** Registrations (anywhere on the event) priced on one of the donor's own rates. */
  ratesInUse: number;
  promoCodes: number;
  shareLinks: number;
  scheduledEmails: number;
  inEventSettings: boolean;
}

export function donorBlocks(refs: DonorReferences): string[] {
  const blocks: string[] = [];
  if (refs.ratesInUse > 0) blocks.push(`${refs.ratesInUse} registration(s) are priced on one of its rates`);
  if (refs.promoCodes > 0) blocks.push(`${refs.promoCodes} promo code(s) are limited to it`);
  if (refs.shareLinks > 0) blocks.push(`${refs.shareLinks} shared registration view(s) filter on it`);
  if (refs.scheduledEmails > 0) blocks.push(`${refs.scheduledEmails} scheduled email(s) filter on it`);
  if (refs.inEventSettings) blocks.push("the event's settings mention it (the DTCM section map)");
  return blocks;
}

async function referencesTo(eventId: string, typeId: string): Promise<DonorReferences> {
  const [ratesInUse, promoCodes, shareLinks, scheduled, event] = await Promise.all([
    db.registration.count({ where: { eventId, pricingTier: { ticketTypeId: typeId } } }),
    db.promoCodeTicketType.count({ where: { ticketTypeId: typeId } }),
    db.registrationShareLink.count({ where: { eventId, ticketTypeIds: { has: typeId } } }),
    db.scheduledEmail.findMany({ where: { eventId }, select: { filters: true } }),
    db.event.findUnique({ where: { id: eventId }, select: { settings: true } }),
  ]);
  return {
    ratesInUse,
    promoCodes,
    shareLinks,
    scheduledEmails: scheduled.filter((s) => JSON.stringify(s.filters ?? null).includes(typeId)).length,
    inEventSettings: JSON.stringify(event?.settings ?? null).includes(typeId),
  };
}

interface EventTarget { id: string; name: string }

async function facultyTypesOf(eventId: string): Promise<FacultyTypeInfo[]> {
  const types = await db.ticketType.findMany({
    where: { eventId, isFaculty: true },
    select: { id: true, name: true, createdAt: true, isActive: true, soldCount: true, _count: { select: { registrations: true } } },
    orderBy: { createdAt: "asc" },
  });
  return types.map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt, isActive: t.isActive, soldCount: t.soldCount, registrations: t._count.registrations }));
}

const describeType = (t: FacultyTypeInfo) =>
  `"${t.name}" (${t.id}): ${t.registrations} registration(s), ${t.isActive ? "active" : "switched off"}, made ${t.createdAt.toISOString().slice(0, 10)}`;

/** Move one donor's registrations onto the kept type and delete the donor. All or nothing. */
async function mergeDonor(event: EventTarget, keeper: FacultyTypeInfo, donor: FacultyTypeInfo): Promise<number> {
  const moved = await db.$transaction(async (tx) => {
    const rows = await tx.registration.findMany({ where: { eventId: event.id, ticketTypeId: donor.id }, select: { id: true, attendeeId: true } });
    const ids = rows.map((r) => r.id);
    await tx.registration.updateMany({ where: { id: { in: ids }, ticketTypeId: donor.id }, data: { ticketTypeId: keeper.id } });
    // The donor's counted seats belong to the rows that just moved.
    const fresh = await tx.ticketType.findUniqueOrThrow({ where: { id: donor.id }, select: { soldCount: true } });
    if (fresh.soldCount > 0) {
      await tx.ticketType.update({ where: { id: keeper.id }, data: { soldCount: { increment: fresh.soldCount } } });
    }
    // An attendee's own type text that is only the donor's name follows the
    // type. Exactly that name whatever its case (equalsIgnoringCase: a plain
    // insensitive match is ILIKE, where "_" in a name would match anything).
    const sameName = donor.name.trim().toLowerCase() === keeper.name.trim().toLowerCase();
    const renamed = sameName
      ? { count: 0 }
      : await tx.attendee.updateMany({
          where: { id: { in: rows.map((r) => r.attendeeId) }, registrationType: equalsIgnoringCase(donor.name) },
          data: { registrationType: keeper.name },
        });
    const left = await tx.registration.count({ where: { ticketTypeId: donor.id } });
    if (left > 0) throw new Error(`${left} registration(s) appeared on "${donor.name}" while it was being merged; nothing was changed`);
    await tx.ticketType.delete({ where: { id: donor.id } });
    await tx.auditLog.create({
      data: {
        eventId: event.id,
        action: "FACULTY_TYPES_MERGED",
        entityType: "TicketType",
        entityId: keeper.id,
        changes: {
          source: "script",
          script: "merge-faculty-types",
          kept: { id: keeper.id, name: keeper.name },
          deleted: { id: donor.id, name: donor.name, createdAt: donor.createdAt.toISOString(), isActive: donor.isActive, soldCount: fresh.soldCount },
          movedRegistrationIds: ids,
          attendeeTypeTextRenamed: renamed.count,
        } as Prisma.InputJsonValue,
      },
    });
    return ids.length;
  });
  return moved;
}

/** Plan, print and (with --write) merge one event. Returns how many donors failed. */
async function runEvent(event: EventTarget, write: boolean, keepId: string | undefined): Promise<number> {
  const types = await facultyTypesOf(event.id);
  console.log(`\n${write ? "WRITE" : "DRY RUN"}: ${event.name}`);
  if (types.length < 2) {
    console.log(`  ${types.length === 1 ? "One Faculty type already" : "No Faculty type"}: nothing to do.`);
    return 0;
  }
  const keeper = chooseKeeper(types, keepId);
  console.log(`  KEEP   ${describeType(keeper)}`);
  let failed = 0;
  for (const donor of types.filter((t) => t.id !== keeper.id)) {
    const blocks = donorBlocks(await referencesTo(event.id, donor.id));
    if (blocks.length > 0) {
      console.log(`  LEFT   ${describeType(donor)}`);
      for (const block of blocks) console.log(`         because ${block}`);
      continue;
    }
    console.log(`  MERGE  ${describeType(donor)}: its registrations move to "${keeper.name}", then it is deleted`);
    if (!write) continue;
    try {
      const moved = await mergeDonor(event, keeper, donor);
      console.log(`         done: ${moved} registration(s) moved, "${donor.name}" deleted`);
    } catch (err) {
      failed += 1;
      console.error(`         FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (write) refreshEventStats(event.id);
  return failed;
}

const USAGE = "Usage: merge-faculty-types.ts (--all | --event <eventId> [--keep <ticketTypeId>]) [--write]";

async function main() {
  const eventId = arg("--event");
  const all = process.argv.includes("--all");
  const write = process.argv.includes("--write");
  const keepId = arg("--keep");
  if (all === !!eventId) throw new Error(USAGE);
  if (all && keepId) throw new Error("--keep goes with --event, not with --all");

  let events: EventTarget[];
  if (all) {
    const grouped = await db.ticketType.groupBy({ by: ["eventId"], where: { isFaculty: true }, _count: { _all: true } });
    const ids = grouped.filter((g) => g._count._all > 1).map((g) => g.eventId);
    events = await db.event.findMany({ where: { id: { in: ids } }, select: { id: true, name: true }, orderBy: { startDate: "asc" } });
  } else {
    const event = await db.event.findUnique({ where: { id: eventId as string }, select: { id: true, name: true } });
    if (!event) throw new Error(`Event ${eventId} not found`);
    events = [event];
  }
  if (events.length === 0) {
    console.log("No event holds more than one Faculty type. Nothing to do.");
    return;
  }

  let failed = 0;
  for (const event of events) failed += await runEvent(event, write, keepId);
  console.log(write ? `\n${events.length} event(s) done.` : `\n${events.length} event(s) in the plan. Nothing was changed. Run again with --write to apply.`);
  if (failed > 0) process.exitCode = 1;
}

// The stats refresh and the logger write without being waited for; give them
// time before the database is let go (the lesson of the adopt script).
const IN_FLIGHT_WRITES_MS = 4000;

// Only when run as a script: the planner above is imported by its test.
if (process.argv[1]?.endsWith("merge-faculty-types.ts")) {
  main()
    .catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; })
    .finally(async () => {
      await new Promise((resolve) => setTimeout(resolve, IN_FLIGHT_WRITES_MS));
      await db.$disconnect();
    });
}
