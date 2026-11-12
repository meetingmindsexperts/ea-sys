/**
 * One-off: leave an event with ONE Faculty type (owner, Nov 12, 2026: "why so
 * many separate faculty, can we just keep one").
 *
 * Two events held two: the 4th GCC Hematology Hub ("Faculty", 37
 * registrations, and "Faculty.", 6) and HEMNET 2026 (one empty and switched
 * off, one with 7). Both began with an ordinary "Faculty" type from the
 * organisation's default list and were given a built-in one beside it before
 * Oct 19, 2026, when adopting the ordinary one replaced making a second;
 * scripts/adopt-ordinary-faculty-type.ts then made the ordinary one a Faculty
 * type as well. The system adds new faculty to the OLDEST Faculty type
 * (ensureFacultyTicketType), so on HEMNET they would land on the empty one,
 * apart from the other seven.
 *
 * What it does, for each event that holds more than one Faculty type:
 *   1. Picks the one to KEEP: the type with the most registrations; on a tie
 *      the active one, then the oldest. Or the one you name with --keep.
 *   2. For every other Faculty type (a "donor"), in one transaction:
 *        - locks the donor type first, so a registration being made on it at
 *          that moment waits and is then refused cleanly, never left with no
 *          type (the database would otherwise blank the type of a row that
 *          arrived between the move and the delete).
 *        - moves its registrations, cancelled ones included, onto the kept
 *          type. Nothing else a person sees on a registration changes: not
 *          its status, payment, badge, barcode, number, speaker link or where
 *          it came from (its "last changed" time does).
 *        - moves the donor's seat count onto the kept type (a Faculty
 *          registration normally holds no seat; one imported while the type
 *          was still an ordinary type does, and its seat moves with it).
 *        - where an attendee's own type text is just the donor's NAME, makes
 *          it the kept type's name, so the Registrations list does not show
 *          the old name as if it were a profession.
 *        - deletes the donor type, now empty, with its unused rates.
 *      One audit row per donor holds the whole deleted type, its rates, the
 *      registrations that moved and the attendees whose text was renamed:
 *      everything needed to put it back by hand.
 *
 * A donor is LEFT, and listed, when something else still points at it: a rate
 * of its own in use on a registration, a promo code limited to it, a shared
 * registration view filtered on it, a scheduled email still waiting to go
 * that is filtered on it, or a mention of its id in the event's settings (the
 * DTCM section map). Those are yours to move first; the script does not
 * guess. Anything of that kind that filters on the KEPT type will include the
 * people who move onto it, which is the point of having one type.
 *
 * No email is sent. Dry run by default.
 *
 *   docker exec ea-sys-worker npx tsx scripts/merge-faculty-types.ts --all             # dry run, every such event
 *   docker exec ea-sys-worker npx tsx scripts/merge-faculty-types.ts --all --write     # apply
 *   docker exec ea-sys-worker npx tsx scripts/merge-faculty-types.ts --event <eventId> [--keep <ticketTypeId>] [--write]
 *
 * Safe to run again: an event with one Faculty type is not in the plan. To
 * undo: the audit rows (FACULTY_TYPES_MERGED) hold the deleted type in full
 * and the moved registration ids; recreate the type and move them back by
 * hand.
 */
import { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { refreshEventStats } from "../src/lib/event-stats";
import { equalsIgnoringCase } from "../src/lib/like-escape";

/** The value after a flag. A flag given with no value is an error, never "not given": `--keep` alone must not let the script choose. */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
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
  if (refs.scheduledEmails > 0) blocks.push(`${refs.scheduledEmails} scheduled email(s) still to go filter on it`);
  if (refs.inEventSettings) blocks.push("the event's settings mention it (the DTCM section map)");
  return blocks;
}

type Client = Prisma.TransactionClient | typeof db;

/** Read on the caller's client: the dry run uses the plain one, the write its own transaction. */
export async function referencesTo(client: Client, eventId: string, typeId: string): Promise<DonorReferences> {
  // One after another: a transaction client runs one statement at a time.
  const ratesInUse = await client.registration.count({ where: { eventId, pricingTier: { ticketTypeId: typeId } } });
  const promoCodes = await client.promoCodeTicketType.count({ where: { ticketTypeId: typeId } });
  const shareLinks = await client.registrationShareLink.count({ where: { eventId, ticketTypeIds: { has: typeId } } });
  // Only an email still to go: one already sent, failed or cancelled filters nothing any more.
  const scheduled = await client.scheduledEmail.findMany({ where: { eventId, status: { in: ["PENDING", "PROCESSING"] } }, select: { filters: true } });
  const event = await client.event.findUnique({ where: { id: eventId }, select: { settings: true } });
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
export async function mergeDonor(event: EventTarget, keeper: Pick<FacultyTypeInfo, "id" | "name">, donor: Pick<FacultyTypeInfo, "id" | "name">): Promise<number> {
  const moved = await db.$transaction(async (tx) => {
    // The lock comes first (review of 9a57f2a5). Registration.ticketTypeId is
    // ON DELETE SET NULL: without it, a registration committed on the donor
    // after the move would have its type blanked by the delete, silently.
    // With it, such an insert waits for this transaction and then fails on
    // the missing type, and one already in flight is seen by the move below.
    await tx.$queryRaw`SELECT id FROM "TicketType" WHERE id = ${donor.id} FOR UPDATE`;
    // Read again under the lock: what the dry run saw may have changed.
    const blocks = donorBlocks(await referencesTo(tx, event.id, donor.id));
    if (blocks.length > 0) throw new Error(`something now points at "${donor.name}": ${blocks.join("; ")}`);
    const donorRow = await tx.ticketType.findUniqueOrThrow({ where: { id: donor.id }, include: { pricingTiers: true } });
    const rows = await tx.registration.findMany({ where: { eventId: event.id, ticketTypeId: donor.id }, select: { id: true, attendeeId: true } });
    const ids = rows.map((r) => r.id);
    await tx.registration.updateMany({ where: { id: { in: ids }, ticketTypeId: donor.id }, data: { ticketTypeId: keeper.id } });
    // The donor's counted seats belong to the rows that just moved.
    if (donorRow.soldCount > 0) {
      await tx.ticketType.update({ where: { id: keeper.id }, data: { soldCount: { increment: donorRow.soldCount } } });
    }
    // An attendee's own type text that is only the donor's name follows the
    // type. Exactly that name whatever its case (equalsIgnoringCase: a plain
    // insensitive match is ILIKE, where "_" in a name would match anything).
    // The name is compared as it is shown: trimmed (a type can be named with
    // a trailing space, and a typed or imported text usually is not).
    const sameName = donor.name.trim().toLowerCase() === keeper.name.trim().toLowerCase();
    const toRename = sameName
      ? []
      : await tx.attendee.findMany({
          where: {
            id: { in: rows.map((r) => r.attendeeId) },
            OR: [{ registrationType: equalsIgnoringCase(donor.name) }, { registrationType: equalsIgnoringCase(donor.name.trim()) }],
          },
          select: { id: true },
        });
    const renamedIds = toRename.map((a) => a.id);
    if (renamedIds.length > 0) {
      await tx.attendee.updateMany({ where: { id: { in: renamedIds } }, data: { registrationType: keeper.name.trim() } });
    }
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
          // The whole row and its rates, as the app's own delete records them:
          // what an undo by hand needs.
          deleted: JSON.parse(JSON.stringify(donorRow)),
          movedRegistrationIds: ids,
          renamedAttendeeIds: renamedIds,
        } as Prisma.InputJsonValue,
      },
    });
    return ids.length;
  });
  return moved;
}

interface Tally { merged: number; left: number; failed: number }

/** Plan, print and (with --write) merge one event. */
async function runEvent(event: EventTarget, write: boolean, keepId: string | undefined): Promise<Tally> {
  const types = await facultyTypesOf(event.id);
  console.log(`\n${write ? "WRITE" : "DRY RUN"}: ${event.name}`);
  if (types.length < 2) {
    console.log(`  ${types.length === 1 ? "One Faculty type already" : "No Faculty type"}: nothing to do.`);
    return { merged: 0, left: 0, failed: 0 };
  }
  const keeper = chooseKeeper(types, keepId);
  console.log(`  KEEP   ${describeType(keeper)}`);
  const tally: Tally = { merged: 0, left: 0, failed: 0 };
  for (const donor of types.filter((t) => t.id !== keeper.id)) {
    const blocks = donorBlocks(await referencesTo(db, event.id, donor.id));
    if (blocks.length > 0) {
      tally.left += 1;
      console.log(`  LEFT   ${describeType(donor)}`);
      for (const block of blocks) console.log(`         because ${block}`);
      continue;
    }
    console.log(`  MERGE  ${describeType(donor)}: its registrations move to "${keeper.name}", then it is deleted`);
    if (!write) { tally.merged += 1; continue; }
    try {
      const moved = await mergeDonor(event, keeper, donor);
      tally.merged += 1;
      console.log(`         done: ${moved} registration(s) moved, "${donor.name}" deleted`);
    } catch (err) {
      tally.failed += 1;
      console.error(`         FAILED, nothing changed for this type: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (write) refreshEventStats(event.id);
  return tally;
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

  const total: Tally = { merged: 0, left: 0, failed: 0 };
  for (const event of events) {
    const t = await runEvent(event, write, keepId);
    total.merged += t.merged; total.left += t.left; total.failed += t.failed;
  }
  const counts = `${total.merged} type(s) ${write ? "merged" : "to merge"}, ${total.left} left for you, ${total.failed} failed`;
  console.log(write ? `\n${events.length} event(s): ${counts}.` : `\n${events.length} event(s) in the plan: ${counts}. Nothing was changed. Run again with --write to apply.`);
  if (total.failed > 0) process.exitCode = 1;
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
