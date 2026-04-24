import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { generateBarcode } from "@/lib/utils";
import { getNextSerialId } from "@/lib/registration-serial";
import { decryptSecret, fetchEventContacts } from "@/lib/eventsair-client";
import { syncToContact } from "@/lib/contact-sync";
import { downloadExternalPhoto } from "@/lib/storage";

export const maxDuration = 60;

const importContactsSchema = z.object({
  eventsAirEventId: z.string().min(1),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(50),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

interface SkippedContact {
  email: string;
  reason: string;
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
      apiLogger.warn({ msg: "events/import/eventsair:zod-validation-failed", errors: validated.error.flatten() });
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
      select: { id: true, price: true, requiresApproval: true, quantity: true, soldCount: true },
    });
    if (!defaultTicketType) {
      defaultTicketType = await db.ticketType.create({
        data: { eventId, name: "General", price: 0, quantity: 999999, isActive: true },
        select: { id: true, price: true, requiresApproval: true, quantity: true, soldCount: true },
      });
    }

    let created = 0;
    const skippedDetails: SkippedContact[] = [];
    const errors: string[] = [];

    for (const contact of contacts) {
      if (!contact.primaryEmail) {
        skippedDetails.push({
          email: "(none)",
          reason: `No email — ${contact.firstName} ${contact.lastName}`,
        });
        continue;
      }

      const email = contact.primaryEmail.toLowerCase().trim();

      try {
        // Download external photo before transaction to avoid holding DB lock
        const photo = contact.photo?.url
          ? await downloadExternalPhoto(contact.photo.url)
          : null;

        await db.$transaction(async (tx) => {
          const phone = contact.contactPhoneNumbers?.mobile || contact.workPhone || null;

          // Check for duplicate registration (same email + same event)
          const existing = await tx.registration.findFirst({
            where: { eventId, attendee: { email }, status: { notIn: ["CANCELLED"] } },
            select: { id: true },
          });
          if (existing) {
            throw new Error("ALREADY_REGISTERED");
          }

          // Create a new attendee record for this registration
          const attendee = await tx.attendee.create({
            data: {
              email,
              firstName: contact.firstName,
              lastName: contact.lastName,
              organization: contact.organizationName || null,
              jobTitle: contact.jobTitle || null,
              phone,
              city: contact.primaryAddress?.city || null,
              country: contact.primaryAddress?.country || null,
              bio: contact.biography || null,
              photo,
              externalId: contact.id,
            },
          });

          // Check ticket capacity
          const freshTicket = await tx.ticketType.findUnique({
            where: { id: defaultTicketType.id },
            select: { quantity: true, soldCount: true },
          });
          if (freshTicket && freshTicket.soldCount >= freshTicket.quantity) {
            throw new Error("TICKET_CAPACITY_REACHED");
          }

          const generatedBarcode = generateBarcode();
          const serialId = await getNextSerialId(tx, eventId);
          await tx.registration.create({
            data: {
              eventId,
              ticketTypeId: defaultTicketType.id,
              attendeeId: attendee.id,
              serialId,
              status: defaultTicketType.requiresApproval ? "PENDING" : "CONFIRMED",
              paymentStatus: Number(defaultTicketType.price) === 0 ? "PAID" : "UNPAID",
              qrCode: generatedBarcode,
            },
          });

          // Increment soldCount atomically
          await tx.ticketType.update({
            where: { id: defaultTicketType.id },
            data: { soldCount: { increment: 1 } },
          });
        });
        created++;

        // Sync to contact store (awaited — errors caught internally)
        await syncToContact({
          organizationId: session.user.organizationId!,
          eventId,
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
        });
      } catch (err) {
        if (err instanceof Error && err.message === "ALREADY_REGISTERED") {
          skippedDetails.push({ email, reason: "Already registered" });
        } else if (err instanceof Error && err.message === "TICKET_CAPACITY_REACHED") {
          errors.push(`Contact ${email}: ticket capacity reached`);
        } else {
          errors.push(`Contact ${email}: ${err instanceof Error ? err.message : "unknown error"}`);
        }
      }
    }

    // Persist import log
    db.importLog.create({
      data: {
        eventId,
        userId: session.user.id,
        source: "eventsair",
        entityType: "contacts",
        totalProcessed: contacts.length,
        totalCreated: created,
        totalSkipped: skippedDetails.length,
        totalErrors: errors.length,
        skippedDetails: JSON.parse(JSON.stringify(skippedDetails)),
        errors: JSON.parse(JSON.stringify(errors)),
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to persist import log" }));

    apiLogger.info({ msg: "Import complete", importType: "contacts", source: "eventsair", eventId, userId: session.user.id, processed: contacts.length, created, skipped: skippedDetails.length, errorCount: errors.length });
    if (errors.length > 0) {
      apiLogger.warn({ msg: "Import errors", importType: "contacts", source: "eventsair", eventId, userId: session.user.id, errors: errors.slice(0, 50) });
    }

    return NextResponse.json({
      processed: contacts.length,
      created,
      skipped: skippedDetails.length,
      skippedDetails,
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
