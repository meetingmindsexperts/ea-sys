import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { generateQRCode } from "@/lib/utils";
import { apiLogger } from "@/lib/logger";
import { sendRegistrationConfirmation } from "@/lib/email";
import { checkRateLimit, getClientIp } from "@/lib/security";

const registrationSchema = z.object({
  ticketTypeId: z.string().min(1),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Valid email is required"),
  organization: z.string().optional(),
  jobTitle: z.string().optional(),
  phone: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  specialty: z.string().optional(),
  dietaryReqs: z.string().optional(),
});

interface RouteParams {
  params: Promise<{ slug: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const clientIp = getClientIp(req);
    const ipRateLimit = checkRateLimit({
      key: `public-register:ip:${clientIp}`,
      limit: 30,
      windowMs: 15 * 60 * 1000,
    });

    if (!ipRateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(ipRateLimit.retryAfterSeconds) } }
      );
    }

    const [{ slug }, body] = await Promise.all([params, req.json()]);

    const validated = registrationSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { ticketTypeId, firstName, lastName, organization, jobTitle, phone, city, country, specialty, dietaryReqs } =
      validated.data;
    const email = validated.data.email.toLowerCase();

    const emailRateLimit = checkRateLimit({
      key: `public-register:email:${email}`,
      limit: 5,
      windowMs: 15 * 60 * 1000,
    });

    if (!emailRateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(emailRateLimit.retryAfterSeconds) } }
      );
    }

    // Find the event (supports both slug and event ID)
    const event = await db.event.findFirst({
      where: {
        OR: [{ slug }, { id: slug }],
        status: { in: ["PUBLISHED", "LIVE"] },
      },
      select: {
        id: true,
        name: true,
        startDate: true,
        endDate: true,
        venue: true,
        city: true,
        organizationId: true,
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Validate ticket type
    const ticketType = await db.ticketType.findFirst({
      where: {
        id: ticketTypeId,
        eventId: event.id,
        isActive: true,
      },
    });

    if (!ticketType) {
      return NextResponse.json(
        { error: "Ticket type not found or inactive" },
        { status: 404 }
      );
    }

    // Check availability
    if (ticketType.soldCount >= ticketType.quantity) {
      return NextResponse.json({ error: "Tickets sold out" }, { status: 400 });
    }

    // Check sales period
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

    // Find or create attendee
    let attendee = await db.attendee.findFirst({
      where: { email },
    });

    if (!attendee) {
      attendee = await db.attendee.create({
        data: {
          email,
          firstName,
          lastName,
          organization: organization || null,
          jobTitle: jobTitle || null,
          phone: phone || null,
          city: city || null,
          country: country || null,
          specialty: specialty || null,
          dietaryReqs: dietaryReqs || null,
        },
      });
    }

    // Check if already registered
    const existingRegistration = await db.registration.findFirst({
      where: {
        eventId: event.id,
        attendeeId: attendee.id,
        status: { notIn: ["CANCELLED"] },
      },
    });

    if (existingRegistration) {
      return NextResponse.json(
        { error: "You are already registered for this event" },
        { status: 400 }
      );
    }

    // Create registration
    const registration = await db.registration.create({
      data: {
        eventId: event.id,
        ticketTypeId,
        attendeeId: attendee.id,
        status: ticketType.requiresApproval ? "PENDING" : "CONFIRMED",
        paymentStatus: Number(ticketType.price) === 0 ? "PAID" : "UNPAID",
        qrCode: generateQRCode(),
      },
      include: {
        attendee: true,
        ticketType: true,
      },
    });

    // Update sold count
    await db.ticketType.update({
      where: { id: ticketTypeId },
      data: { soldCount: { increment: 1 } },
    });

    // Send confirmation email
    try {
      await sendRegistrationConfirmation({
        to: email,
        firstName,
        eventName: event.name,
        eventDate: event.startDate,
        eventVenue: event.venue || "",
        eventCity: event.city || "",
        ticketType: ticketType.name,
        registrationId: registration.id,
        qrCode: registration.qrCode || "",
      });
    } catch (emailError) {
      apiLogger.error({ err: emailError, msg: "Failed to send confirmation email" });
      // Don't fail the registration if email fails
    }

    return NextResponse.json(
      {
        success: true,
        registration: {
          id: registration.id,
          status: registration.status,
          qrCode: registration.qrCode,
          ticketType: ticketType.name,
          attendee: {
            firstName,
            lastName,
            email,
          },
        },
        event: {
          name: event.name,
          startDate: event.startDate,
          venue: event.venue,
          city: event.city,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating public registration" });
    return NextResponse.json(
      { error: "Failed to complete registration" },
      { status: 500 }
    );
  }
}
