/**
 * One-time backfill — fix faculty companion registrations whose attendee
 * `registrationType` was hardcoded to "Faculty".
 *
 * "Faculty" is a badge/role, not a professional registration type. This sets
 * each affected companion's `registrationType` to:
 *   • the linked speaker's professional category (Speaker.registrationType), or
 *   • DEFAULT_FACULTY_REGISTRATION_TYPE ("Physician") when the speaker has none
 *     (or it's also "Faculty", or there's no linked speaker).
 * Most faculty are physicians; the rare exception (Allied Health / nurse) is
 * corrected afterwards — each change below is written to the AuditLog so it
 * shows as a diff in the registration's Activity timeline, and you can pull the
 * defaulted set up via the registrations-list filter (Badge = Faculty + Type =
 * Physician). The Faculty designation stays on `badgeType` + the isFaculty
 * ticket type (untouched here).
 *
 * Idempotent + safe to re-run — only touches rows still literally set to
 * "Faculty". Run AFTER deploying the companion-creation default.
 *
 * Usage:
 *   npx tsx scripts/backfill-faculty-registration-type.ts            # dry run
 *   npx tsx scripts/backfill-faculty-registration-type.ts --write    # apply
 *   npx tsx scripts/backfill-faculty-registration-type.ts --write --event <eventId>
 */
import { db } from "../src/lib/db";

// Default profession for a faculty companion with no profession on record.
// Most faculty are physicians; the rare exception (Allied Health / nurse) is
// corrected afterwards (each change is audited → shows in the Activity
// timeline; pull the defaulted set via the registrations filter Badge=Faculty
// + Type=Physician). NOTE: backfill-only — the live companion-creation path
// does NOT assume this; it leaves new faculty blank when profession is unknown.
const DEFAULT_FACULTY_REGISTRATION_TYPE = "Physician";

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
      eventId: true,
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

  let restored = 0;
  let defaulted = 0;
  let failed = 0;
  for (const reg of regs) {
    const speakerType = reg.importedSpeakers[0]?.registrationType?.trim();
    const isRealProfession = !!speakerType && speakerType !== "Faculty";
    const newType = isRealProfession ? speakerType! : DEFAULT_FACULTY_REGISTRATION_TYPE;
    console.log(
      `  reg ${reg.id} (${reg.attendee?.email ?? "?"}) -> ${newType}` +
        `${isRealProfession ? " (restored from speaker)" : " (default)"}`,
    );
    if (write) {
      try {
        await db.$transaction(async (tx) => {
          await tx.attendee.update({
            where: { id: reg.attendeeId },
            data: { registrationType: newType },
          });
          // Audit so the change surfaces in the registration's Activity timeline
          // as "Attendee: Registration type: Faculty → <newType>".
          await tx.auditLog.create({
            data: {
              eventId: reg.eventId,
              userId: null,
              action: "UPDATE",
              entityType: "Registration",
              entityId: reg.id,
              changes: {
                source: "backfill-faculty-registration-type",
                before: { attendee: { registrationType: "Faculty" } },
                after: { attendee: { registrationType: newType } },
              },
            },
          });
        });
      } catch (err) {
        failed++;
        console.error(`    FAILED reg ${reg.id}:`, err instanceof Error ? err.message : err);
        continue;
      }
    }
    if (isRealProfession) restored++;
    else defaulted++;
  }

  console.log(
    `\n${write ? "Updated" : "Would update"} ${restored + defaulted} row(s) — ` +
      `restored from speaker: ${restored}, defaulted to ${DEFAULT_FACULTY_REGISTRATION_TYPE}: ${defaulted}` +
      `${failed ? `, failed: ${failed}` : ""}.`,
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
