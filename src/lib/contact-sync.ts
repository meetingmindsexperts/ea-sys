/**
 * Auto-sync attendees, speakers, reviewers, and submitters to the
 * organization-wide Contact store.
 *
 * Every person who interacts with an event (registers, speaks, reviews,
 * submits) should appear in the org's contact repository so the org
 * has a single source of truth for people.
 *
 * This module is intentionally fire-and-forget: sync failures are logged
 * but never propagate to the caller, so they can't break the primary
 * operation.
 */

import type { Attendee, Speaker } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { contactCategoryOf } from "@/lib/faculty-filter";

export interface ContactSyncData {
  organizationId: string;
  email: string;
  firstName: string;
  lastName: string;
  eventId?: string | null;
  title?: string | null;
  role?: string | null;
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
  registrationType?: string | null;
  associationName?: string | null;
  memberId?: string | null;
  studentId?: string | null;
  studentIdExpiry?: Date | null;
}

/**
 * The Contact columns a sync may fill, beside the name and email it always
 * writes. A list, not an object literal inside the function, so
 * person-field-contract.test.ts can hold it against the declared person
 * fields: a field a Contact shares with an Attendee or a Speaker cannot be
 * left out of here without a named exception. It says what the sync ACCEPTS;
 * each caller still builds its own payload, and can leave a field out.
 */
export const CONTACT_SYNC_OPTIONAL_FIELDS = [
  "title",
  "role",
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
  "registrationType",
  "associationName",
  "memberId",
  "studentId",
  "studentIdExpiry",
] as const satisfies readonly (keyof ContactSyncData)[];

/** Compile-time: every key of ContactSyncData is written by the sync, here or by name below. */
type ContactSyncKeyWritten = (typeof CONTACT_SYNC_OPTIONAL_FIELDS)[number] | "organizationId" | "email" | "firstName" | "lastName" | "eventId";
const _everyContactSyncKeyIsWritten: Exclude<keyof ContactSyncData, ContactSyncKeyWritten> extends never ? true : never = true;
void _everyContactSyncKeyIsWritten;

export type ContactSyncOptionalField = (typeof CONTACT_SYNC_OPTIONAL_FIELDS)[number];

/** Which organisation's contact, and through which event the person came. */
export interface ContactSyncTarget {
  organizationId: string;
  eventId?: string | null;
}

/**
 * The columns a contact sync needs from an Attendee row: the name, the email
 * and EVERY optional field the sync accepts. A caller that selected fewer
 * columns does not compile, which is the point: until Nov 13, 2026 each caller
 * typed its own payload and most left fields out (a person's own edit never
 * sent their Role, State or Zip; docs/ORG_FIELDS_PLAN.md section 3a).
 */
export type AttendeeContactSource = Pick<Attendee, "email" | "firstName" | "lastName" | ContactSyncOptionalField>;

/** The contact sync payload for an Attendee row: every field the sync accepts, none typed by hand. */
export function contactSyncFromAttendee(attendee: AttendeeContactSource, target: ContactSyncTarget): ContactSyncData {
  const optional = Object.fromEntries(CONTACT_SYNC_OPTIONAL_FIELDS.map((field) => [field, attendee[field]])) as Pick<AttendeeContactSource, ContactSyncOptionalField>;
  return {
    organizationId: target.organizationId,
    eventId: target.eventId,
    email: attendee.email,
    firstName: attendee.firstName,
    lastName: attendee.lastName,
    ...optional,
  };
}

/** The optional fields a Speaker row has; the rest of the list (member and student IDs, association) are an attendee's. */
type SpeakerContactField = Extract<ContactSyncOptionalField, keyof Speaker>;

/** The columns a contact sync needs from a Speaker row. */
export type SpeakerContactSource = Pick<Speaker, "email" | "firstName" | "lastName" | SpeakerContactField>;

/**
 * The contact sync payload for a Speaker row. One field is not a plain copy:
 * a speaker's registration type reaches the contact only through
 * `contactCategoryOf`, because "Faculty" is what every speaker carries for the
 * speakers API and it must never replace a contact's own category (which feeds
 * `registration_type` in contacts_centralv1, and from there Mailchimp).
 */
export function contactSyncFromSpeaker(speaker: SpeakerContactSource, target: ContactSyncTarget): ContactSyncData {
  const optional: Partial<Record<ContactSyncOptionalField, unknown>> = {};
  for (const field of CONTACT_SYNC_OPTIONAL_FIELDS) {
    if (!(field in speaker)) continue;
    optional[field] = speaker[field as SpeakerContactField];
  }
  return {
    organizationId: target.organizationId,
    eventId: target.eventId,
    email: speaker.email,
    firstName: speaker.firstName,
    lastName: speaker.lastName,
    ...(optional as Partial<Pick<ContactSyncData, ContactSyncOptionalField>>),
    registrationType: contactCategoryOf(speaker.registrationType),
  };
}

/**
 * Enrich-only field filter. Drops `undefined`, `null`, AND `""` so a write can
 * fill in or update a field with real data but **never clears** an already-
 * populated field. This prevents a sparse write (e.g. a new-event registration
 * that leaves optionals blank — the public register passes `field || null`, or
 * a re-import with blanks) from wiping richer data an earlier event populated.
 * The record thus accumulates the best-known value per field across events.
 *
 * Shared by the Contact sync (below) and the EventsAir contact import — both
 * upsert into the same org-wide Contact. To deliberately clear a field, edit the
 * record directly; those paths don't go through this filter.
 */
export function omitBlankFields(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null && value !== "") {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Upsert a single person into the Contact store.
 * If eventId is provided, it is appended to the contact's eventIds array (no duplicates).
 * Fire-and-forget — errors are logged but never thrown.
 */
export async function syncToContact(data: ContactSyncData): Promise<void> {
  try {
    const email = data.email.toLowerCase().trim();
    if (!email) return;

    const optional = omitBlankFields(Object.fromEntries(CONTACT_SYNC_OPTIONAL_FIELDS.map((field) => [field, data[field]])));

    const compositeKey = {
      organizationId_email: {
        organizationId: data.organizationId,
        email,
      },
    };

    if (data.eventId) {
      // Check if contact exists and already has this eventId
      const existing = await db.contact.findUnique({
        where: compositeKey,
        select: { eventIds: true },
      });

      if (existing) {
        const eventIds = existing.eventIds.includes(data.eventId)
          ? existing.eventIds
          : [...existing.eventIds, data.eventId];

        await db.contact.update({
          where: compositeKey,
          data: {
            firstName: data.firstName,
            lastName: data.lastName,
            eventIds,
            ...optional,
          },
        });
      } else {
        await db.contact.create({
          data: {
            organizationId: data.organizationId,
            email,
            firstName: data.firstName,
            lastName: data.lastName,
            eventIds: [data.eventId],
            ...optional,
          },
        });
      }
    } else {
      // No eventId — simple upsert without touching eventIds
      await db.contact.upsert({
        where: compositeKey,
        update: {
          firstName: data.firstName,
          lastName: data.lastName,
          ...optional,
        },
        create: {
          organizationId: data.organizationId,
          email,
          firstName: data.firstName,
          lastName: data.lastName,
          ...optional,
        },
      });
    }
  } catch (err) {
    apiLogger.warn({
      msg: "Contact sync failed",
      email: data.email,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Batch-sync multiple people into the Contact store.
 * Processes sequentially to avoid overwhelming the DB; errors are per-item.
 */
export async function syncManyToContacts(items: ContactSyncData[]): Promise<void> {
  for (const item of items) {
    await syncToContact(item);
  }
}
