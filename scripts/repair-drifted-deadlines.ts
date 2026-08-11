/**
 * One-off repair for deadlines corrupted by the datetime-local round-trip bug
 * (Aug 11, 2026).
 *
 * THE DAMAGE
 * ----------
 * Event Settings loaded the abstract + session-proposal deadlines with
 * `.toISOString().slice(0, 16)` and saved them with
 * `new Date(value).toISOString()`. A datetime-local input carries no timezone,
 * so the browser showed the UTC wall-clock and then read that same string back
 * as LOCAL. Each save therefore stored `instant - offset`, and it compounded:
 *
 *     save N:  S  ->  S - offset
 *     undo  :  S  ->  S + offset      (what this script does, one step at a time)
 *
 * In code, one undo step is "read the event-local wall-clock, then interpret
 * that string as UTC" - the exact inverse of what the bug did.
 *
 * WHY IT IS NOT FULLY AUTOMATIC
 * -----------------------------
 * Nothing in the database records how many times a value was saved, so the
 * number of undo steps has to be INFERRED. The inference used here is that
 * organizers type end-of-day deadlines: undo until the value reads 23:59 in
 * the event's own timezone. That converges cleanly for the real conference
 * deadlines and does NOT converge for values that were never 23:59 to begin
 * with, which is the point - those are reported and skipped rather than
 * guessed at, and are set explicitly with --set after asking the organizer.
 *
 *   npx tsx scripts/repair-drifted-deadlines.ts                       # report only
 *   npx tsx scripts/repair-drifted-deadlines.ts --write               # apply confident repairs
 *   npx tsx scripts/repair-drifted-deadlines.ts --set <eventId> <field> 2026-10-31T23:59
 *
 * Idempotent: a value that already reads 23:59 event-local is reported as
 * already correct and never touched, so re-running writes nothing.
 */
import { db } from "@/lib/db";
import { localDateTimeInTz, resolveTimezone, wallTimeInTzToIso } from "@/lib/event-time";
import { updateEventSettings } from "@/lib/event-settings";

const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const setIdx = argv.indexOf("--set");
const SET = setIdx !== -1 ? argv.slice(setIdx + 1, setIdx + 4) : null;

/** The wall-clock organizers were aiming at. Every real value ends in :59. */
const TARGET = "23:59";
/** Undo steps to try. 6 x 4h covers a full day of compounding. */
const MAX_STEPS = 8;

type Field = "abstractDeadline" | "sessionProposalDeadline";
const FIELDS: Field[] = ["abstractDeadline", "sessionProposalDeadline"];

/**
 * One undo step: the event-local wall-clock of `iso`, re-read as UTC. The
 * inverse of the bug, which took the UTC wall-clock and re-read it as local.
 */
function undoOneCycle(iso: string, timeZone: string): string | null {
  const wall = localDateTimeInTz(new Date(iso), timeZone);
  const d = new Date(`${wall}:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

type Row = {
  eventId: string;
  eventName: string;
  timeZone: string;
  field: Field;
  storedIso: string;
  currentWall: string;
  /** Every candidate the undo ladder passes through, for the operator to read. */
  ladder: { steps: number; iso: string; wall: string }[];
  /** First candidate landing on 23:59 event-local, if any. */
  suggestion: { steps: number; iso: string; wall: string } | null;
};

function analyse(
  eventId: string,
  eventName: string,
  timeZone: string,
  field: Field,
  storedIso: string,
): Row | null {
  const stored = new Date(storedIso);
  if (Number.isNaN(stored.getTime())) return null;

  const currentWall = localDateTimeInTz(stored, timeZone);
  if (currentWall.endsWith(`T${TARGET}`)) return null; // never re-saved

  const ladder: Row["ladder"] = [];
  let iso = storedIso;
  for (let steps = 1; steps <= MAX_STEPS; steps++) {
    const next = undoOneCycle(iso, timeZone);
    if (!next) break;
    iso = next;
    const wall = localDateTimeInTz(new Date(iso), timeZone);
    ladder.push({ steps, iso, wall });
    if (wall.endsWith(`T${TARGET}`)) break;
  }

  const suggestion = ladder.find((c) => c.wall.endsWith(`T${TARGET}`)) ?? null;
  return { eventId, eventName, timeZone, field, storedIso, currentWall, ladder, suggestion };
}

async function applySet() {
  const [eventId, field, wall] = SET as string[];
  if (!eventId || !field || !wall) {
    console.error("Usage: --set <eventId> <abstractDeadline|sessionProposalDeadline> <YYYY-MM-DDTHH:mm>");
    process.exitCode = 1;
    return;
  }
  if (!FIELDS.includes(field as Field)) {
    console.error(`Unknown field "${field}". Expected one of: ${FIELDS.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const event = await db.event.findUnique({
    where: { id: eventId },
    select: { id: true, name: true, timezone: true },
  });
  if (!event) {
    console.error(`No event with id ${eventId}`);
    process.exitCode = 1;
    return;
  }
  const tz = resolveTimezone(event.timezone);
  const iso = wallTimeInTzToIso(wall, tz);
  if (!iso) {
    console.error(`"${wall}" is not a valid wall-clock datetime (YYYY-MM-DDTHH:mm).`);
    process.exitCode = 1;
    return;
  }
  await updateEventSettings(event.id, { [field]: iso });
  console.log(`✓ ${event.name} - ${field} = ${wall} ${tz}  [${iso}]`);
}

async function main() {
  if (SET) return applySet();

  const events = await db.event.findMany({
    select: { id: true, name: true, timezone: true, settings: true },
  });

  const rows: Row[] = [];
  for (const e of events) {
    const settings = (e.settings ?? {}) as Record<string, unknown>;
    const tz = resolveTimezone(e.timezone);
    for (const field of FIELDS) {
      const value = settings[field];
      if (typeof value !== "string" || !value) continue;
      const row = analyse(e.id, e.name, tz, field, value);
      if (row) rows.push(row);
    }
  }

  if (rows.length === 0) {
    console.log("Nothing drifted - every deadline already reads 23:59 in its event timezone.");
    return;
  }

  const confident = rows.filter((r) => r.suggestion);
  const manual = rows.filter((r) => !r.suggestion);

  console.log(`\n${WRITE ? "WRITING" : "REPORT"} - ${rows.length} drifted deadline(s)\n`);

  for (const r of confident) {
    const s = r.suggestion!;
    console.log(`  ${r.eventName}`);
    console.log(`    field    ${r.field}   (${r.timeZone})`);
    console.log(`    now      ${r.currentWall}   [${r.storedIso}]`);
    console.log(`    repair   ${s.wall}   [${s.iso}]   ${s.steps} save cycle(s) of drift`);
    console.log("");
  }

  if (manual.length) {
    console.log("  -- NOT REPAIRED - never a 23:59 deadline, so the intent cannot be inferred:\n");
    for (const r of manual) {
      console.log(`  ${r.eventName}`);
      console.log(`    field    ${r.field}   (${r.timeZone})`);
      console.log(`    now      ${r.currentWall}   [${r.storedIso}]`);
      console.log(`    ladder   ${r.ladder.map((c) => `${c.steps}:${c.wall}`).join("  ")}`);
      console.log(
        `    fix      npx tsx scripts/repair-drifted-deadlines.ts --set ${r.eventId} ${r.field} <YYYY-MM-DDTHH:mm>`,
      );
      console.log("");
    }
  }

  if (!WRITE) {
    console.log(
      `No changes written. Re-run with --write to apply the ${confident.length} confident repair(s).\n`,
    );
    return;
  }

  for (const r of confident) {
    await updateEventSettings(r.eventId, { [r.field]: r.suggestion!.iso });
    console.log(`  ✓ ${r.eventName} - ${r.field} → ${r.suggestion!.wall} ${r.timeZone}`);
  }
  console.log(
    `\nRepaired ${confident.length}. Left ${manual.length} for --set after confirming with the organizer.\n`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
