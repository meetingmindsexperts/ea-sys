import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { generateQRCode } from "@/lib/utils";
import { apiLogger } from "@/lib/logger";

const createRegistrationSchema = z.object({
  ticketTypeId: z.string().min(1),
  attendee: z.object({
    email: z.string().email(),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    company: z.string().optional(),
    jobTitle: z.string().optional(),
    phone: z.string().optional(),
    dietaryReqs: z.string().optional(),
    customFields: z.record(z.string(), z.any()).optional(),
  }),
  notes: z.string().optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    // Parallelize params and auth
    const [{ eventId }, session] = await Promise.all([
      params,
      auth(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const paymentStatus = searchParams.get("paymentStatus");
    const ticketTypeId = searchParams.get("ticketTypeId");

    // Parallelize event validation and registrations fetch
    const [event, registrations] = await Promise.all([
      db.event.findFirst({
        where: {
          id: eventId,
          organizationId: session.user.organizationId,
        },
        select: { id: true },
      }),
      db.registration.findMany({
        where: {
          eventId,
          ...(status && { status: status as any }),
          ...(paymentStatus && { paymentStatus: paymentStatus as any }),
          ...(ticketTypeId && { ticketTypeId }),
        },
        include: {
          attendee: true,
          ticketType: true,
          payments: {
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const response = NextResponse.json(registrations);
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching registrations" });
    return NextResponse.json(
      { error: "Failed to fetch registrations" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    // Parallelize params, auth, and body parsing
    const [{ eventId }, session, body] = await Promise.all([
      params,
      auth(),
      req.json(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const validated = createRegistrationSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { ticketTypeId, attendee, notes } = validated.data;

    // Parallelize event, ticket type, and existing attendee lookup
    const [event, ticketType, existingAttendee] = await Promise.all([
      db.event.findFirst({
        where: {
          id: eventId,
          organizationId: session.user.organizationId,
        },
        select: { id: true },
      }),
      db.ticketType.findFirst({
        where: {
          id: ticketTypeId,
          eventId,
          isActive: true,
        },
      }),
      db.attendee.findFirst({
        where: { email: attendee.email },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!ticketType) {
      return NextResponse.json(
        { error: "Ticket type not found or inactive" },
        { status: 404 }
      );
    }

    if (ticketType.soldCount >= ticketType.quantity) {
      return NextResponse.json(
        { error: "Tickets sold out" },
        { status: 400 }
      );
    }

    // Check if sales period is valid
    const now = new Date();
    if (ticketType.salesStart && new Date(ticketType.salesStart) > now) {
      return NextResponse.json(
        { error: "Ticket sales have not started" },
        { status: 400 }
      );
    }
    if (ticketType.salesEnd && new Date(ticketType.salesEnd) < now) {
      return NextResponse.json(
        { error: "Ticket sales have ended" },
        { status: 400 }
      );
    }

    // Use existing attendee or create new one
    let attendeeRecord = existingAttendee;

    if (!attendeeRecord) {
      attendeeRecord = await db.attendee.create({
        data: {
          email: attendee.email,
          firstName: attendee.firstName,
          lastName: attendee.lastName,
          company: attendee.company || null,
          jobTitle: attendee.jobTitle || null,
          phone: attendee.phone || null,
          dietaryReqs: attendee.dietaryReqs || null,
          customFields: attendee.customFields || {},
        },
      });
    }

    // Check if attendee already registered for this event
    const existingRegistration = await db.registration.findFirst({
      where: {
        eventId,
        attendeeId: attendeeRecord.id,
        status: { notIn: ["CANCELLED"] },
      },
    });

    if (existingRegistration) {
      return NextResponse.json(
        { error: "Attendee already registered for this event" },
        { status: 400 }
      );
    }

    // Create registration
    const registration = await db.registration.create({
      data: {
        eventId,
        ticketTypeId,
        attendeeId: attendeeRecord.id,
        status: ticketType.requiresApproval ? "PENDING" : "CONFIRMED",
        paymentStatus: Number(ticketType.price) === 0 ? "PAID" : "UNPAID",
        qrCode: generateQRCode(),
        notes: notes || null,
      },
      include: {
        attendee: true,
        ticketType: true,
      },
    });

    // Update ticket sold count
    await db.ticketType.update({
      where: { id: ticketTypeId },
      data: { soldCount: { increment: 1 } },
    });

    // Log the action (non-blocking for better response time)
    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "CREATE",
        entityType: "Registration",
        entityId: registration.id,
        changes: JSON.parse(JSON.stringify({ registration })),
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to create audit log" }));

    return NextResponse.json(registration, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating registration" });
    return NextResponse.json(
      { error: "Failed to create registration" },
      { status: 500 }
    );
  }
}
