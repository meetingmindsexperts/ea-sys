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
  title?: string | null;
  organization?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
  photo?: string | null;
  city?: string | null;
  country?: string | null;
  bio?: string | null;
  specialty?: string | null;
  registrationType?: string | null;
}

/** Strip undefined/null values so we only update fields that are actually provided */
function cleanFields(data: Omit<ContactSyncData, "organizationId" | "email" | "firstName" | "lastName">) {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

/**
 * Upsert a single person into the Contact store.
 * Fire-and-forget — errors are logged but never thrown.
 */
export async function syncToContact(data: ContactSyncData): Promise<void> {
  try {
    const email = data.email.toLowerCase().trim();
    if (!email) return;

    const optional = cleanFields({
      title: data.title,
      organization: data.organization,
      jobTitle: data.jobTitle,
      phone: data.phone,
      photo: data.photo,
      city: data.city,
      country: data.country,
      bio: data.bio,
      specialty: data.specialty,
      registrationType: data.registrationType,
    });

    await db.contact.upsert({
      where: {
        organizationId_email: {
          organizationId: data.organizationId,
          email,
        },
      },
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
