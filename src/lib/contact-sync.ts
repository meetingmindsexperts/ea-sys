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
// The payload, its field list and the builders live in contact-sync-payload.ts.
import { CONTACT_SYNC_OPTIONAL_FIELDS, type ContactSyncData } from "@/lib/contact-sync-payload";

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
    // Written only where the contact's own column is empty (see `fillBlanks`
    // on the payload). A field this write also sets is not one of them.
    const fill = omitBlankFields(Object.fromEntries(
      CONTACT_SYNC_OPTIONAL_FIELDS
        .filter((field) => field !== "registrationType" && !(field in optional))
        .map((field) => [field, (data.fillBlanks as Record<string, unknown> | undefined)?.[field]]),
    ));
    const fillSelect = Object.fromEntries(Object.keys(fill).map((field) => [field, true]));
    const blanksOf = (existing: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(fill).filter(([field]) => existing[field] === null || existing[field] === undefined || existing[field] === ""));

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
        select: { eventIds: true, ...fillSelect },
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
            ...blanksOf(existing),
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
            ...fill,
            ...optional,
          },
        });
      }
    } else {
      // No eventId: an upsert that leaves eventIds alone. With blanks to fill,
      // the contact's own values are read first.
      const existing = Object.keys(fill).length > 0
        ? await db.contact.findUnique({ where: compositeKey, select: { id: true, ...fillSelect } })
        : null;
      await db.contact.upsert({
        where: compositeKey,
        update: {
          firstName: data.firstName,
          lastName: data.lastName,
          ...(existing ? blanksOf(existing) : {}),
          ...optional,
        },
        create: {
          organizationId: data.organizationId,
          email,
          firstName: data.firstName,
          lastName: data.lastName,
          ...fill,
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
