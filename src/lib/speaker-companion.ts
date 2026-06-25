/**
 * Speaker companion registration — the "attendee facet" of a speaker.
 *
 * A speaker added by the organizer must receive everything a registration
 * receives (badge, entry barcode, DTCM barcode, check-in, survey). Rather than
 * duplicating all of that onto the Speaker entity, we give the speaker a
 * companion Registration backed by an auto-provisioned, hidden "Faculty" ticket
 * type that is comp + uncapped (so faculty never consume a paid seat or revenue).
 *
 * The link reuses `Speaker.sourceRegistrationId` (the same column the import
 * path and the activity timeline already use).
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { generateBarcode } from "@/lib/utils";
import { getNextSerialId } from "@/lib/registration-serial";
import type { Title } from "@prisma/client";

/**
 * Find-or-create the event's hidden Faculty ticket type. Comp (price 0),
 * uncapped, `isFaculty: true` (excluded from public registration + paid
 * capacity). Rare concurrent duplicates are harmless — companions just use one.
 */
export async function ensureFacultyTicketType(eventId: string): Promise<string> {
  const existing = await db.ticketType.findFirst({
    where: { eventId, isFaculty: true },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing.id;

  const created = await db.ticketType.create({
    data: {
      eventId,
      name: "Faculty",
      category: "Faculty",
      isFaculty: true,
      isActive: true,
      isDefault: false,
      price: 0,
      quantity: 999999,
    },
    select: { id: true },
  });
  return created.id;
}

export interface CompanionSpeakerInput {
  id: string;
  eventId: string;
  email: string;
  firstName: string;
  lastName: string;
  title?: Title | null;
  additionalEmail?: string | null;
  organization?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
  photo?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  country?: string | null;
  specialty?: string | null;
  sourceRegistrationId?: string | null;
}

export type CompanionResult =
  | { status: "already-linked"; registrationId: string }
  | { status: "linked-by-email"; registrationId: string }
  | { status: "created"; registrationId: string };

/**
 * Ensure the speaker has a companion registration, idempotently:
 *   1. already linked (`sourceRegistrationId`)        → no-op
 *   2. a registration with the same email exists      → link it (never duplicate
 *                                                        a real registrant)
 *   3. otherwise                                      → create a Faculty companion
 *
 * Callers should treat this as failure-isolated (the speaker create must succeed
 * even if this hiccups — the backfill script recovers any that fail).
 */
export async function ensureSpeakerCompanionRegistration(
  speaker: CompanionSpeakerInput,
): Promise<CompanionResult> {
  if (speaker.sourceRegistrationId) {
    return { status: "already-linked", registrationId: speaker.sourceRegistrationId };
  }

  if (speaker.email) {
    const existing = await db.registration.findFirst({
      where: { eventId: speaker.eventId, attendee: { email: speaker.email } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    if (existing) {
      await db.speaker.update({
        where: { id: speaker.id },
        data: { sourceRegistrationId: existing.id },
      });
      apiLogger.info({
        msg: "speaker-companion:linked-existing",
        speakerId: speaker.id,
        eventId: speaker.eventId,
        registrationId: existing.id,
      });
      return { status: "linked-by-email", registrationId: existing.id };
    }
  }

  const facultyTypeId = await ensureFacultyTicketType(speaker.eventId);
  const qrCode = generateBarcode();

  const registrationId = await db.$transaction(async (tx) => {
    const serialId = await getNextSerialId(tx, speaker.eventId);
    const attendee = await tx.attendee.create({
      data: {
        email: speaker.email,
        firstName: speaker.firstName,
        lastName: speaker.lastName,
        title: speaker.title ?? undefined,
        additionalEmail: speaker.additionalEmail ?? undefined,
        organization: speaker.organization ?? undefined,
        jobTitle: speaker.jobTitle ?? undefined,
        phone: speaker.phone ?? undefined,
        photo: speaker.photo ?? undefined,
        city: speaker.city ?? undefined,
        state: speaker.state ?? undefined,
        zipCode: speaker.zipCode ?? undefined,
        country: speaker.country ?? undefined,
        specialty: speaker.specialty ?? undefined,
        registrationType: "Faculty",
      },
      select: { id: true },
    });
    const reg = await tx.registration.create({
      data: {
        eventId: speaker.eventId,
        attendeeId: attendee.id,
        ticketTypeId: facultyTypeId,
        // Faculty: confirmed, comp, in-person, entry barcode minted. NO
        // soldCount increment — the Faculty type is uncapped/isFaculty.
        status: "CONFIRMED",
        paymentStatus: "COMPLIMENTARY",
        attendanceMode: "IN_PERSON",
        qrCode,
        serialId,
        badgeType: "Faculty",
        createdSource: "SPEAKER_COMPANION",
      },
      select: { id: true },
    });
    await tx.speaker.update({
      where: { id: speaker.id },
      data: { sourceRegistrationId: reg.id },
    });
    return reg.id;
  });

  apiLogger.info({
    msg: "speaker-companion:created",
    speakerId: speaker.id,
    eventId: speaker.eventId,
    registrationId,
  });
  return { status: "created", registrationId };
}

/**
 * Batch companion ensure for the bulk speaker-add paths (CSV import,
 * import-contacts, MCP bulk). Resolves speakers by email within the event,
 * skipping those already linked, and ensures a companion for each — per-item
 * failure-isolated so one bad row can't break the rest. Returns a summary.
 *
 * Awaited by callers (correct + the backfill script recovers any failures). For
 * very large speaker imports a worker-side reconciler is the scale follow-up.
 */
export async function ensureCompanionsForSpeakerEmails(
  eventId: string,
  emails: string[],
): Promise<{ created: number; linked: number; failed: number }> {
  const summary = { created: 0, linked: 0, failed: 0 };
  if (emails.length === 0) return summary;

  const speakers = await db.speaker.findMany({
    where: { eventId, email: { in: emails }, sourceRegistrationId: null },
    select: {
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
    },
  });

  for (const spk of speakers) {
    try {
      const res = await ensureSpeakerCompanionRegistration(spk);
      if (res.status === "created") summary.created++;
      else if (res.status === "linked-by-email") summary.linked++;
    } catch (err) {
      summary.failed++;
      apiLogger.error({ err, speakerId: spk.id, eventId }, "speaker-companion:batch-item-failed");
    }
  }
  return summary;
}
