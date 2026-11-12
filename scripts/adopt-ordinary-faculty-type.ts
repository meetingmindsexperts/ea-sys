/**
 * One-off: make an event's ORDINARY "Faculty" registration type a Faculty type,
 * and bring the registrations on it into line with their speakers (Nov 12,
 * 2026, for the 4th GCC Hematology Hub).
 *
 * The event had two types called "Faculty": the built-in one (speakers added on
 * the Speakers page) and an ordinary one that 34 people had been imported onto.
 * Those 34 counted as delegates, read Pending and Unpaid whatever their
 * speaker's status, and four of them belonged to speakers who had declined.
 * The system adopts an ordinary "Faculty" type by itself only while an event
 * has no built-in type (ensureFacultyTicketType), so this event was skipped.
 *
 * What it does, in order:
 *   1. Marks the ordinary type as a Faculty type (one column). Refused unless
 *      the type is free and no registration on it carries money: the SAME
 *      guard the automatic adoption uses (adoptableFacultyType), not a copy.
 *      Nobody moves; no seat, barcode or speaker link changes.
 *   2. For each registration on that type:
 *        - its speaker DECLINED or was CANCELLED: the registration is
 *          cancelled, through the one cancel operation (cancelRegistration),
 *          as the decline does for a built-in Faculty registration;
 *        - otherwise: Pending becomes Confirmed and Unpaid becomes
 *          Complimentary, through settleFacultyRegistration, the rule a
 *          speaker's move to Confirmed applies from now on.
 *      Paid, sponsor-paid, checked-in and already cancelled rows are left as
 *      they are. No email is sent to anyone.
 *
 * Safe to run again: a type that is already a Faculty type is not touched, and
 * a registration already in line is reported "unchanged". To finish a run
 * that stopped half way, pass the type with --type.
 *
 *   docker exec ea-sys-worker npx tsx scripts/adopt-ordinary-faculty-type.ts --event <eventId>            # dry run
 *   docker exec ea-sys-worker npx tsx scripts/adopt-ordinary-faculty-type.ts --event <eventId> --write    # apply
 *   ... --event <eventId> --type <ticketTypeId> --write                                                   # resume
 *
 * To undo step 1: set the type's isFaculty back to false. Step 2 is undone on
 * each registration's sheet (status, payment status), and every change is an
 * audit row on that registration.
 */
import { db } from "../src/lib/db";
import { adoptableFacultyType, planFacultySettle, settleFacultyRegistration } from "../src/lib/speaker-companion";
import { cancelRegistration } from "../src/services/payment-service";
import { SPEAKER_OUT_STATUSES } from "../src/services/speaker-service";
import { refreshEventStats } from "../src/lib/event-stats";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export type RowPlan = "cancel" | "settle" | "leave";

/** What step 2 does to one registration. Pure, so the dry run and the write agree. */
export function planRow(reg: { status: string; paymentStatus: string }, speakerStatus: string | null): RowPlan {
  if (reg.status === "CANCELLED") return "leave";
  if (speakerStatus && SPEAKER_OUT_STATUSES.has(speakerStatus)) return "cancel";
  const { confirm, comp } = planFacultySettle(reg);
  return confirm || comp ? "settle" : "leave";
}

/** One line of the printed plan: what happens to this registration. */
function describePlan(plan: RowPlan, reg: { status: string; paymentStatus: string }, speakerStatus: string | null): string {
  if (plan === "cancel") return `CANCEL (speaker ${speakerStatus})`;
  if (plan === "leave") return `leave (${reg.status}, ${reg.paymentStatus})`;
  const settle = planFacultySettle(reg);
  const status = settle.confirm ? `${reg.status} -> CONFIRMED` : reg.status;
  const payment = settle.comp ? `${reg.paymentStatus} -> COMPLIMENTARY` : reg.paymentStatus;
  return `${status}, ${payment}`;
}

async function resolveType(eventId: string, typeArg: string | undefined): Promise<{ id: string; name: string; alreadyFaculty: boolean }> {
  if (typeArg) {
    const type = await db.ticketType.findFirst({ where: { id: typeArg, eventId }, select: { id: true, name: true, isFaculty: true } });
    if (!type) throw new Error(`--type ${typeArg} is not a registration type of this event`);
    if (!type.isFaculty) {
      const adoptable = await adoptableFacultyType(eventId);
      if (!adoptable || !("id" in adoptable) || adoptable.id !== type.id) {
        throw new Error(`"${type.name}" cannot be made a Faculty type: it must be named Faculty, be free, and hold no registration with money on it`);
      }
    }
    return { id: type.id, name: type.name, alreadyFaculty: type.isFaculty };
  }
  const adoptable = await adoptableFacultyType(eventId);
  if (!adoptable) throw new Error('No ordinary type named "Faculty" on this event. If a run stopped half way, pass --type <ticketTypeId>.');
  if ("blocked" in adoptable) {
    throw new Error(`The ordinary "Faculty" type cannot be adopted (${adoptable.blocked}): it must be free and hold no registration with money on it`);
  }
  const type = await db.ticketType.findUniqueOrThrow({ where: { id: adoptable.id }, select: { id: true, name: true } });
  return { id: type.id, name: type.name, alreadyFaculty: false };
}

async function main() {
  const eventId = arg("--event");
  const write = process.argv.includes("--write");
  if (!eventId) throw new Error("Usage: adopt-ordinary-faculty-type.ts --event <eventId> [--type <ticketTypeId>] [--write]");

  const event = await db.event.findUnique({ where: { id: eventId }, select: { id: true, name: true, organizationId: true } });
  if (!event) throw new Error(`Event ${eventId} not found`);
  const type = await resolveType(eventId, arg("--type"));

  const registrations = await db.registration.findMany({
    where: { eventId, ticketTypeId: type.id },
    select: {
      id: true, serialId: true, status: true, paymentStatus: true,
      attendee: { select: { firstName: true, lastName: true } },
    },
    orderBy: { serialId: "asc" },
  });
  const speakers = await db.speaker.findMany({
    where: { eventId, sourceRegistrationId: { in: registrations.map((r) => r.id) } },
    select: { id: true, status: true, sourceRegistrationId: true },
  });
  const speakerByReg = new Map(speakers.map((s) => [s.sourceRegistrationId as string, s]));

  console.log(`${write ? "WRITE" : "DRY RUN"}: ${event.name}`);
  console.log(`Type "${type.name}" (${type.id}): ${type.alreadyFaculty ? "already a Faculty type, left as it is" : "becomes a Faculty type"}`);
  console.log(`${registrations.length} registration(s) on it:`);

  const plans = registrations.map((reg) => {
    const speaker = speakerByReg.get(reg.id) ?? null;
    return { reg, speaker, plan: planRow(reg, speaker?.status ?? null) };
  });
  for (const { reg, speaker, plan } of plans) {
    const who = `#${String(reg.serialId ?? "").padStart(3, "0")} ${reg.attendee.firstName} ${reg.attendee.lastName}`.trim();
    const what = describePlan(plan, reg, speaker?.status ?? null);
    console.log(`  ${who.padEnd(38)} speaker: ${(speaker?.status ?? "none").padEnd(10)} ${what}`);
  }
  const count = (p: RowPlan) => plans.filter((x) => x.plan === p).length;
  console.log(`Plan: settle ${count("settle")}, cancel ${count("cancel")}, leave ${count("leave")}`);

  if (!write) {
    console.log("Nothing was changed. Run again with --write to apply.");
    return;
  }

  if (!type.alreadyFaculty) {
    // Guarded on isFaculty:false, as the automatic adoption is: a second run is a no-op.
    const flipped = await db.ticketType.updateMany({ where: { id: type.id, eventId, isFaculty: false }, data: { isFaculty: true } });
    await db.auditLog.create({
      data: {
        eventId,
        action: "FACULTY_TYPE_ADOPTED",
        entityType: "TicketType",
        entityId: type.id,
        changes: { source: "script", script: "adopt-ordinary-faculty-type", name: type.name, changed: flipped.count },
      },
    });
    console.log(`Type marked as a Faculty type (${flipped.count} row).`);
  }

  const done = { settled: 0, cancelled: 0, unchanged: 0, failed: 0 };
  for (const { reg, speaker, plan } of plans) {
    if (plan === "leave") { done.unchanged += 1; continue; }
    if (plan === "cancel") {
      const res = await cancelRegistration({ registrationId: reg.id, eventId, organizationId: event.organizationId, refund: false, source: "system", issuedByUserId: null });
      if (res.ok || res.code === "ALREADY_CANCELLED") done.cancelled += 1;
      else { done.failed += 1; console.error(`  FAILED to cancel ${reg.id}: ${res.code}`); }
      continue;
    }
    const res = await settleFacultyRegistration({ eventId, registrationId: reg.id, reason: "faculty-type-adopted", speakerId: speaker?.id ?? null, source: "script" });
    if (res.outcome === "settled") done.settled += 1;
    else if (res.outcome === "failed" || res.outcome === "not-faculty") { done.failed += 1; console.error(`  FAILED to settle ${reg.id}: ${res.outcome}`); }
    else done.unchanged += 1;
  }
  refreshEventStats(eventId);
  console.log(`Done: settled ${done.settled}, cancelled ${done.cancelled}, unchanged ${done.unchanged}, failed ${done.failed}`);
  if (done.failed > 0) process.exitCode = 1;
}

// The services this calls write their audit rows without waiting for them, and
// the logger batches its warnings for two seconds. Disconnecting at once cut
// both off (found on the local run: a cancellation with no audit row), so the
// script waits for them before it lets go of the database.
const IN_FLIGHT_WRITES_MS = 4000;

// Only when run as a script: the planner above is imported by its test.
if (process.argv[1]?.endsWith("adopt-ordinary-faculty-type.ts")) {
  main()
    .catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; })
    .finally(async () => {
      await new Promise((resolve) => setTimeout(resolve, IN_FLIGHT_WRITES_MS));
      await db.$disconnect();
    });
}
