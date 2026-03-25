import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { generateQuotePDF } from "@/lib/quote-pdf";

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

    // Fetch registration with all needed data
    const registration = await db.registration.findFirst({
      where: {
        id: registrationId,
        // Allow owner or org members
        ...(session.user.role === "REGISTRANT"
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
            startDate: true,
            venue: true,
            city: true,
            taxRate: true,
            taxLabel: true,
            bankDetails: true,
            supportEmail: true,
            organization: { select: { name: true } },
          },
        },
      },
    });

    if (!registration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    const price = registration.pricingTier
      ? Number(registration.pricingTier.price)
      : Number(registration.ticketType.price);

    const currency = registration.pricingTier
      ? registration.pricingTier.currency
      : registration.ticketType.currency;

    const pdfBuffer = await generateQuotePDF({
      quoteNumber: registration.id.toUpperCase().slice(-8),
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
      registrationType: registration.ticketType.name,
      pricingTier: registration.pricingTier?.name || null,
      price,
      currency,
      taxRate: registration.event.taxRate ? Number(registration.event.taxRate) : null,
      taxLabel: registration.event.taxLabel || "VAT",
      bankDetails: registration.event.bankDetails,
      supportEmail: registration.event.supportEmail,
      organizationName: registration.event.organization.name,
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
