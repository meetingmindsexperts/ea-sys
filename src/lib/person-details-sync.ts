/**
 * Person-level PERSONAL DETAILS sync between a Speaker and the same person's
 * Registration (its Attendee), within one event (Sep 29, 2026, owner: "if
 * speaker is updated registration also gets updated, just the personal form
 * details"). The tag equivalent is person-tag-sync.ts; this follows its shape.
 *
 * The two records stay separate: a speaker keeps its program facts (sessions,
 * agreements, honorarium) and a registration its money and entry facts. Only
 * the fields both forms ask for are kept in step: SYNCED_PERSON_FIELDS.
 *
 * Rules:
 *  - **Delta, not overwrite.** Only the fields that CHANGED in this edit are
 *    copied, compared trimmed. An unrelated save copies nothing, so a pair that
 *    already disagreed stays as it is until someone edits that field (owner:
 *    nothing existing is changed, only future edits).
 *  - **Same event only.** Matched by `Speaker.sourceRegistrationId` OR a shared
 *    email (case-insensitive) inside the event.
 *  - **A shared Attendee is never written.** 78 legacy Attendee rows (Feb-Mar
 *    2026) back registrations at several events, so writing one would rewrite
 *    another event's registration, invoice name included. Those are skipped
 *    and logged. Today's register path never creates a shared row.
 *  - **Best-effort.** Call it AFTER the primary write committed; a failure logs
 *    `person-details-sync:*` and never fails the edit.
 *  - **No recursion.** It writes the counterpart row directly, never through a
 *    route or service, so it cannot re-trigger itself.
 *  - **Not from the registrant portal.** A registrant's own edit is never
 *    copied onto a speaker record (review H1/H2, Sep 29, 2026): the portal has
 *    no name lock (My Details does), and a public registration with someone
 *    else's email can claim their unlinked registration, so a stranger could
 *    rewrite a faculty member's public profile or add a CC address to their
 *    mail. Organiser edits and the speaker's own edits sync; that one does not.
 *  - Email is NOT synced: it has its own change flow (email-change.ts). Tags
 *    are synced by person-tag-sync.ts.
 */
import type { AttendeeRole, Prisma, Title } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

export const SYNCED_PERSON_FIELDS = [
  "title",
  "role",
  "firstName",
  "lastName",
  "additionalEmail",
  "organization",
  "jobTitle",
  "phone",
  "photo",
  "city",
  "state",
  "zipCode",
  "country",
  "bio",
  "specialty",
  "customSpecialty",
] as const;

export type SyncedPersonField = (typeof SYNCED_PERSON_FIELDS)[number];

/** The synced columns as both tables store them. */
export interface PersonDetails {
  title?: Title | null;
  role?: AttendeeRole | null;
  firstName?: string | null;
  lastName?: string | null;
  additionalEmail?: string | null;
  organization?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
  photo?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  country?: string | null;
  bio?: string | null;
  specialty?: string | null;
  customSpecialty?: string | null;
}

/** What gets written: names are never null (both columns are required). */
export type PersonDetailsDelta = Omit<PersonDetails, "firstName" | "lastName"> & {
  firstName?: string;
  lastName?: string;
};

/** The delta's fields read off a row, so the audit shows old -> new. */
function pickDeltaFields(row: Record<string, unknown>, delta: PersonDetailsDelta): Record<string, unknown> {
  return Object.fromEntries(Object.keys(delta).map((k) => [k, row[k] ?? null]));
}

/** Prisma select for the delta's fields. */
function selectDeltaFields(delta: PersonDetailsDelta): Record<string, true> {
  return Object.fromEntries(Object.keys(delta).map((k) => [k, true]));
}

const norm = (v: unknown) => (typeof v === "string" ? v.trim() : v ?? "");

/**
 * The synced fields whose value differs between `before` and `after`, with the
 * `after` value. A field absent from `after` (undefined) is not a change. First
 * and last name are never copied as empty: both columns are required.
 */
export function computeDetailsDelta(before: PersonDetails, after: PersonDetails): PersonDetailsDelta {
  const delta: Record<string, unknown> = {};
  for (const field of SYNCED_PERSON_FIELDS) {
    if (after[field] === undefined) continue;
    if (norm(after[field]) === norm(before[field])) continue;
    const isRequiredName = field === "firstName" || field === "lastName";
    if (isRequiredName && !norm(after[field])) continue;
    delta[field] = after[field] ?? null;
  }
  // Lowercased like the speaker service stores it, so a copied CC address
  // dedupes against the primary email at send time (review L2).
  if (typeof delta.additionalEmail === "string") {
    delta.additionalEmail = delta.additionalEmail.trim().toLowerCase() || null;
  }
  return delta as PersonDetailsDelta;
}

export function detailsDeltaIsEmpty(delta: PersonDetailsDelta): boolean {
  return Object.keys(delta).length === 0;
}

/**
 * One audit row per record the sync changed, so its Activity shows the change
 * and where it came from (review M2). Fire-and-forget with a logged catch; the
 * org is stamped centrally from the eventId (withAuditOrgStamp).
 */
function auditSyncedRows(args: {
  eventId: string;
  entityType: "Registration" | "Speaker";
  /** Each changed record with its values BEFORE the sync, for the Activity diff. */
  rows: { entityId: string; before: Record<string, unknown> }[];
  actorUserId: string | null;
  from: { entityType: "Speaker" | "Registration"; entityId: string };
  delta: PersonDetailsDelta;
}): void {
  db.auditLog
    .createMany({
      data: args.rows.map(({ entityId, before }) => ({
        eventId: args.eventId,
        userId: args.actorUserId,
        action: "UPDATE",
        entityType: args.entityType,
        entityId,
        changes: {
          source: "person-details-sync",
          syncedFrom: args.from,
          before,
          after: args.delta,
          fields: Object.keys(args.delta),
        } as Prisma.InputJsonObject,
      })),
    })
    .catch((err) =>
      apiLogger.error({ err, eventId: args.eventId, entityType: args.entityType, msg: "person-details-sync:audit-failed" }),
    );
}

export interface SpeakerDetailsChange {
  eventId: string;
  speakerId: string;
  email: string;
  sourceRegistrationId: string | null;
  delta: PersonDetailsDelta;
  /** Who made the originating edit; null for token-link and system edits. */
  actorUserId?: string | null;
}

/**
 * Copy a speaker's changed details onto the person's registration(s) in the
 * same event. An Attendee that also backs a registration elsewhere is skipped.
 */
export async function syncSpeakerDetailsToRegistrations(change: SpeakerDetailsChange): Promise<void> {
  const { eventId, speakerId, email, sourceRegistrationId, delta, actorUserId = null } = change;
  if (detailsDeltaIsEmpty(delta)) return;
  try {
    const regs = await db.registration.findMany({
      where: {
        eventId,
        OR: [
          ...(sourceRegistrationId ? [{ id: sourceRegistrationId }] : []),
          { attendee: { email: { equals: email.trim(), mode: "insensitive" as const } } },
        ],
      },
      select: {
        id: true,
        attendeeId: true,
        attendee: { select: { ...selectDeltaFields(delta), _count: { select: { registrations: true } } } },
      },
    });

    const attendeeIds = new Set<string>();
    const registrationIds: string[] = [];
    const auditRows: { entityId: string; before: Record<string, unknown> }[] = [];
    for (const reg of regs) {
      if ((reg.attendee?._count.registrations ?? 0) > 1) {
        apiLogger.warn({
          msg: "person-details-sync:skipped-shared-attendee",
          eventId,
          speakerId,
          registrationId: reg.id,
          attendeeId: reg.attendeeId,
        });
        continue;
      }
      attendeeIds.add(reg.attendeeId);
      registrationIds.push(reg.id);
      auditRows.push({ entityId: reg.id, before: pickDeltaFields(reg.attendee as Record<string, unknown>, delta) });
    }
    if (attendeeIds.size === 0) return;

    await db.attendee.updateMany({ where: { id: { in: [...attendeeIds] } }, data: delta });
    // Move the registration's version token: its optimistic lock is on
    // Registration.updatedAt, so an editor holding the old values now gets the
    // usual "reload" instead of silently reverting this change (review M1).
    await db.registration.updateMany({ where: { id: { in: registrationIds } }, data: { updatedAt: new Date() } });
    auditSyncedRows({
      eventId,
      entityType: "Registration",
      rows: auditRows,
      actorUserId,
      from: { entityType: "Speaker", entityId: speakerId },
      delta,
    });
    apiLogger.info({
      msg: "person-details-sync:speaker-to-registration",
      eventId,
      speakerId,
      registrationIds,
      fields: Object.keys(delta),
    });
  } catch (err) {
    apiLogger.error({ err, eventId, speakerId, msg: "person-details-sync:speaker-to-registration-failed" });
  }
}

export interface RegistrationDetailsChange {
  eventId: string;
  registrationId: string;
  email: string;
  delta: PersonDetailsDelta;
  actorUserId?: string | null;
}

/** Copy a registration's changed details onto the person's speaker(s) in the same event. */
export async function syncRegistrationDetailsToSpeakers(change: RegistrationDetailsChange): Promise<void> {
  const { eventId, registrationId, email, delta, actorUserId = null } = change;
  if (detailsDeltaIsEmpty(delta)) return;
  try {
    const speakers = await db.speaker.findMany({
      where: {
        eventId,
        OR: [
          { sourceRegistrationId: registrationId },
          { email: { equals: email.trim(), mode: "insensitive" as const } },
        ],
      },
      select: { id: true, ...selectDeltaFields(delta) },
    });
    if (speakers.length === 0) return;
    const speakerIds = speakers.map((s) => s.id);

    // updatedAt set explicitly: the speaker's optimistic lock is on it (M1).
    await db.speaker.updateMany({ where: { id: { in: speakerIds } }, data: { ...delta, updatedAt: new Date() } });
    auditSyncedRows({
      eventId,
      entityType: "Speaker",
      rows: speakers.map((spk) => ({ entityId: spk.id, before: pickDeltaFields(spk as Record<string, unknown>, delta) })),
      actorUserId,
      from: { entityType: "Registration", entityId: registrationId },
      delta,
    });
    apiLogger.info({
      msg: "person-details-sync:registration-to-speaker",
      eventId,
      registrationId,
      speakerIds,
      fields: Object.keys(delta),
    });
  } catch (err) {
    apiLogger.error({ err, eventId, registrationId, msg: "person-details-sync:registration-to-speaker-failed" });
  }
}
