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

import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

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
