import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { recordImport } from "@/lib/audit-data-transfer";
import { runWithTenant } from "@/lib/tenant-context";
import { denyReviewer } from "@/lib/auth-guards";
import { generateBarcode } from "@/lib/utils";
import { getNextSerialId } from "@/lib/registration-serial";
import { incrementEventSeatsOverselling } from "@/lib/registration-seat-db";
import { decryptSecret, fetchEventContacts } from "@/lib/eventsair-client";
import {
  eventChargesForRegistration,
  resolveImportFallbackTicketType,
} from "@/lib/import-ticket-type";
import { syncToContact } from "@/lib/contact-sync";
import { downloadExternalPhoto } from "@/lib/storage";

export const maxDuration = 60;

const importContactsSchema = z.object({
  eventsAirEventId: z.string().min(1),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(50),
  /** Optional fallback registration type. Omitted ⇒ rows stay uncategorised. */
  defaultTicketTypeId: z.string().min(1).nullish(),
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
    // Captured as a const so the tenant stamp survives TS narrowing inside
    // the per-row transaction closure below.
    const organizationId = session.user.organizationId;

    const denied = denyReviewer(session);
    if (denied) return denied;

    return await runWithTenant(organizationId, async () => {
    const validated = importContactsSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ msg: "events/import/eventsair:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    // Verify event
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    apiLogger.info({ msg: "Import started", importType: "contacts", source: "eventsair", eventId, userId: session.user.id });

    // Get org credentials
    const org = await db.organization.findUnique({
      where: { id: organizationId },
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

    // EventsAir contacts carry no registration type, so unless the organizer
    // explicitly picks one, imported rows stay uncategorised (`ticketTypeId`
    // null) rather than landing on an arbitrary type. This route used to take
    // an unordered `findFirst` — see import-ticket-type.ts for what that cost.
    const fallback = await resolveImportFallbackTicketType(
      eventId,
      validated.data.defaultTicketTypeId,
    );
    if (!fallback.ok) {
      apiLogger.warn({
        msg: "events/import/eventsair:invalid-default-ticket-type",
        eventId,
        userId: session.user.id,
        defaultTicketTypeId: validated.data.defaultTicketTypeId,
        code: fallback.code,
      });
      return NextResponse.json({ error: fallback.message, code: fallback.code }, { status: 400 });
    }
    const defaultTicketType = fallback.ticketType;

    // A paid event must not receive typeless rows — they'd import owing
    // nothing, with no quote, no Pay Now and no reminder. (A freshly imported
    // EventsAir event has only zero-priced seeded types, so this doesn't fire
    // on the normal new-event flow.)
    if (!defaultTicketType && (await eventChargesForRegistration(eventId))) {
      apiLogger.warn({
        msg: "events/import/eventsair:default-ticket-type-required",
        eventId,
        userId: session.user.id,
      });
      return NextResponse.json(
        {
          error:
            "This event charges for registration, so imported contacts need a registration type. Pick one before importing.",
          code: "DEFAULT_TICKET_TYPE_REQUIRED",
        },
        { status: 400 }
      );
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

        await tenantTransaction(async (tx) => {
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
              organizationId,
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

          const generatedBarcode = generateBarcode();
          const serialId = await getNextSerialId(tx, eventId, organizationId);
          await tx.registration.create({
            data: {
              organizationId,
              eventId,
              ticketTypeId: defaultTicketType?.id ?? null,
              attendeeId: attendee.id,
              serialId,
              createdSource: "CSV_IMPORT",
              status: defaultTicketType?.requiresApproval ? "PENDING" : "CONFIRMED",
              // Free ticket → COMPLIMENTARY (no payment ever taken), not PAID.
              // Matches the public register + CSV import + service-layer
              // free-ticket convention. No ticket type ⇒ no price to owe.
              paymentStatus:
                !defaultTicketType || Number(defaultTicketType.price) === 0
                  ? "COMPLIMENTARY"
                  : "UNPAID",
              qrCode: generatedBarcode,
            },
          });

          // Atomically claim a seat — the `soldCount < quantity` predicate ON
          // the update is the guard, so concurrent imports / public
          // registrations can't oversell the last seat. count 0 = full.
          // An uncategorised row has no ticket-type counter; the event-wide
          // counter below still moves for it.
          if (defaultTicketType) {
            const claimed = await tx.ticketType.updateMany({
              where: { id: defaultTicketType.id, soldCount: { lt: defaultTicketType.quantity } },
              data: { soldCount: { increment: 1 } },
            });
            if (claimed.count === 0) {
              throw new Error("TICKET_CAPACITY_REACHED");
            }
          }
          // Event-wide cap: imports BYPASS the cap (owner decision July 24,
          // 2026) — unguarded increment, warn when over.
          const eventSeat = await incrementEventSeatsOverselling(tx, eventId);
          if (eventSeat.oversold) {
            apiLogger.warn({
              msg: "import:event-oversold",
              eventId,
              newSeatCount: eventSeat.newSeatCount,
              maxAttendees: eventSeat.maxAttendees,
              source: "eventsair-import",
            });
          }
        });
        created++;

        // Sync to contact store (awaited — errors caught internally)
        await syncToContact({
          organizationId: (session.user.organizationId ?? ""),
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

    recordImport(req, {
      entityType: "Contact",
      eventId,
      organizationId: session.user.organizationId,
      userId: session.user.id,
      role: session.user.role,
      totalProcessed: contacts.length,
      created,
      skipped: skippedDetails.length,
      errors: errors.length,
      format: "eventsair",
    });

    return NextResponse.json({
      processed: contacts.length,
      created,
      skipped: skippedDetails.length,
      skippedDetails,
      errors,
      hasMore,
      nextOffset: validated.data.offset + contacts.length,
    });
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    apiLogger.error({ err: error, msg: "Error importing EventsAir contacts" });
    return NextResponse.json({ error: `Failed to import contacts: ${errorMessage}` }, { status: 500 });
  }
}
