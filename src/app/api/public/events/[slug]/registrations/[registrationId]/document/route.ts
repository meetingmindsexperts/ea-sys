import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { publicEventWhere } from "@/lib/public-event";
import { buildQuotePDFFromRegistration } from "@/lib/quote-pdf";
import { generatePDFForInvoice } from "@/lib/invoice-service";
import { runWithTenant } from "@/lib/tenant-context";
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
      apiLogger.warn({ msg: "public/document:rate-limited", retryAfterSeconds: limit.retryAfterSeconds });
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
      );
    }

    const registration = await db.registration.findFirst({
      where: {
        id: registrationId,
        event: await publicEventWhere(req, slug),
      },
      include: {
        attendee: true,
        ticketType: { select: { name: true, price: true, currency: true } },
        pricingTier: { select: { name: true, price: true, currency: true } },
        promoCode: { select: { code: true } },
        billingAccount: {
          select: {
            name: true, contactName: true, email: true, phone: true,
            address: true, city: true, state: true, zipCode: true,
            country: true, taxNumber: true,
          },
        },
        event: {
          select: {
            name: true,
            code: true,
            organizationId: true,
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

    // Prefer the post-payment Invoice when one exists. Review L1: the old
    // `orderBy: { status: "asc" }` sorted by Postgres enum DEFINITION order
    // (DRAFT, SENT, PAID, …) — the exact OPPOSITE of the intent, handing the
    // payer an unpaid-looking SENT document when a PAID one existed. Pick in
    // JS instead: PAID first (newest), else the newest non-CANCELLED row —
    // a CANCELLED-only invoice falls through to the quote below.
    // The Invoice reads + PDF ride the tenant lane on the platform (inert on
    // master); org resolved from the slug-scoped registration lookup above.
    const invoiceDoc = await runWithTenant(registration.event.organizationId, async () => {
      const invoiceRows = await db.invoice.findMany({
        where: {
          registrationId,
          type: "INVOICE",
          status: { not: "CANCELLED" },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, invoiceNumber: true, status: true },
        take: 10,
      });
      const invoice = invoiceRows.find((r) => r.status === "PAID") ?? invoiceRows[0] ?? null;
      if (!invoice) return null;
      const pdfBuffer = await generatePDFForInvoice(invoice.id);
      return { pdfBuffer, invoiceNumber: invoice.invoiceNumber };
    });

    if (invoiceDoc) {
      return new NextResponse(new Uint8Array(invoiceDoc.pdfBuffer), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="invoice-${invoiceDoc.invoiceNumber}.pdf"`,
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
