import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { generateQRCode } from "@/lib/utils";
import { apiLogger } from "@/lib/logger";
import { sendRegistrationConfirmation } from "@/lib/email";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { titleEnum, attendeeRoleEnum } from "@/lib/schemas";
import { syncToContact } from "@/lib/contact-sync";
import { notifyEventAdmins } from "@/lib/notifications";

const registrationSchema = z.object({
  ticketTypeId: z.string().min(1).max(100),
  pricingTierId: z.string().min(1).max(100).optional(),
  title: titleEnum,
  role: attendeeRoleEnum,
  firstName: z.string().min(1, "First name is required").max(100),
  lastName: z.string().min(1, "Last name is required").max(100),
  email: z.string().email("Valid email is required").max(255),
  additionalEmail: z.string().email().max(255).optional().or(z.literal("")),
  organization: z.string().max(255).optional(),
  jobTitle: z.string().max(255).optional(),
  phone: z.string().max(50).optional(),
  city: z.string().max(255).optional(),
  country: z.string().min(1, "Country is required").max(255),
  specialty: z.string().min(1, "Specialty is required").max(255),
  customSpecialty: z.string().max(255).optional(),
  dietaryReqs: z.string().max(2000).optional(),
  // Account creation
  password: z.string().min(6).max(128).optional(),
  // Tracking
  referrer: z.string().max(2000).optional(),
  utmSource: z.string().max(255).optional(),
  utmMedium: z.string().max(255).optional(),
  utmCampaign: z.string().max(255).optional(),
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

    const { ticketTypeId, pricingTierId, title, role, firstName, lastName, additionalEmail, organization, jobTitle, phone, city, country, specialty, customSpecialty, dietaryReqs, password, referrer, utmSource, utmMedium, utmCampaign } =
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
        taxRate: true,
        taxLabel: true,
        bankDetails: true,
        supportEmail: true,
        organization: { select: { name: true } },
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
        { error: "Registration type not found or inactive" },
        { status: 404 }
      );
    }

    // Resolve pricing tier (new flow) or fall back to legacy ticketType fields
    let pricingTier: { id: string; name: string; price: number | unknown; currency: string; quantity: number; soldCount: number; requiresApproval: boolean; salesStart: Date | null; salesEnd: Date | null } | null = null;

    if (pricingTierId) {
      const tier = await db.pricingTier.findFirst({
        where: { id: pricingTierId, ticketTypeId, isActive: true },
      });
      if (!tier) {
        return NextResponse.json({ error: "Pricing tier not found or inactive" }, { status: 404 });
      }
      pricingTier = tier;
    }

    // Use pricing tier for capacity/sales checks if available, otherwise fall back to ticket type
    const capacitySource = pricingTier || ticketType;

    const now = new Date();
    if (capacitySource.salesStart && new Date(capacitySource.salesStart) > now) {
      return NextResponse.json(
        { error: "Registration sales have not started" },
        { status: 400 }
      );
    }
    if (capacitySource.salesEnd && new Date(capacitySource.salesEnd) < now) {
      return NextResponse.json(
        { error: "Registration sales have ended" },
        { status: 400 }
      );
    }

    // Early check (non-authoritative — the real check is inside the transaction)
    if (capacitySource.soldCount >= capacitySource.quantity) {
      return NextResponse.json({ error: "Sold out" }, { status: 400 });
    }

    // Derive registrationType from the selected ticket type name
    const registrationType = ticketType.name;

    // Atomic transaction: attendee create + duplicate check + soldCount increment + registration create
    const result = await db.$transaction(async (tx) => {
      // Check if already registered (same email + same event)
      const existingRegistration = await tx.registration.findFirst({
        where: {
          eventId: event.id,
          attendee: { email },
          status: { notIn: ["CANCELLED"] },
        },
        select: { id: true },
      });
      if (existingRegistration) {
        throw new Error("ALREADY_REGISTERED");
      }

      // Create a new attendee record for this registration
      const attendee = await tx.attendee.create({
        data: {
          title,
          role,
          email,
          firstName,
          lastName,
          additionalEmail: additionalEmail || null,
          organization: organization || null,
          jobTitle: jobTitle || null,
          phone: phone || null,
          city: city || null,
          country,
          specialty,
          customSpecialty: customSpecialty || null,
          registrationType,
          dietaryReqs: dietaryReqs || null,
        },
      });

      // Atomically increment soldCount on the correct capacity source
      if (pricingTier) {
        const updated = await tx.pricingTier.updateMany({
          where: { id: pricingTier.id, soldCount: { lt: pricingTier.quantity } },
          data: { soldCount: { increment: 1 } },
        });
        if (updated.count === 0) throw new Error("SOLD_OUT");
      } else {
        const updated = await tx.ticketType.updateMany({
          where: { id: ticketTypeId, soldCount: { lt: ticketType.quantity } },
          data: { soldCount: { increment: 1 } },
        });
        if (updated.count === 0) throw new Error("SOLD_OUT");
      }

      const effectivePrice = pricingTier ? Number(pricingTier.price) : Number(ticketType.price);
      const effectiveApproval = pricingTier ? pricingTier.requiresApproval : ticketType.requiresApproval;

      // Create registration
      const registration = await tx.registration.create({
        data: {
          eventId: event.id,
          ticketTypeId,
          pricingTierId: pricingTier?.id || null,
          attendeeId: attendee.id,
          status: effectiveApproval ? "PENDING" : "CONFIRMED",
          paymentStatus: effectivePrice === 0 ? "PAID" : "UNPAID",
          qrCode: generateQRCode(),
          referrer: referrer || null,
          utmSource: utmSource || null,
          utmMedium: utmMedium || null,
          utmCampaign: utmCampaign || null,
        },
        include: { attendee: true, ticketType: true, pricingTier: true },
      });

      return registration;
    });

    if (result instanceof Error) {
      // Should not reach here, but safety check
      throw result;
    }

    const registration = result;

    // Notify admins/organizers (non-blocking)
    notifyEventAdmins(event.id, {
      type: "REGISTRATION",
      title: "New Registration",
      message: `${firstName} ${lastName} registered as ${registrationType}`,
      link: `/events/${event.id}/registrations`,
    }).catch(() => {});

    // Log audit entry (non-blocking)
    db.auditLog.create({
      data: {
        eventId: event.id,
        action: "CREATE",
        entityType: "Registration",
        entityId: registration.id,
        changes: {
          source: "public_registration",
          confirmationNumber: registration.id,
          attendee: { firstName, lastName, email },
          ticketType: registrationType,
          pricingTier: pricingTier ? pricingTier.name : null,
          status: registration.status,
          ip: getClientIp(req),
        },
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to create audit log for public registration" }));

    // Sync to org contact store (awaited — errors caught internally)
    await syncToContact({
      organizationId: event.organizationId,
      eventId: event.id,
      email,
      firstName,
      lastName,
      title: title || null,
      role: role || null,
      additionalEmail: additionalEmail || null,
      organization: organization || null,
      jobTitle: jobTitle || null,
      phone: phone || null,
      city: city || null,
      country: country || null,
      specialty: specialty || null,
      customSpecialty: customSpecialty || null,
      registrationType,
    });

    // Account creation: create or link user to registration
    if (password) {
      try {
        const existingUser = await db.user.findUnique({ where: { email }, select: { id: true, role: true } });

        if (existingUser) {
          // Link registration to existing user
          await db.registration.update({
            where: { id: registration.id },
            data: { userId: existingUser.id },
          });
          // Also link any other unlinked registrations by this email
          await db.registration.updateMany({
            where: { attendee: { email }, userId: null },
            data: { userId: existingUser.id },
          });
        } else {
          // Create new REGISTRANT user
          const passwordHash = await bcrypt.hash(password, 10);
          const newUser = await db.user.create({
            data: {
              email,
              passwordHash,
              firstName,
              lastName,
              role: "REGISTRANT",
              organizationId: null,
              specialty: specialty || null,
            },
          });
          // Link this registration + any other unlinked registrations by this email
          await db.registration.updateMany({
            where: { attendee: { email }, userId: null },
            data: { userId: newUser.id },
          });
        }
      } catch (accountError) {
        // Account creation failure should not block the registration
        apiLogger.error({ err: accountError, msg: "Failed to create/link user account during registration" });
      }
    }

    const finalPrice = pricingTier ? Number(pricingTier.price) : Number(ticketType.price);
    const finalCurrency = pricingTier ? pricingTier.currency : ticketType.currency;
    const tierLabel = pricingTier ? `${ticketType.name} (${pricingTier.name})` : ticketType.name;

    // Send confirmation email
    try {
      await sendRegistrationConfirmation({
        to: email,
        firstName,
        lastName,
        title: title || null,
        organization: organization || null,
        eventName: event.name,
        eventDate: event.startDate,
        eventVenue: event.venue || "",
        eventCity: event.city || "",
        ticketType: tierLabel,
        pricingTierName: pricingTier?.name || null,
        registrationId: registration.id,
        qrCode: registration.qrCode || "",
        eventId: event.id,
        eventSlug: slug,
        ticketPrice: finalPrice,
        ticketCurrency: finalCurrency,
        taxRate: event.taxRate ? Number(event.taxRate) : null,
        taxLabel: event.taxLabel,
        bankDetails: event.bankDetails,
        supportEmail: event.supportEmail,
        organizationName: event.organization.name,
      });
    } catch (emailError) {
      apiLogger.error({ err: emailError, msg: "Failed to send confirmation email" });
    }

    return NextResponse.json(
      {
        success: true,
        registration: {
          id: registration.id,
          status: registration.status,
          paymentStatus: registration.paymentStatus,
          qrCode: registration.qrCode,
          ticketType: ticketType.name,
          pricingTier: pricingTier ? pricingTier.name : null,
          ticketPrice: finalPrice,
          ticketCurrency: finalCurrency,
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
