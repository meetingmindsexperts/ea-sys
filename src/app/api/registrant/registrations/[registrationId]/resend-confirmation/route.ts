import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { sendRegistrationConfirmation } from "@/lib/email";

/**
 * POST /api/registrant/registrations/[registrationId]/resend-confirmation
 *
 * Registrant-facing self-service endpoint to re-send the registration
 * confirmation email (with the quote PDF attached when the ticket is
 * priced). Lets users recover from a lost inbox without having to email
 * support. Rate-limited so the button can't be mashed into a spam source.
 *
 * Ownership: the authenticated user must either OWN the registration
 * (Registration.userId === me) or share the attendee email — same rule
 * the /api/registrant/registrations GET uses, so orphan rows still work.
 */
interface RouteParams {
  params: Promise<{ registrationId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { registrationId }] = await Promise.all([auth(), params]);
    if (!session?.user?.id || !session.user.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userEmail = session.user.email.toLowerCase();

    // 3 sends / registration / hour — enough for genuine recovery cases
    // (a lost email + one retry) without letting the button be weaponised.
    const rl = checkRateLimit({
      key: `resend-confirmation:${registrationId}`,
      limit: 3,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `Please wait ${Math.ceil(rl.retryAfterSeconds / 60)} minute(s) before requesting another copy.` },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const registration = await db.registration.findFirst({
      where: {
        id: registrationId,
        OR: [
          { userId: session.user.id },
          { attendee: { email: userEmail } },
        ],
      },
      include: {
        attendee: true,
        ticketType: { select: { name: true, price: true, currency: true } },
        pricingTier: { select: { name: true, price: true, currency: true } },
        event: {
          select: {
            id: true,
            name: true,
            slug: true,
            startDate: true,
            venue: true,
            city: true,
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
        },
      },
    });

    if (!registration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    const finalPrice = registration.pricingTier
      ? Number(registration.pricingTier.price)
      : Number(registration.ticketType?.price ?? 0);
    const finalCurrency = registration.pricingTier
      ? registration.pricingTier.currency
      : registration.ticketType?.currency ?? "USD";

    const org = registration.event.organization;
    const result = await sendRegistrationConfirmation({
      to: registration.attendee.email,
      additionalEmail: registration.attendee.additionalEmail,
      firstName: registration.attendee.firstName,
      lastName: registration.attendee.lastName,
      title: registration.attendee.title,
      organization: registration.attendee.organization,
      jobTitle: registration.attendee.jobTitle,
      eventName: registration.event.name,
      eventDate: registration.event.startDate,
      eventVenue: registration.event.venue || "",
      eventCity: registration.event.city || "",
      ticketType: registration.ticketType?.name ?? "General",
      pricingTierName: registration.pricingTier?.name ?? null,
      registrationId: registration.id,
      serialId: registration.serialId,
      qrCode: registration.qrCode ?? "",
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
      billingFirstName: registration.billingFirstName,
      billingLastName: registration.billingLastName,
      billingEmail: registration.billingEmail,
      billingPhone: registration.billingPhone,
      billingAddress: registration.billingAddress,
      billingCity: registration.billingCity || registration.attendee.city,
      billingState: registration.billingState,
      billingZipCode: registration.billingZipCode,
      billingCountry: registration.billingCountry || registration.attendee.country,
      taxNumber: registration.taxNumber,
    });

    apiLogger.info({
      msg: "registrant:resend-confirmation",
      registrationId,
      userId: session.user.id,
      to: registration.attendee.email,
      success: result.success,
      ip: getClientIp(req),
    });

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || "Failed to send email. Please try again later." },
        { status: 502 },
      );
    }

    return NextResponse.json({
      success: true,
      message: `Confirmation email sent to ${registration.attendee.email}.`,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "registrant:resend-confirmation failed" });
    return NextResponse.json({ error: "Failed to send email" }, { status: 500 });
  }
}
