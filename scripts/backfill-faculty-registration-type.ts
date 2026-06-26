/**
 * One-time backfill — fix faculty companion registrations whose attendee
 * `registrationType` was hardcoded to "Faculty".
 *
 * "Faculty" is a badge/role, not a professional registration type (Physician /
 * Allied Health / Nurse / Others). This sets each affected companion's
 * `registrationType` to the linked speaker's professional category
 * (Speaker.registrationType), or NULL when the speaker has none (or it's also
 * "Faculty", or there's no linked speaker). The Faculty designation stays on
 * `badgeType` + the hidden isFaculty ticket type.
 *
 * Idempotent + safe to re-run — only touches rows still literally set to
 * "Faculty". Run AFTER deploying the companion-creation fix.
 *
 * Usage:
 *   npx tsx scripts/backfill-faculty-registration-type.ts            # dry run
 *   npx tsx scripts/backfill-faculty-registration-type.ts --write    # apply
 *   npx tsx scripts/backfill-faculty-registration-type.ts --write --event <eventId>
 */
import { db } from "../src/lib/db";

const write = process.argv.includes("--write");
const eventArgIdx = process.argv.indexOf("--event");
const eventFilter = eventArgIdx >= 0 ? process.argv[eventArgIdx + 1] : undefined;

async function main() {
  // Faculty companion registrations whose attendee.registrationType is still "Faculty".
  const regs = await db.registration.findMany({
    where: {
      ...(eventFilter ? { eventId: eventFilter } : {}),
      ticketType: { isFaculty: true },
      attendee: { registrationType: "Faculty" },
    },
    select: {
      id: true,
      attendeeId: true,
      attendee: { select: { email: true } },
      // Reverse of Speaker.sourceRegistrationId — the linked speaker(s).
      importedSpeakers: { select: { registrationType: true }, take: 1 },
    },
  });

  console.log(
    `Found ${regs.length} faculty companion registration(s) with registrationType="Faculty"` +
      `${eventFilter ? ` in event ${eventFilter}` : ""}.`,
  );
  console.log(write ? "Mode: WRITE\n" : "Mode: DRY RUN (pass --write to apply)\n");

  let toProfession = 0;
  let toBlank = 0;
  for (const reg of regs) {
    const speakerType = reg.importedSpeakers[0]?.registrationType;
    const newType = speakerType && speakerType !== "Faculty" ? speakerType : null;
    console.log(`  reg ${reg.id} (${reg.attendee?.email ?? "?"}) -> ${newType ?? "(blank)"}`);
    if (write) {
      await db.attendee.update({ where: { id: reg.attendeeId }, data: { registrationType: newType } });
    }
    if (newType) toProfession++;
    else toBlank++;
  }

  console.log(
    `\n${write ? "Updated" : "Would update"} ${regs.length} row(s) — to profession: ${toProfession}, blanked: ${toBlank}.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
