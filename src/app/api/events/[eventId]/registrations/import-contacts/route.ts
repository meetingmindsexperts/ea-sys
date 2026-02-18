import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";

type RouteParams = { params: Promise<{ eventId: string }> };

const importSchema = z.object({
  contactIds: z.array(z.string()).min(1),
  ticketTypeId: z.string().min(1),
});

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session, body] = await Promise.all([params, auth(), req.json()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const validated = importSchema.safeParse(body);
    if (!validated.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const { contactIds, ticketTypeId } = validated.data;

    // Verify event, ticket type, and fetch contacts
    const [event, ticketType, contacts] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true },
      }),
      db.ticketType.findFirst({
        where: { id: ticketTypeId, eventId },
        select: { id: true, soldCount: true, quantity: true },
      }),
      db.contact.findMany({
        where: { id: { in: contactIds }, organizationId: session.user.organizationId! },
        select: { email: true, firstName: true, lastName: true, organization: true, jobTitle: true, phone: true },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!ticketType) {
      return NextResponse.json({ error: "Ticket type not found" }, { status: 404 });
    }

    // Find existing registrations for this event by attendee email
    const existingAttendees = await db.attendee.findMany({
      where: {
        email: { in: contacts.map((c) => c.email) },
        registrations: { some: { eventId } },
      },
      select: { email: true },
    });

    const existingEmails = new Set(existingAttendees.map((a) => a.email));
    const toCreate = contacts.filter((c) => !existingEmails.has(c.email));
    const skipped = contacts.length - toCreate.length;

    if (toCreate.length > 0) {
      // Create attendees and registrations in a transaction
      await db.$transaction(async (tx) => {
        for (const contact of toCreate) {
          const attendee = await tx.attendee.create({
            data: {
              email: contact.email,
              firstName: contact.firstName,
              lastName: contact.lastName,
              organization: contact.organization ?? undefined,
              jobTitle: contact.jobTitle ?? undefined,
              phone: contact.phone ?? undefined,
            },
          });

          await tx.registration.create({
            data: {
              eventId,
              ticketTypeId,
              attendeeId: attendee.id,
            },
          });
        }

        // Update soldCount
        await tx.ticketType.update({
          where: { id: ticketTypeId },
          data: { soldCount: { increment: toCreate.length } },
        });
      });
    }

    return NextResponse.json({ created: toCreate.length, skipped });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error importing contacts as registrations" });
    return NextResponse.json({ error: "Failed to import contacts" }, { status: 500 });
  }
}
