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
import { Prisma, type Title, type AttendeeRole } from "@prisma/client";

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
  /**
   * The speaker's professional category (Physician / Allied Health / Nurse /
   * Others). Stored on the companion attendee's `registrationType`. NOTE: this
   * is NOT "Faculty" — Faculty is a badge/role (`badgeType`), not a profession.
   * Left null when the speaker's category wasn't recorded.
   */
  registrationType?: string | null;
  /** The speaker's `role` (AttendeeRole profession category, e.g. PHYSICIAN).
   *  Copied onto the companion attendee so the "Role" surfaces the same value. */
  role?: AttendeeRole | null;
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
        // The professional category (Physician/Nurse/…), NOT "Faculty" — the
        // Faculty designation lives in `badgeType` + the isFaculty ticket type.
        registrationType: speaker.registrationType ?? undefined,
        // Role (AttendeeRole) carried over from the speaker so the companion
        // registration's Role matches the speaker's.
        role: speaker.role ?? undefined,
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
        // Faculty companion is comp (price 0) — stamp it so the read surfaces
        // treat it as a $0 registration, not an unresolved one.
        originalPrice: 0,
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
      registrationType: true,
      role: true,
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

/** Profile fields for `upsertEventSpeaker`. Only name is required; the rest are
 *  optional (a Speaker only requires eventId/email/firstName/lastName). */
export interface EventSpeakerProfile {
  firstName: string;
  lastName: string;
  title?: Title | null;
  role?: AttendeeRole | null;
  additionalEmail?: string | null;
  organization?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  country?: string | null;
  specialty?: string | null;
  customSpecialty?: string | null;
  registrationType?: string | null;
  /** Only applied on CREATE (links the speaker to an existing registration). */
  sourceRegistrationId?: string | null;
}

/**
 * Find-or-create the Speaker for `(eventId, email)` and link it to `userId`,
 * returning the speaker id. **Transaction-aware** — the caller passes its own
 * `tx` so this runs inside the caller's atomic boundary (the submitter route
 * creates the User + Speaker in ONE transaction).
 *
 * `overwriteExisting`:
 *   - `true`  (sign-UP form) — the user just typed fresh details, so refresh the
 *     existing speaker's profile from `profile`.
 *   - `false` (sign-IN flow) — don't clobber an existing profile; only ensure
 *     the `userId` link so `/abstracts/new` recognises it as "my speaker".
 *
 * Both abstract-onboarding routes (`submitter` + `abstract-start`) shared this
 * ~40-line block verbatim; centralising it removes the Speaker-shape drift risk.
 * (Pair with `ensureSpeakerCompanionRegistration` for the badge/check-in facet.)
 */
export async function upsertEventSpeaker(
  tx: Prisma.TransactionClient,
  args: {
    eventId: string;
    email: string;
    userId: string;
    profile: EventSpeakerProfile;
    overwriteExisting: boolean;
  },
): Promise<string> {
  const { eventId, email, userId, profile, overwriteExisting } = args;

  const existing = await tx.speaker.findUnique({
    where: { eventId_email: { eventId, email } },
    select: { id: true },
  });

  if (existing) {
    await tx.speaker.update({
      where: { id: existing.id },
      // Sign-in flow: only ensure the link. Sign-up flow: refresh the profile
      // from `profile`. Values are passed THROUGH (not `?? null`): Prisma treats
      // `undefined` as "leave unchanged" and `null` as "set null", so the caller
      // controls each field's semantics (e.g. pass `data.state || null` to clear
      // an empty field, or `data.title` to leave it untouched when absent).
      data: overwriteExisting
        ? {
            userId,
            title: profile.title,
            role: profile.role,
            firstName: profile.firstName,
            lastName: profile.lastName,
            additionalEmail: profile.additionalEmail,
            organization: profile.organization,
            jobTitle: profile.jobTitle,
            phone: profile.phone,
            city: profile.city,
            state: profile.state,
            zipCode: profile.zipCode,
            country: profile.country,
            specialty: profile.specialty,
            customSpecialty: profile.customSpecialty,
            registrationType: profile.registrationType,
          }
        : { userId },
    });
    return existing.id;
  }

  const created = await tx.speaker.create({
    data: {
      eventId,
      userId,
      email,
      title: profile.title ?? null,
      role: profile.role ?? null,
      firstName: profile.firstName,
      lastName: profile.lastName,
      additionalEmail: profile.additionalEmail ?? null,
      organization: profile.organization ?? null,
      jobTitle: profile.jobTitle ?? null,
      phone: profile.phone ?? null,
      city: profile.city ?? null,
      state: profile.state ?? null,
      zipCode: profile.zipCode ?? null,
      country: profile.country ?? null,
      specialty: profile.specialty ?? null,
      customSpecialty: profile.customSpecialty ?? null,
      registrationType: profile.registrationType ?? null,
      sourceRegistrationId: profile.sourceRegistrationId ?? null,
      status: "CONFIRMED",
    },
    select: { id: true },
  });
  return created.id;
}
