import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { decryptSecret, fetchEventContacts } from "@/lib/eventsair-client";
import { downloadExternalPhoto } from "@/lib/storage";

// Allow up to 60s for external EventsAir API calls
export const maxDuration = 60;

const importSchema = z.object({
  eventsAirEventId: z.string().min(1),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(50),
});

/** POST: Import contacts from an EventsAir event into the org-wide Contact store */
export async function POST(req: Request) {
  try {
    const [session, body] = await Promise.all([auth(), req.json()]);

    if (!session?.user?.organizationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const validated = importSchema.safeParse(body);
    if (!validated.success) {
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    // Get org credentials
    const org = await db.organization.findUnique({
      where: { id: session.user.organizationId },
      select: { settings: true },
    });
    const settings = (org?.settings as Record<string, unknown>) || {};
    const eventsAirCfg = settings.eventsAir as Record<string, unknown> | undefined;

    if (!eventsAirCfg?.clientId || !eventsAirCfg?.clientSecretEncrypted) {
      return NextResponse.json({ error: "EventsAir not configured" }, { status: 400 });
    }

    const creds = {
      clientId: eventsAirCfg.clientId as string,
      clientSecret: decryptSecret(eventsAirCfg.clientSecretEncrypted as string),
    };

    apiLogger.info({
      msg: "Contact store import started",
      source: "eventsair",
      userId: session.user.id,
      eventsAirEventId: validated.data.eventsAirEventId,
      offset: validated.data.offset,
    });

    const { contacts, hasMore } = await fetchEventContacts(
      creds,
      validated.data.eventsAirEventId,
      validated.data.offset,
      validated.data.limit,
    );

    const organizationId = session.user.organizationId;

    // Look up EA-SYS event mapped to this EventsAir event (for event activity tracking)
    const mappedEvent = await db.event.findFirst({
      where: {
        organizationId,
        externalId: validated.data.eventsAirEventId,
        externalSource: "eventsair",
      },
      select: { id: true },
    });
    const mappedEventId = mappedEvent?.id ?? null;

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    // Filter valid contacts and collect emails
    const validContacts: { email: string; contact: (typeof contacts)[number] }[] = [];
    for (const contact of contacts) {
      if (!contact.primaryEmail) {
        skipped++;
        continue;
      }
      validContacts.push({ email: contact.primaryEmail.toLowerCase().trim(), contact });
    }

    // Pre-fetch existing contacts in one query to avoid N+1
    const existingContacts = new Map(
      (await db.contact.findMany({
        where: {
          organizationId,
          email: { in: validContacts.map((v) => v.email) },
        },
        select: { email: true, eventIds: true },
      })).map((c) => [c.email, c.eventIds])
    );

    // Upsert each contact
    for (const { email, contact } of validContacts) {
      try {
        const existingEventIds = existingContacts.get(email);
        const isExisting = existingEventIds !== undefined;

        // Build eventIds: append mappedEventId if not already present
        let eventIds: string[] | undefined;
        if (mappedEventId) {
          if (isExisting) {
            eventIds = existingEventIds.includes(mappedEventId)
              ? existingEventIds
              : [...existingEventIds, mappedEventId];
          } else {
            eventIds = [mappedEventId];
          }
        }

        // Download external photo and re-host in our storage
        const photo = contact.photo?.url
          ? await downloadExternalPhoto(contact.photo.url)
          : null;

        await db.contact.upsert({
          where: { organizationId_email: { organizationId, email } },
          update: {
            firstName: contact.firstName,
            lastName: contact.lastName,
            organization: contact.organizationName || null,
            jobTitle: contact.jobTitle || null,
            phone: contact.contactPhoneNumbers?.mobile || contact.workPhone || null,
            city: contact.primaryAddress?.city || null,
            country: contact.primaryAddress?.country || null,
            bio: contact.biography || null,
            photo,
            ...(eventIds && { eventIds }),
          },
          create: {
            organizationId,
            email,
            firstName: contact.firstName,
            lastName: contact.lastName,
            organization: contact.organizationName || null,
            jobTitle: contact.jobTitle || null,
            phone: contact.contactPhoneNumbers?.mobile || contact.workPhone || null,
            city: contact.primaryAddress?.city || null,
            country: contact.primaryAddress?.country || null,
            bio: contact.biography || null,
            photo,
            ...(eventIds && { eventIds }),
          },
        });

        if (isExisting) {
          updated++;
        } else {
          created++;
        }
      } catch (err) {
        apiLogger.error({ msg: "Unexpected error importing contact", email, error: err instanceof Error ? err.message : "Unknown" });
        errors.push(`${email}: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    }

    apiLogger.info({
      msg: "Contact store import complete",
      source: "eventsair",
      userId: session.user.id,
      processed: contacts.length,
      created,
      updated,
      skipped,
      errorCount: errors.length,
    });

    return NextResponse.json({
      processed: contacts.length,
      created,
      updated,
      skipped,
      errors,
      hasMore,
      nextOffset: validated.data.offset + contacts.length,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    apiLogger.error({ err: error, msg: "Error importing EventsAir contacts to contact store" });
    return NextResponse.json({ error: `Failed to import contacts: ${errorMessage}` }, { status: 500 });
  }
}
