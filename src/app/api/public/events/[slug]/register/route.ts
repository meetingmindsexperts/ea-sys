import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { generateQRCode } from "@/lib/utils";
import { apiLogger } from "@/lib/logger";
import { sendRegistrationConfirmation } from "@/lib/email";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { titleEnum } from "@/lib/schemas";
import { syncToContact } from "@/lib/contact-sync";

const registrationSchema = z.object({
  ticketTypeId: z.string().min(1).max(100),
  title: titleEnum.optional(),
  firstName: z.string().min(1, "First name is required").max(100),
  lastName: z.string().min(1, "Last name is required").max(100),
  email: z.string().email("Valid email is required").max(255),
  organization: z.string().max(255).optional(),
  jobTitle: z.string().max(255).optional(),
  phone: z.string().max(50).optional(),
  city: z.string().max(255).optional(),
  country: z.string().max(255).optional(),
  specialty: z.string().max(255).optional(),
  registrationType: z.string().max(255).optional(),
  dietaryReqs: z.string().max(2000).optional(),
});

interface RouteParams {
  params: Promise<{ slug: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const clientIp = getClientIp(req);

    // Burst limiter: catch bots hammering the endpoint (3 req / 60s per IP)
    const burstLimit = checkRateLimit({
      key: `public-register:burst:${clientIp}`,
      limit: 3,
      windowMs: 60 * 1000,
    });
    if (!burstLimit.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(burstLimit.retryAfterSeconds) } }
      );
    }

    // Sustained limiter: 10 registrations per IP per 15 min (covers shared WiFi)
    const ipRateLimit = checkRateLimit({
      key: `public-register:ip:${clientIp}`,
      limit: 10,
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

    const { ticketTypeId, title, firstName, lastName, organization, jobTitle, phone, city, country, specialty, registrationType, dietaryReqs } =
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

    // Early check (non-authoritative — the real check is inside the transaction)
    if (ticketType.soldCount >= ticketType.quantity) {
      return NextResponse.json({ error: "Tickets sold out" }, { status: 400 });
    }

    // Atomic transaction: attendee upsert + duplicate check + soldCount increment + registration create
    const result = await db.$transaction(async (tx) => {
      // Upsert attendee -- unique constraint on email prevents duplicates under concurrency
      const attendee = await tx.attendee.upsert({
        where: { email },
        update: {
          title: title || null,
          firstName,
          lastName,
          organization: organization || null,
          jobTitle: jobTitle || null,
          phone: phone || null,
          city: city || null,
          country: country || null,
          specialty: specialty || null,
          registrationType: registrationType || null,
          dietaryReqs: dietaryReqs || null,
        },
        create: {
          title: title || null,
          email,
          firstName,
          lastName,
          organization: organization || null,
          jobTitle: jobTitle || null,
          phone: phone || null,
          city: city || null,
          country: country || null,
          specialty: specialty || null,
          registrationType: registrationType || null,
          dietaryReqs: dietaryReqs || null,
        },
      });

      // Check if already registered
      const existingRegistration = await tx.registration.findFirst({
        where: {
          eventId: event.id,
          attendeeId: attendee.id,
          status: { notIn: ["CANCELLED"] },
        },
      });
      if (existingRegistration) {
        throw new Error("ALREADY_REGISTERED");
      }

      // Atomically increment soldCount only if tickets are still available
      const updated = await tx.ticketType.updateMany({
        where: { id: ticketTypeId, soldCount: { lt: ticketType.quantity } },
        data: { soldCount: { increment: 1 } },
      });
      if (updated.count === 0) {
        throw new Error("SOLD_OUT");
      }

      // Create registration
      const registration = await tx.registration.create({
        data: {
          eventId: event.id,
          ticketTypeId,
          attendeeId: attendee.id,
          status: ticketType.requiresApproval ? "PENDING" : "CONFIRMED",
          paymentStatus: Number(ticketType.price) === 0 ? "PAID" : "UNPAID",
          qrCode: generateQRCode(),
        },
        include: { attendee: true, ticketType: true },
      });

      return registration;
    });

    if (result instanceof Error) {
      // Should not reach here, but safety check
      throw result;
    }

    const registration = result;

    // Sync to org contact store (fire-and-forget)
    syncToContact({
      organizationId: event.organizationId,
      email,
      firstName,
      lastName,
      title: title || null,
      organization: organization || null,
      jobTitle: jobTitle || null,
      phone: phone || null,
      city: city || null,
      country: country || null,
      specialty: specialty || null,
      registrationType: registrationType || null,
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
    if (error instanceof Error) {
      if (error.message === "ALREADY_REGISTERED") {
        return NextResponse.json(
          { error: "You are already registered for this event" },
          { status: 400 }
        );
      }
      if (error.message === "SOLD_OUT") {
        return NextResponse.json(
          { error: "Tickets sold out" },
          { status: 400 }
        );
      }
    }
    apiLogger.error({ err: error, msg: "Error creating public registration" });
    return NextResponse.json(
      { error: "Failed to complete registration" },
      { status: 500 }
    );
  }
}
