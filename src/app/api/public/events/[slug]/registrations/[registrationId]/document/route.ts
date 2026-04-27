import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildQuotePDFFromRegistration } from "@/lib/quote-pdf";
import { generatePDFForInvoice } from "@/lib/invoice-service";
import { getClientIp, checkRateLimit } from "@/lib/security";

interface RouteParams {
  params: Promise<{ slug: string; registrationId: string }>;
}

/**
 * GET /api/public/events/[slug]/registrations/[registrationId]/document
 *
 * Public (no-auth) PDF handoff for the post-checkout confirmation page
 * at /e/[slug]/confirmation. Browsers hitting the previous auth-required
 * routes as anonymous users were getting a 401 JSON response saved as
 * `quote.json` — that's the bug this replaces.
 *
 * Returns the latest finalized document for the registration:
 *   - PAID Invoice (post-payment) if one exists, else
 *   - Quote PDF (pre-payment proforma).
 *
 * Security posture:
 *   - Registration CUIDs are unguessable random ids; this route is the
 *     same security class as the confirmation page itself (also public
 *     by-ID) and follows the same "slug + id must match" rule so an
 *     attacker can't cross-fetch another event's registration by
 *     knowing only the id.
 *   - 30 requests/hour/IP rate limit — enough for a legit user to
 *     retry a few times but not enough for enumeration.
 *   - Credit notes are NOT returned here (refund flows are handled
 *     from the authenticated portal).
 */
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug, registrationId } = await params;

    const limit = checkRateLimit({
      key: `public-document:${getClientIp(req)}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
      );
    }

    const registration = await db.registration.findFirst({
      where: {
        id: registrationId,
        event: { slug },
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

    // Prefer the post-payment Invoice when one exists. Ordered so a
    // PAID row wins over a pending SENT row; CREDIT_NOTE rows are
    // excluded because they represent refunds, not the primary doc.
    const invoice = await db.invoice.findFirst({
      where: {
        registrationId,
        type: "INVOICE",
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      select: { id: true, invoiceNumber: true, status: true },
    });

    if (invoice) {
      const pdfBuffer = await generatePDFForInvoice(invoice.id);
      return new NextResponse(new Uint8Array(pdfBuffer), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="invoice-${invoice.invoiceNumber}.pdf"`,
          "Cache-Control": "private, max-age=0",
        },
      });
    }

    // Fallback: Quote PDF (pre-payment or when no Invoice row exists yet).
    // The mapping registration → generateQuotePDF lives in `quote-pdf.ts`
    // — single source of truth shared with the auth-required quote route.
    const { buffer, filename } = await buildQuotePDFFromRegistration(registration);

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, max-age=0",
      },
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "public document download failed" });
    return NextResponse.json({ error: "Failed to generate document" }, { status: 500 });
  }
}
