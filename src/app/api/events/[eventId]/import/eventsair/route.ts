import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { generateQRCode } from "@/lib/utils";
import { decryptSecret, fetchEventContacts } from "@/lib/eventsair-client";
import { syncToContact } from "@/lib/contact-sync";

const importContactsSchema = z.object({
  eventsAirEventId: z.string().min(1),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(500),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

/** POST: Import contacts from EventsAir into an existing EA-SYS event */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session, body] = await Promise.all([params, auth(), req.json()]);

    if (!session?.user?.organizationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const validated = importContactsSchema.safeParse(body);
    if (!validated.success) {
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    // Verify event
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    apiLogger.info({ msg: "Import started", importType: "contacts", source: "eventsair", eventId, userId: session.user.id });

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

    // Fetch contacts from EventsAir
    const { contacts, hasMore } = await fetchEventContacts(
      creds,
      validated.data.eventsAirEventId,
      validated.data.offset,
      validated.data.limit
    );

    // Ensure a default ticket type exists
    let defaultTicketType = await db.ticketType.findFirst({
      where: { eventId, isActive: true },
      select: { id: true, price: true, requiresApproval: true },
    });
    if (!defaultTicketType) {
      defaultTicketType = await db.ticketType.create({
        data: { eventId, name: "General", price: 0, quantity: 999999, isActive: true },
        select: { id: true, price: true, requiresApproval: true },
      });
    }

    let created = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const contact of contacts) {
      if (!contact.primaryEmail) {
        skipped++;
        continue;
      }

      const email = contact.primaryEmail.toLowerCase().trim();

      try {
        await db.$transaction(async (tx) => {
          // Upsert attendee
          const phone = contact.primaryAddress?.phone || contact.workPhone || null;
          const attendee = await tx.attendee.upsert({
            where: { email },
            update: {
              firstName: contact.firstName,
              lastName: contact.lastName,
              organization: contact.organizationName || null,
              jobTitle: contact.jobTitle || null,
              phone,
              city: contact.primaryAddress?.city || null,
              country: contact.primaryAddress?.country || null,
              bio: contact.biography || null,
              photo: contact.photo?.url || null,
              externalId: contact.id,
            },
            create: {
              email,
              firstName: contact.firstName,
              lastName: contact.lastName,
              organization: contact.organizationName || null,
              jobTitle: contact.jobTitle || null,
              phone,
              city: contact.primaryAddress?.city || null,
              country: contact.primaryAddress?.country || null,
              bio: contact.biography || null,
              photo: contact.photo?.url || null,
              externalId: contact.id,
            },
          });

          // Check for duplicate registration
          const existing = await tx.registration.findFirst({
            where: { eventId, attendeeId: attendee.id, status: { notIn: ["CANCELLED"] } },
          });
          if (existing) {
            throw new Error("ALREADY_REGISTERED");
          }

          await tx.registration.create({
            data: {
              eventId,
              ticketTypeId: defaultTicketType.id,
              attendeeId: attendee.id,
              status: defaultTicketType.requiresApproval ? "PENDING" : "CONFIRMED",
              paymentStatus: Number(defaultTicketType.price) === 0 ? "PAID" : "UNPAID",
              qrCode: generateQRCode(),
            },
          });
        });
        created++;

        // Sync to contact store (fire-and-forget)
        syncToContact({
          organizationId: session.user.organizationId!,
          email,
          firstName: contact.firstName,
          lastName: contact.lastName,
          organization: contact.organizationName || null,
          jobTitle: contact.jobTitle || null,
          phone: contact.primaryAddress?.phone || contact.workPhone || null,
          city: contact.primaryAddress?.city || null,
          country: contact.primaryAddress?.country || null,
          bio: contact.biography || null,
        });
      } catch (err) {
        if (err instanceof Error && err.message === "ALREADY_REGISTERED") {
          skipped++;
        } else {
          errors.push(`Contact ${email}: ${err instanceof Error ? err.message : "unknown error"}`);
        }
      }
    }

    apiLogger.info({ msg: "Import complete", importType: "contacts", source: "eventsair", eventId, userId: session.user.id, processed: contacts.length, created, skipped, errorCount: errors.length });
    if (errors.length > 0) {
      apiLogger.warn({ msg: "Import errors", importType: "contacts", source: "eventsair", eventId, userId: session.user.id, errors: errors.slice(0, 50) });
    }

    return NextResponse.json({
      processed: contacts.length,
      created,
      skipped,
      errors,
      hasMore,
      nextOffset: validated.data.offset + contacts.length,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    apiLogger.error({ err: error, msg: "Error importing EventsAir contacts" });
    return NextResponse.json({ error: `Failed to import contacts: ${errorMessage}` }, { status: 500 });
  }
}
