import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { decryptSecret, fetchEventContacts } from "@/lib/eventsair-client";

// Allow up to 60s for external EventsAir API calls
export const maxDuration = 60;

const importSchema = z.object({
  eventsAirEventId: z.string().min(1),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(50),
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

    // Pre-fetch existing emails in one query to avoid N+1
    const existingEmails = new Set(
      (await db.contact.findMany({
        where: {
          organizationId,
          email: { in: validContacts.map((v) => v.email) },
        },
        select: { email: true },
      })).map((c) => c.email)
    );

    // Upsert each contact (no redundant findUnique per row)
    for (const { email, contact } of validContacts) {
      try {
        await db.contact.upsert({
          where: { organizationId_email: { organizationId, email } },
          update: {
            firstName: contact.firstName,
            lastName: contact.lastName,
            organization: contact.organizationName || null,
            jobTitle: contact.jobTitle || null,
            phone: contact.primaryAddress?.phone || contact.workPhone || null,
            city: contact.primaryAddress?.city || null,
            country: contact.primaryAddress?.country || null,
            bio: contact.biography || null,
          },
          create: {
            organizationId,
            email,
            firstName: contact.firstName,
            lastName: contact.lastName,
            organization: contact.organizationName || null,
            jobTitle: contact.jobTitle || null,
            phone: contact.primaryAddress?.phone || contact.workPhone || null,
            city: contact.primaryAddress?.city || null,
            country: contact.primaryAddress?.country || null,
            bio: contact.biography || null,
          },
        });

        if (existingEmails.has(email)) {
          updated++;
        } else {
          created++;
        }
      } catch (err) {
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
