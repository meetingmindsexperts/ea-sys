/**
 * One-time backfill — give every existing Speaker a companion Registration
 * (the "attendee facet": badge / entry barcode / DTCM / check-in / survey).
 *
 * For each Speaker without `sourceRegistrationId`:
 *   • a registration with the same email already exists → LINK it (no new row)
 *   • otherwise                                         → CREATE a Faculty companion
 *
 * Idempotent + safe to re-run — only touches speakers that aren't linked yet,
 * and the helper itself re-checks before writing. Run AFTER the Phase 0 deploy
 * (it needs the `TicketType.isFaculty` column + the `SPEAKER_COMPANION` enum).
 *
 * Usage:
 *   npx tsx scripts/backfill-speaker-companion-registrations.ts            # dry run
 *   npx tsx scripts/backfill-speaker-companion-registrations.ts --write    # apply
 *   npx tsx scripts/backfill-speaker-companion-registrations.ts --write --event <eventId>
 */
import { db } from "../src/lib/db";
import { ensureSpeakerCompanionRegistration } from "../src/lib/speaker-companion";

const write = process.argv.includes("--write");
const eventArgIdx = process.argv.indexOf("--event");
const eventFilter = eventArgIdx >= 0 ? process.argv[eventArgIdx + 1] : undefined;

const SPEAKER_SELECT = {
  id: true,
  eventId: true,
  email: true,
  firstName: true,
  lastName: true,
  title: true,
  additionalEmail: true,
  organization: true,
  jobTitle: true,
  phone: true,
  photo: true,
  city: true,
  state: true,
  zipCode: true,
  country: true,
  specialty: true,
  sourceRegistrationId: true,
} as const;

async function main() {
  const speakers = await db.speaker.findMany({
    where: {
      sourceRegistrationId: null,
      ...(eventFilter ? { eventId: eventFilter } : {}),
    },
    select: SPEAKER_SELECT,
    orderBy: { createdAt: "asc" },
  });

  console.log(
    `Found ${speakers.length} speaker(s) without a companion registration${eventFilter ? ` (event ${eventFilter})` : ""}.`,
  );
  if (speakers.length === 0) return;

  if (!write) {
    // Dry run — classify would-link vs would-create without writing.
    let wouldLink = 0;
    let wouldCreate = 0;
    for (const s of speakers) {
      const existing = s.email
        ? await db.registration.findFirst({
            where: { eventId: s.eventId, attendee: { email: s.email } },
            select: { id: true },
          })
        : null;
      if (existing) wouldLink++;
      else wouldCreate++;
    }
    console.log(`DRY RUN — would LINK ${wouldLink}, would CREATE ${wouldCreate}. Re-run with --write to apply.`);
    return;
  }

  let created = 0;
  let linked = 0;
  let failed = 0;
  for (const s of speakers) {
    try {
      const res = await ensureSpeakerCompanionRegistration(s);
      if (res.status === "created") created++;
      else if (res.status === "linked-by-email") linked++;
      // "already-linked" can't happen here (we filtered sourceRegistrationId: null).
    } catch (err) {
      failed++;
      console.error(`  FAILED speaker ${s.id} (${s.email}):`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`Done. created=${created}, linked=${linked}, failed=${failed}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
