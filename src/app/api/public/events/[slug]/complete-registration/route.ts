import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp, hashVerificationToken } from "@/lib/security";
import { titleEnum } from "@/lib/schemas";
import { syncToContact } from "@/lib/contact-sync";
import { sendRegistrationConfirmation } from "@/lib/email";
import { notifyEventAdmins } from "@/lib/notifications";

interface RouteParams {
  params: Promise<{ slug: string }>;
}

// ── GET: Validate token and return prefilled registration data ──────────────

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug } = await params;
    const { searchParams } = new URL(req.url);
    const rawToken = searchParams.get("token");

    if (!rawToken) {
      return NextResponse.json({ error: "Token is required" }, { status: 400 });
    }

    const ipLimit = checkRateLimit({
      key: `complete-reg-get:ip:${getClientIp(req)}`,
      limit: 20,
      windowMs: 15 * 60 * 1000,
    });
    if (!ipLimit.allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const hashedToken = hashVerificationToken(rawToken);
    const tokenRecord = await db.verificationToken.findUnique({
      where: { token: hashedToken },
    });

    if (!tokenRecord) {
      apiLogger.info({ msg: "Completion token not found (invalid or already used)", ip: getClientIp(req) });
      return NextResponse.json({ error: "This link is invalid or has already been used. Please contact the event organizer for a new link." }, { status: 400 });
    }

    if (tokenRecord.expires < new Date()) {
      await db.verificationToken.delete({ where: { token: hashedToken } });
      apiLogger.info({ msg: "Expired completion token accessed", identifier: tokenRecord.identifier, ip: getClientIp(req) });
      return NextResponse.json({ error: "This link has expired. Please contact the event organizer for a new link." }, { status: 400 });
    }

    // Extract registrationId from identifier
    if (!tokenRecord.identifier.startsWith("reg:")) {
      apiLogger.warn({ msg: "Token with wrong identifier prefix used on completion endpoint", identifier: tokenRecord.identifier });
      return NextResponse.json({ error: "This link is not a registration completion link." }, { status: 400 });
    }
    const registrationId = tokenRecord.identifier.slice(4);

    // Load registration + attendee + event
    const registration = await db.registration.findFirst({
      where: { id: registrationId, status: { notIn: ["CANCELLED"] } },
      select: {
        id: true,
        status: true,
        userId: true,
        ticketTypeId: true,
        ticketType: { select: { id: true, name: true } },
        attendee: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
            title: true,
            role: true,
            organization: true,
            jobTitle: true,
            phone: true,
            city: true,
            state: true,
            zipCode: true,
            country: true,
            specialty: true,
            dietaryReqs: true,
            associationName: true,
            memberId: true,
            studentId: true,
            studentIdExpiry: true,
          },
        },
        event: {
          select: {
            id: true,
            name: true,
            slug: true,
            startDate: true,
            endDate: true,
            venue: true,
            city: true,
            country: true,
            bannerImage: true,
            registrationTermsHtml: true,
            supportEmail: true,
            taxRate: true,
            taxLabel: true,
            bankDetails: true,
            organization: {
              select: {
                name: true,
                logo: true,
                companyName: true,
                companyAddress: true,
                companyCity: true,
                companyState: true,
                companyZipCode: true,
                companyCountry: true,
                taxId: true,
              },
            },
          },
        },
      },
    });

    if (!registration) {
      return NextResponse.json({ error: "Registration not found or has been cancelled" }, { status: 404 });
    }

    // Verify event slug matches URL for defense in depth
    if (registration.event.slug !== slug) {
      apiLogger.warn({ msg: "Completion token used on wrong event URL", tokenSlug: registration.event.slug, urlSlug: slug, registrationId });
      return NextResponse.json({ error: "This link does not match the event. Please use the original link from your email." }, { status: 400 });
    }

    // Check if already completed (user account linked)
    if (registration.userId) {
      apiLogger.info({ msg: "Already-completed registration accessed via token", registrationId, email: registration.attendee.email });
      return NextResponse.json({ alreadyCompleted: true, event: registration.event });
    }

    return NextResponse.json({
      alreadyCompleted: false,
      registration: { id: registration.id, status: registration.status, ticketTypeId: registration.ticketTypeId },
      attendee: registration.attendee,
      event: registration.event,
      ticketType: registration.ticketType,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Unhandled error validating completion token" });
    return NextResponse.json({ error: "An unexpected error occurred while loading your registration. Please try again." }, { status: 500 });
  }
}

// ── POST: Submit completed registration ─────────────────────────────────────

const completionSchema = z.object({
  token: z.string().min(1),
  title: titleEnum.optional(),
  jobTitle: z.string().max(255).optional(),
  organization: z.string().max(255).optional(),
  phone: z.string().max(50).optional(),
  city: z.string().max(255).optional(),
  state: z.string().max(255).optional(),
  zipCode: z.string().max(20).optional(),
  country: z.string().max(255).optional(),
  dietaryReqs: z.string().max(2000).optional(),
  associationName: z.string().max(255).optional(),
  memberId: z.string().max(100).optional(),
  studentId: z.string().max(100).optional(),
  studentIdExpiry: z.string().max(20).optional(),
  password: z.string().min(6).max(128).optional(),
  confirmPassword: z.string().optional(),
  agreeTerms: z.literal(true, { message: "You must agree to the terms and conditions" }),
}).refine((data) => !data.password || data.password === data.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { slug } = await params;

    const ipLimit = checkRateLimit({
      key: `complete-reg-post:ip:${getClientIp(req)}`,
      limit: 5,
      windowMs: 15 * 60 * 1000,
    });
    if (!ipLimit.allowed) {
      return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
    }

    const body = await req.json();
    const validated = completionSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ msg: "Completion form validation failed", errors: validated.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    const { token: rawToken, title, jobTitle, organization, phone, city, state, zipCode, country, dietaryReqs, associationName, memberId, studentId, studentIdExpiry, password } = validated.data;

    // Validate studentIdExpiry date format if provided
    if (studentIdExpiry && isNaN(new Date(studentIdExpiry).getTime())) {
      apiLogger.warn({ msg: "Invalid studentIdExpiry in completion form", studentIdExpiry });
      return NextResponse.json({ error: "Invalid student ID expiry date" }, { status: 400 });
    }

    // Validate token
    const hashedToken = hashVerificationToken(rawToken);
    const tokenRecord = await db.verificationToken.findUnique({
      where: { token: hashedToken },
    });

    if (!tokenRecord) {
      apiLogger.info({ msg: "Completion POST with invalid/used token", ip: getClientIp(req) });
      return NextResponse.json({ error: "This link is invalid or has already been used. Please contact the event organizer for a new link." }, { status: 400 });
    }

    if (tokenRecord.expires < new Date()) {
      await db.verificationToken.delete({ where: { token: hashedToken } });
      apiLogger.info({ msg: "Completion POST with expired token", identifier: tokenRecord.identifier, ip: getClientIp(req) });
      return NextResponse.json({ error: "This link has expired. Please contact the event organizer for a new link." }, { status: 400 });
    }

    if (!tokenRecord.identifier.startsWith("reg:")) {
      apiLogger.warn({ msg: "Wrong token type used on completion POST", identifier: tokenRecord.identifier });
      return NextResponse.json({ error: "This link is not a registration completion link." }, { status: 400 });
    }
    const registrationId = tokenRecord.identifier.slice(4);

    // Load registration with only needed fields
    const registration = await db.registration.findFirst({
      where: { id: registrationId, status: { notIn: ["CANCELLED"] } },
      select: {
        id: true,
        serialId: true,
        status: true,
        userId: true,
        attendeeId: true,
        billingCity: true,
        billingCountry: true,
        attendee: {
          select: {
            email: true, firstName: true, lastName: true, title: true,
            organization: true, jobTitle: true, phone: true, city: true, country: true,
            specialty: true, registrationType: true,
            associationName: true, memberId: true, studentId: true, studentIdExpiry: true,
          },
        },
        event: {
          select: {
            id: true, name: true, slug: true, startDate: true,
            venue: true, city: true, country: true, organizationId: true,
            taxRate: true, taxLabel: true,
            bankDetails: true, supportEmail: true,
            organization: {
              select: {
                name: true, logo: true,
                companyName: true, companyAddress: true, companyCity: true,
                companyState: true, companyZipCode: true, companyCountry: true,
                taxId: true,
              },
            },
          },
        },
        ticketType: { select: { id: true, name: true, price: true, currency: true } },
        pricingTier: { select: { id: true, name: true, price: true, currency: true } },
      },
    });

    if (!registration) {
      apiLogger.warn({ msg: "Completion POST for missing/cancelled registration", registrationId });
      return NextResponse.json({ error: "Registration not found or has been cancelled. Please contact the event organizer." }, { status: 404 });
    }

    if (registration.event.slug !== slug) {
      apiLogger.warn({ msg: "Completion POST token used on wrong event URL", tokenSlug: registration.event.slug, urlSlug: slug, registrationId });
      return NextResponse.json({ error: "This link does not match the event. Please use the original link from your email." }, { status: 400 });
    }

    if (registration.userId) {
      apiLogger.info({ msg: "Completion POST on already-completed registration", registrationId, email: registration.attendee.email });
      return NextResponse.json({ error: "This registration has already been completed. You can sign in to manage your registration." }, { status: 409 });
    }

    // Update attendee + delete token in transaction
    await db.$transaction(async (tx) => {
      await tx.attendee.update({
        where: { id: registration.attendeeId },
        data: {
          ...(title !== undefined && { title: title || null }),
          ...(jobTitle !== undefined && { jobTitle: jobTitle || null }),
          ...(organization !== undefined && { organization: organization || null }),
          ...(phone !== undefined && { phone: phone || null }),
          ...(city !== undefined && { city: city || null }),
          ...(state !== undefined && { state: state || null }),
          ...(zipCode !== undefined && { zipCode: zipCode || null }),
          ...(country !== undefined && { country: country || null }),
          ...(dietaryReqs !== undefined && { dietaryReqs: dietaryReqs || null }),
          ...(associationName !== undefined && { associationName: associationName || null }),
          ...(memberId !== undefined && { memberId: memberId || null }),
          ...(studentId !== undefined && { studentId: studentId || null }),
          ...(studentIdExpiry !== undefined && { studentIdExpiry: studentIdExpiry ? new Date(studentIdExpiry) : null }),
        },
      });

      // Delete token (one-time use)
      await tx.verificationToken.delete({ where: { token: hashedToken } });

      // Audit log
      await tx.auditLog.create({
        data: {
          eventId: registration.event.id,
          action: "COMPLETE_REGISTRATION",
          entityType: "Registration",
          entityId: registrationId,
          changes: { email: registration.attendee.email, ip: getClientIp(req) },
        },
      });
    });

    // Account creation (outside transaction — failure should not block completion)
    const email = registration.attendee.email;
    const firstName = registration.attendee.firstName;
    const lastName = registration.attendee.lastName;

    if (password) {
      try {
        const clientIp = getClientIp(req);
        const existingUser = await db.user.findUnique({ where: { email }, select: { id: true, role: true, termsAcceptedAt: true } });

        if (existingUser) {
          await db.registration.update({
            where: { id: registrationId },
            data: { userId: existingUser.id },
          });
          await db.registration.updateMany({
            where: { attendee: { email }, userId: null },
            data: { userId: existingUser.id },
          });
          if (!existingUser.termsAcceptedAt) {
            await db.user.update({
              where: { id: existingUser.id },
              data: { termsAcceptedAt: new Date(), termsAcceptedIp: clientIp },
            });
          }
        } else {
          const passwordHash = await bcrypt.hash(password, 10);
          const newUser = await db.user.create({
            data: {
              email,
              passwordHash,
              firstName,
              lastName,
              role: "REGISTRANT",
              organizationId: null,
              specialty: registration.attendee.specialty || null,
              termsAcceptedAt: new Date(),
              termsAcceptedIp: clientIp,
            },
          });
          await db.registration.updateMany({
            where: { attendee: { email }, userId: null },
            data: { userId: newUser.id },
          });
          notifyEventAdmins(registration.event.id, {
            type: "SIGNUP",
            title: "New Account Signup",
            message: `${firstName} ${lastName} (${email}) completed registration and created an account`,
            link: `/events/${registration.event.id}/registrations`,
          }).catch((notifyErr) => {
            apiLogger.warn({ msg: "Failed to notify admins of registration completion signup", registrationId, err: notifyErr instanceof Error ? notifyErr.message : String(notifyErr) });
          });
        }
      } catch (accountError) {
        apiLogger.error({ err: accountError, msg: "Failed to create/link user account during registration completion" });
      }
    }

    // Sync to contact store
    await syncToContact({
      organizationId: registration.event.organizationId,
      eventId: registration.event.id,
      email,
      firstName,
      lastName,
      title: title || registration.attendee.title,
      organization: organization || registration.attendee.organization,
      jobTitle: jobTitle || registration.attendee.jobTitle,
      phone: phone || registration.attendee.phone,
      city: city || registration.attendee.city,
      country: country || registration.attendee.country,
      specialty: registration.attendee.specialty,
      registrationType: registration.attendee.registrationType,
      associationName: associationName || registration.attendee.associationName,
      memberId: memberId || registration.attendee.memberId,
      studentId: studentId || registration.attendee.studentId,
      studentIdExpiry: studentIdExpiry ? new Date(studentIdExpiry) : registration.attendee.studentIdExpiry,
    });

    // Send confirmation email
    try {
      const finalPrice = registration.pricingTier ? Number(registration.pricingTier.price) : Number(registration.ticketType?.price ?? 0);
      const finalCurrency = registration.pricingTier ? registration.pricingTier.currency : registration.ticketType?.currency ?? "USD";

      const org = registration.event.organization;
      await sendRegistrationConfirmation({
        to: email,
        firstName,
        lastName,
        title: title || registration.attendee.title || null,
        organization: organization || registration.attendee.organization || null,
        eventName: registration.event.name,
        eventDate: registration.event.startDate,
        eventVenue: registration.event.venue || "",
        eventCity: registration.event.city || "",
        ticketType: registration.ticketType?.name ?? "General",
        pricingTierName: registration.pricingTier?.name || null,
        registrationId,
        serialId: registration.serialId,
        qrCode: "",
        eventId: registration.event.id,
        eventSlug: registration.event.slug,
        ticketPrice: finalPrice,
        ticketCurrency: finalCurrency,
        taxRate: registration.event.taxRate ? Number(registration.event.taxRate) : null,
        taxLabel: registration.event.taxLabel,
        bankDetails: registration.event.bankDetails,
        supportEmail: registration.event.supportEmail,
        organizationName: org.name,
        companyName: org.companyName,
        companyAddress: org.companyAddress,
        companyCity: org.companyCity,
        companyState: org.companyState,
        companyZipCode: org.companyZipCode,
        companyCountry: org.companyCountry,
        taxId: org.taxId,
        logoPath: org.logo,
        jobTitle: registration.attendee.jobTitle,
        billingCity: registration.billingCity || registration.attendee.city,
        billingCountry: registration.billingCountry || registration.attendee.country,
      });
    } catch (emailError) {
      apiLogger.error({ err: emailError, msg: "Failed to send confirmation email after registration completion" });
    }

    apiLogger.info({ msg: "Registration completed via token", registrationId, email });

    return NextResponse.json({
      success: true,
      registration: {
        id: registrationId,
        status: registration.status,
        ticketPrice: registration.pricingTier ? Number(registration.pricingTier.price) : Number(registration.ticketType?.price ?? 0),
        ticketCurrency: registration.pricingTier ? registration.pricingTier.currency : registration.ticketType?.currency ?? "USD",
      },
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Unhandled error in registration completion POST" });
    return NextResponse.json({ error: "An unexpected error occurred while completing your registration. Please try again or contact the event organizer." }, { status: 500 });
  }
}
