import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { generateBarcode } from "@/lib/utils";
import { getNextSerialId } from "@/lib/registration-serial";
import { apiLogger } from "@/lib/logger";
import { sendRegistrationConfirmation } from "@/lib/email";
import { sendWebinarConfirmationForRegistration } from "@/lib/webinar-email-sequence";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { titleEnum, attendeeRoleEnum } from "@/lib/schemas";
import { syncToContact } from "@/lib/contact-sync";
import { notifyEventAdmins } from "@/lib/notifications";
import { createInvoice, sendInvoiceEmail } from "@/lib/invoice-service";
import { refreshEventStats } from "@/lib/event-stats";

const registrationSchema = z.object({
  ticketTypeId: z.string().min(1).max(100),
  pricingTierId: z.string().min(1).max(100).optional(),
  title: titleEnum,
  role: attendeeRoleEnum,
  firstName: z.string().min(1, "First name is required").max(100),
  lastName: z.string().min(1, "Last name is required").max(100),
  email: z.string().email("Valid email is required").max(255),
  additionalEmail: z.string().email().max(255).optional().or(z.literal("")),
  organization: z.string().min(1, "Organization is required").max(255),
  jobTitle: z.string().min(1, "Position is required").max(255),
  phone: z.string().min(1, "Mobile number is required").max(50),
  city: z.string().min(1, "City is required").max(255),
  state: z.string().max(255).optional(),
  zipCode: z.string().max(20).optional(),
  country: z.string().min(1, "Country is required").max(255),
  specialty: z.string().min(1, "Specialty is required").max(255),
  customSpecialty: z.string().max(255).optional(),
  dietaryReqs: z.string().max(2000).optional(),
  // Member-specific fields
  associationName: z.string().max(255).optional(),
  memberId: z.string().max(100).optional(),
  // Student-specific fields
  studentId: z.string().max(100).optional(),
  studentIdExpiry: z.string().max(20).optional(),
  // Billing details
  taxNumber: z.string().max(100).optional(),
  billingFirstName: z.string().max(100).optional(),
  billingLastName: z.string().max(100).optional(),
  billingEmail: z.string().email().max(255).optional().or(z.literal("")),
  billingPhone: z.string().max(50).optional(),
  billingAddress: z.string().max(500).optional(),
  billingCity: z.string().max(255).optional(),
  billingState: z.string().max(255).optional(),
  billingZipCode: z.string().max(20).optional(),
  billingCountry: z.string().max(255).optional(),
  // Promo code
  promoCode: z.string().max(50).optional(),
  // Account creation
  password: z.string().min(6).max(128).optional(),
  // Tracking
  referrer: z.string().max(2000).optional(),
  utmSource: z.string().max(255).optional(),
  utmMedium: z.string().max(255).optional(),
  utmCampaign: z.string().max(255).optional(),
}).refine(
  (data) => data.specialty !== "Others" || (data.customSpecialty?.trim().length ?? 0) > 0,
  {
    message: "Please specify your specialty",
    path: ["customSpecialty"],
  },
);

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

    const { ticketTypeId, pricingTierId, title, role, firstName, lastName, additionalEmail, organization, jobTitle, phone, city, state, zipCode, country, specialty, customSpecialty, dietaryReqs, associationName, memberId, studentId, studentIdExpiry, taxNumber, billingFirstName, billingLastName, billingEmail, billingPhone, billingAddress, billingCity, billingState, billingZipCode, billingCountry, password, promoCode, referrer, utmSource, utmMedium, utmCampaign } =
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
        eventType: true,
        startDate: true,
        endDate: true,
        venue: true,
        city: true,
        organizationId: true,
        taxRate: true,
        taxLabel: true,
        bankDetails: true,
        supportEmail: true,
        organization: {
          select: {
            name: true,
            companyName: true,
            companyAddress: true,
            companyCity: true,
            companyState: true,
            companyZipCode: true,
            companyCountry: true,
            taxId: true,
            logo: true,
          },
        },
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
    const regTypeLower = registrationType.toLowerCase();

    // Validate conditional required fields
    if (regTypeLower.includes("member") && !memberId?.trim()) {
      apiLogger.warn({ msg: "Member registration missing memberId", email, registrationType });
      return NextResponse.json({ error: "Member ID is required for member registration" }, { status: 400 });
    }
    if (regTypeLower.includes("student")) {
      if (!studentId?.trim()) {
        apiLogger.warn({ msg: "Student registration missing studentId", email, registrationType });
        return NextResponse.json({ error: "Student ID is required for student registration" }, { status: 400 });
      }
      if (!studentIdExpiry?.trim()) {
        apiLogger.warn({ msg: "Student registration missing studentIdExpiry", email, registrationType });
        return NextResponse.json({ error: "Student ID expiry date is required for student registration" }, { status: 400 });
      }
      // Validate date format
      if (isNaN(new Date(studentIdExpiry).getTime())) {
        apiLogger.warn({ msg: "Invalid studentIdExpiry date", email, studentIdExpiry });
        return NextResponse.json({ error: "Invalid student ID expiry date" }, { status: 400 });
      }
    }

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

      // Reuse orphaned attendee (left behind after registration deletion) or create new
      const attendeeData = {
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
        state: state || null,
        zipCode: zipCode || null,
        country,
        specialty,
        customSpecialty: customSpecialty || null,
        registrationType,
        dietaryReqs: dietaryReqs || null,
        associationName: associationName || null,
        memberId: memberId || null,
        studentId: studentId || null,
        studentIdExpiry: studentIdExpiry ? new Date(studentIdExpiry) : null,
      };

      // Look for an existing attendee with no active registration (orphaned)
      const existingAttendee = await tx.attendee.findFirst({
        where: {
          email,
          registrations: { none: {} },
        },
        select: { id: true },
      });

      const attendee = existingAttendee
        ? await tx.attendee.update({
            where: { id: existingAttendee.id },
            data: attendeeData,
          })
        : await tx.attendee.create({ data: attendeeData });

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

      const originalPrice = pricingTier ? Number(pricingTier.price) : Number(ticketType.price);
      const effectiveApproval = pricingTier ? pricingTier.requiresApproval : ticketType.requiresApproval;

      // Promo code validation and redemption (inside transaction for atomicity)
      let discountAmount = 0;
      let promoCodeRecord: { id: string; code: string; discountType: string; discountValue: unknown } | null = null;

      if (promoCode) {
        const promo = await tx.promoCode.findUnique({
          where: { eventId_code: { eventId: event.id, code: promoCode.toUpperCase().trim() } },
          include: { ticketTypes: { select: { ticketTypeId: true } } },
        });

        if (!promo || !promo.isActive) throw new Error("INVALID_PROMO_CODE");

        const now2 = new Date();
        if (promo.validFrom && now2 < promo.validFrom) throw new Error("INVALID_PROMO_CODE");
        if (promo.validUntil && now2 > promo.validUntil) throw new Error("INVALID_PROMO_CODE");

        // Ticket type applicability
        if (promo.ticketTypes.length > 0) {
          if (!promo.ticketTypes.some((t: { ticketTypeId: string }) => t.ticketTypeId === ticketTypeId))
            throw new Error("PROMO_CODE_NOT_APPLICABLE");
        }

        // Atomic usedCount increment (same pattern as soldCount)
        if (promo.maxUses !== null) {
          const updated = await tx.promoCode.updateMany({
            where: { id: promo.id, usedCount: { lt: promo.maxUses } },
            data: { usedCount: { increment: 1 } },
          });
          if (updated.count === 0) throw new Error("PROMO_CODE_EXHAUSTED");
        } else {
          await tx.promoCode.update({
            where: { id: promo.id },
            data: { usedCount: { increment: 1 } },
          });
        }

        // Per-email limit
        if (promo.maxUsesPerEmail !== null) {
          const emailUses = await tx.promoCodeRedemption.count({
            where: { promoCodeId: promo.id, email },
          });
          if (emailUses >= promo.maxUsesPerEmail) throw new Error("PROMO_CODE_EMAIL_LIMIT");
        }

        // Calculate discount
        if (promo.discountType === "PERCENTAGE") {
          discountAmount = originalPrice * Number(promo.discountValue) / 100;
        } else {
          discountAmount = Math.min(Number(promo.discountValue), originalPrice);
        }
        discountAmount = Math.round(discountAmount * 100) / 100;
        promoCodeRecord = promo;
      }

      const finalPrice = Math.max(0, originalPrice - discountAmount);

      // Create registration
      const generatedBarcode = generateBarcode();
      const serialId = await getNextSerialId(tx, event.id);
      const registration = await tx.registration.create({
        data: {
          eventId: event.id,
          ticketTypeId,
          pricingTierId: pricingTier?.id || null,
          attendeeId: attendee.id,
          serialId,
          status: effectiveApproval ? "PENDING" : "CONFIRMED",
          paymentStatus: finalPrice === 0 ? "PAID" : "UNPAID",
          qrCode: generatedBarcode,
          promoCodeId: promoCodeRecord?.id || null,
          discountAmount: discountAmount > 0 ? discountAmount : null,
          originalPrice: discountAmount > 0 ? originalPrice : null,
          referrer: referrer || null,
          utmSource: utmSource || null,
          utmMedium: utmMedium || null,
          utmCampaign: utmCampaign || null,
          taxNumber: taxNumber || null,
          billingFirstName: billingFirstName || null,
          billingLastName: billingLastName || null,
          billingEmail: billingEmail || null,
          billingPhone: billingPhone || null,
          billingAddress: billingAddress || null,
          billingCity: billingCity || null,
          billingState: billingState || null,
          billingZipCode: billingZipCode || null,
          billingCountry: billingCountry || null,
        },
        include: { attendee: true, ticketType: true, pricingTier: true },
      });

      // Create promo code redemption record
      if (promoCodeRecord && discountAmount > 0) {
        await tx.promoCodeRedemption.create({
          data: {
            promoCodeId: promoCodeRecord.id,
            registrationId: registration.id,
            email,
            originalPrice,
            discountAmount,
            finalPrice,
          },
        });
      }

      return { registration, discountAmount, originalPrice, finalPrice };
    });

    const { registration, discountAmount: appliedDiscount, finalPrice: registrationFinalPrice } = result;

    // Notify admins/organizers (non-blocking)
    notifyEventAdmins(event.id, {
      type: "REGISTRATION",
      title: "New Registration",
      message: `${firstName} ${lastName} registered as ${registrationType}`,
      link: `/events/${event.id}/registrations`,
    }).catch((err) => apiLogger.error({ err, msg: "Failed to send registration notification" }));

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
      associationName: associationName || null,
      memberId: memberId || null,
      studentId: studentId || null,
      studentIdExpiry: studentIdExpiry ? new Date(studentIdExpiry) : null,
    });

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(event.id);

    // Account creation: create or link user to registration
    if (password) {
      try {
        const clientIpForTerms = getClientIp(req);
        const existingUser = await db.user.findUnique({ where: { email }, select: { id: true, role: true, termsAcceptedAt: true } });

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
          // Record terms acceptance (first time only — never overwrite)
          if (!existingUser.termsAcceptedAt) {
            await db.user.update({
              where: { id: existingUser.id },
              data: { termsAcceptedAt: new Date(), termsAcceptedIp: clientIpForTerms },
            });
          }
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
              termsAcceptedAt: new Date(),
              termsAcceptedIp: clientIpForTerms,
            },
          });
          // Link this registration + any other unlinked registrations by this email
          await db.registration.updateMany({
            where: { attendee: { email }, userId: null },
            data: { userId: newUser.id },
          });
          // Notify admins of new signup (non-blocking)
          notifyEventAdmins(event.id, {
            type: "SIGNUP",
            title: "New Account Signup",
            message: `${firstName} ${lastName} (${email}) created a registrant account`,
            link: `/events/${event.id}/registrations`,
          }).catch(() => {});
        }
      } catch (accountError) {
        // Account creation failure should not block the registration
        apiLogger.error({ err: accountError, msg: "Failed to create/link user account during registration" });
      }
    }

    const finalPrice = registrationFinalPrice;
    const finalCurrency = pricingTier ? pricingTier.currency : ticketType.currency;
    const tierLabel = pricingTier ? `${ticketType.name} (${pricingTier.name})` : ticketType.name;

    // Send confirmation email.
    // WEBINAR events get the webinar-confirmation template (with join URL +
    // passcode, no PDF quote). All other event types get the standard
    // registration confirmation with PDF quote attached.
    if (event.eventType === "WEBINAR") {
      try {
        await sendWebinarConfirmationForRegistration({
          eventId: event.id,
          registrationId: registration.id,
          organizerName: event.organization.name,
          organizerEmail: event.supportEmail || "",
        });
      } catch (emailError) {
        apiLogger.error(
          { err: emailError, msg: "Failed to send webinar confirmation email", registrationId: registration.id },
        );
      }
    } else {
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
          serialId: registration.serialId,
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
          companyName: event.organization.companyName,
          companyAddress: event.organization.companyAddress,
          companyCity: event.organization.companyCity,
          companyState: event.organization.companyState,
          companyZipCode: event.organization.companyZipCode,
          companyCountry: event.organization.companyCountry,
          taxId: event.organization.taxId,
          logoPath: event.organization.logo,
          billingCity: null,
          billingCountry: null,
          jobTitle: null,
        });
      } catch (emailError) {
        apiLogger.error({ err: emailError, msg: "Failed to send confirmation email" });
      }
    }

    // Auto-create invoice for paid tickets (non-blocking)
    if (finalPrice > 0) {
      (async () => {
        try {
          const inv = await createInvoice({
            registrationId: registration.id,
            eventId: event.id,
            organizationId: event.organizationId,
          });
          await sendInvoiceEmail(inv.id);
        } catch (invErr) {
          apiLogger.error({ err: invErr, msg: "Failed to auto-create invoice", registrationId: registration.id });
        }
      })();
    }

    return NextResponse.json(
      {
        success: true,
        registration: {
          id: registration.id,
          serialId: registration.serialId,
          status: registration.status,
          paymentStatus: registration.paymentStatus,
          qrCode: registration.qrCode,
          ticketType: ticketType.name,
          pricingTier: pricingTier ? pricingTier.name : null,
          ticketPrice: finalPrice,
          ticketCurrency: finalCurrency,
          discountAmount: appliedDiscount > 0 ? appliedDiscount : null,
          promoCode: promoCode || null,
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
      if (error.message === "INVALID_PROMO_CODE") {
        return NextResponse.json(
          { error: "Invalid or expired promo code" },
          { status: 400 }
        );
      }
      if (error.message === "PROMO_CODE_NOT_APPLICABLE") {
        return NextResponse.json(
          { error: "Promo code not applicable to this ticket type" },
          { status: 400 }
        );
      }
      if (error.message === "PROMO_CODE_EXHAUSTED") {
        return NextResponse.json(
          { error: "Promo code usage limit reached" },
          { status: 400 }
        );
      }
      if (error.message === "PROMO_CODE_EMAIL_LIMIT") {
        return NextResponse.json(
          { error: "Promo code already used with this email" },
          { status: 400 }
        );
      }
    }
    // Handle Prisma unique constraint on attendee email (P2002)
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "You are already registered for this event" },
        { status: 400 }
      );
    }
    apiLogger.error({ err: error, msg: "Error creating public registration" });
    return NextResponse.json(
      { error: "Failed to complete registration" },
      { status: 500 }
    );
  }
}
