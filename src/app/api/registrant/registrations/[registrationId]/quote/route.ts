import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { generateQuotePDF } from "@/lib/quote-pdf";
import { formatQuoteNumber } from "@/lib/invoice-numbering";

interface RouteParams {
  params: Promise<{ registrationId: string }>;
}

/**
 * GET /api/registrant/registrations/[registrationId]/quote
 * Generates and returns a PDF quote for the registration.
 * Accessible by the registration owner (REGISTRANT) or admin/organizer.
 */
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { registrationId }] = await Promise.all([auth(), params]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Fetch registration with all needed data. Reviewers/submitters
    // (role != REGISTRANT but organizationId == null) are rejected
    // here — Prisma would otherwise throw a validation error on the
    // nested relation filter.
    const isRegistrant = session.user.role === "REGISTRANT";
    if (!isRegistrant && !session.user.organizationId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const registration = await db.registration.findFirst({
      where: {
        id: registrationId,
        // Allow owner or org members
        ...(isRegistrant
          ? { userId: session.user.id }
          : { event: { organizationId: session.user.organizationId! } }),
      },
      include: {
        attendee: true,
        ticketType: { select: { name: true, price: true, currency: true } },
        pricingTier: { select: { name: true, price: true, currency: true } },
        event: {
          select: {
            name: true,
            code: true,
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

    const price = registration.pricingTier
      ? Number(registration.pricingTier.price)
      : Number(registration.ticketType?.price ?? 0);

    const currency = registration.pricingTier
      ? registration.pricingTier.currency
      : registration.ticketType?.currency ?? "USD";

    const eventCode = registration.event.code || registration.event.name.slice(0, 6).toUpperCase();
    const quoteNumber = registration.serialId
      ? formatQuoteNumber(eventCode, registration.serialId)
      : `${eventCode}-Q-${registration.id.slice(-4).toUpperCase()}`;

    const org = registration.event.organization;

    const pdfBuffer = await generateQuotePDF({
      quoteNumber,
      date: registration.createdAt,
      eventName: registration.event.name,
      eventDate: registration.event.startDate,
      eventVenue: registration.event.venue,
      eventCity: registration.event.city,
      firstName: registration.attendee.firstName,
      lastName: registration.attendee.lastName,
      email: registration.attendee.email,
      organization: registration.attendee.organization,
      title: registration.attendee.title,
      jobTitle: registration.attendee.jobTitle,
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
      registrationType: registration.ticketType?.name ?? "General",
      pricingTier: registration.pricingTier?.name || null,
      price,
      currency,
      taxRate: registration.event.taxRate ? Number(registration.event.taxRate) : null,
      taxLabel: registration.event.taxLabel || "VAT",
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
    });

    return new NextResponse(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="quote-${registration.id.slice(-8)}.pdf"`,
        "Cache-Control": "private, max-age=0",
      },
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error generating quote PDF" });
    return NextResponse.json({ error: "Failed to generate quote" }, { status: 500 });
  }
}
