/**
 * One-time backfill — enrich existing Speakers' `phone` / `additionalEmail`
 * from their counterpart Registration's Attendee.
 *
 * Why: the old Add-Speaker form dropped `phone` entirely, so speakers added
 * that way have a null phone even when the same person has a registration that
 * captured it. Speaker and Attendee are separate rows with no live sync, so
 * this copies the data across once.
 *
 * Matching (per speaker):
 *   1. `Speaker.sourceRegistrationId` → that registration's attendee, else
 *   2. same-email fallback → a registration in the SAME event whose attendee
 *      email equals the speaker's email.
 *
 * ENRICH-ONLY — only fills a field that is currently blank on the Speaker AND
 * non-blank on the Attendee. NEVER overwrites an existing speaker value and
 * NEVER blanks anything. Idempotent + safe to re-run (a re-run finds nothing
 * left to fill). Companion-only speakers naturally no-op (their companion
 * attendee was seeded from the speaker, so it has no richer data to give).
 *
 * Usage:
 *   npx tsx scripts/backfill-speaker-contact-from-registration.ts            # dry run
 *   npx tsx scripts/backfill-speaker-contact-from-registration.ts --write    # apply
 *   npx tsx scripts/backfill-speaker-contact-from-registration.ts --write --event <eventId>
 */
import { db } from "../src/lib/db";

const write = process.argv.includes("--write");
const eventArgIdx = process.argv.indexOf("--event");
const eventFilter = eventArgIdx >= 0 ? process.argv[eventArgIdx + 1] : undefined;

const blank = (v: string | null | undefined) => !v || v.trim().length === 0;

interface AttendeeContact {
  phone: string | null;
  additionalEmail: string | null;
}

/** Resolve the counterpart attendee's contact fields for a speaker, or null. */
async function findCounterpart(speaker: {
  eventId: string;
  email: string;
  sourceRegistrationId: string | null;
}): Promise<AttendeeContact | null> {
  // 1. Explicit link — but keep it event-scoped as a safety net.
  if (speaker.sourceRegistrationId) {
    const reg = await db.registration.findFirst({
      where: { id: speaker.sourceRegistrationId, eventId: speaker.eventId },
      select: { attendee: { select: { phone: true, additionalEmail: true } } },
    });
    if (reg?.attendee) return reg.attendee;
  }
  // 2. Same-email fallback within the event.
  if (speaker.email) {
    const reg = await db.registration.findFirst({
      where: { eventId: speaker.eventId, attendee: { email: speaker.email } },
      select: { attendee: { select: { phone: true, additionalEmail: true } } },
      orderBy: { createdAt: "asc" },
    });
    if (reg?.attendee) return reg.attendee;
  }
  return null;
}

async function main() {
  // Only speakers missing at least one of the two fields are candidates.
  const speakers = await db.speaker.findMany({
    where: {
      ...(eventFilter ? { eventId: eventFilter } : {}),
      OR: [
        { phone: null },
        { phone: "" },
        { additionalEmail: null },
        { additionalEmail: "" },
      ],
    },
    select: {
      id: true,
      eventId: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      additionalEmail: true,
      sourceRegistrationId: true,
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(
    `Found ${speakers.length} speaker(s) missing phone and/or additionalEmail${eventFilter ? ` (event ${eventFilter})` : ""}.`,
  );
  if (speakers.length === 0) return;

  let phoneFills = 0;
  let emailFills = 0;
  let updated = 0;
  let noCounterpart = 0;
  let nothingToFill = 0;
  let failed = 0;

  for (const s of speakers) {
    try {
      const counterpart = await findCounterpart(s);
      if (!counterpart) {
        noCounterpart++;
        continue;
      }

      const data: { phone?: string; additionalEmail?: string } = {};
      if (blank(s.phone) && !blank(counterpart.phone)) data.phone = counterpart.phone!.trim();
      if (blank(s.additionalEmail) && !blank(counterpart.additionalEmail)) {
        data.additionalEmail = counterpart.additionalEmail!.trim().toLowerCase();
      }

      if (Object.keys(data).length === 0) {
        nothingToFill++;
        continue;
      }

      if (data.phone) phoneFills++;
      if (data.additionalEmail) emailFills++;
      updated++;

      if (write) {
        // Build a before/after of just the filled fields so the change renders
        // as a diff in the speaker's Activity timeline ("Phone: — → …").
        const before: Record<string, string | null> = {};
        const after: Record<string, string | null> = {};
        if (data.phone !== undefined) { before.phone = s.phone ?? null; after.phone = data.phone; }
        if (data.additionalEmail !== undefined) { before.additionalEmail = s.additionalEmail ?? null; after.additionalEmail = data.additionalEmail; }
        await db.$transaction(async (tx) => {
          await tx.speaker.update({ where: { id: s.id }, data });
          await tx.auditLog.create({
            data: {
              eventId: s.eventId,
              userId: null,
              action: "UPDATE",
              entityType: "Speaker",
              entityId: s.id,
              changes: { source: "backfill-speaker-contact-from-registration", before, after },
            },
          });
        });
        console.log(
          `  updated ${s.id} (${s.email}) ← ${Object.entries(data).map(([k, v]) => `${k}=${v}`).join(", ")}`,
        );
      } else {
        console.log(
          `  would update ${s.id} (${s.email}) ← ${Object.entries(data).map(([k, v]) => `${k}=${v}`).join(", ")}`,
        );
      }
    } catch (err) {
      failed++;
      console.error(`  FAILED speaker ${s.id} (${s.email}):`, err instanceof Error ? err.message : err);
    }
  }

  console.log(
    `${write ? "Done" : "DRY RUN"}. ${write ? "updated" : "would update"}=${updated} ` +
      `(phone=${phoneFills}, additionalEmail=${emailFills}), ` +
      `noCounterpart=${noCounterpart}, nothingToFill=${nothingToFill}, failed=${failed}.` +
      `${write ? "" : " Re-run with --write to apply."}`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
