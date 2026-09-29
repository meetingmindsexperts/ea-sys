import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { resolveRequestOrgId } from "@/lib/tenant/resolver";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { denyFinance } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { generatePDFForInvoice } from "@/lib/invoice-service";

interface RouteParams {
  params: Promise<{ registrationId: string; invoiceId: string }>;
}

/**
 * GET /api/registrant/registrations/[registrationId]/invoices/[invoiceId]/pdf
 * Download invoice PDF (registrant or org member).
 */
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [session, { registrationId, invoiceId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Tenancy lane (item 6 follow-on). A REGISTRANT is org-null on master by
    // design, and the rows below sit behind an RLS policy on the platform — so
    // the lane cannot come from the session and cannot be read out of the
    // database first. It comes from the host, exactly as sign-in does.
    const orgId = await resolveRequestOrgId(req);
    return await runWithTenantLane(orgId, { route: "registrant/registrations/[registrationId]/invoices/[invoiceId]/pdf", userId: session?.user?.id }, async () => {

    // Owner-scoped: the caller may read only their OWN registration (the where
    // below filters on userId). That is every REGISTRANT, and since Sep 29 2026
    // every org-less account too: a SUBMITTER owns a registration when they
    // are a speaker (the faculty companion) or paid a presenter rate, and was
    // being refused their own barcode, invoices and quote.
    const ownerScoped = session.user.role === "REGISTRANT" || !session.user.organizationId;
    if (!ownerScoped) {
      // Invoice PDF carries every financial figure on the registration —
      // MEMBER (org-bound read-only viewer) must not see it. REGISTRANT
      // branch stays exempt as the legitimate self-view path. Closed
      // Pass #1 (June 2026).
      const noFinance = denyFinance(session, { route: "registrant/registrations/[registrationId]/invoices/[invoiceId]/pdf:GET" });
      if (noFinance) {
        apiLogger.warn({
          msg: "registrant/invoice-pdf:denyFinance",
          registrationId,
          invoiceId,
          userId: session.user.id,
          role: session.user.role,
        });
        return noFinance;
      }
    }

    const registration = await db.registration.findFirst({
      where: {
        id: registrationId,
        ...(ownerScoped
          ? { userId: session.user.id }
          // Assignment-gated for finance-capable ONSITE/MEMBER (review H10).
          : { event: buildEventAccessWhere(session.user) }),
      },
      select: { id: true },
    });
    if (!registration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    const invoice = await db.invoice.findFirst({
      where: { id: invoiceId, registrationId },
      select: { id: true, invoiceNumber: true },
    });
    if (!invoice) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    const pdfBuffer = await generatePDFForInvoice(invoiceId);

    return new NextResponse(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${invoice.invoiceNumber}.pdf"`,
        "Cache-Control": "private, max-age=0",
      },
    });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error generating registrant invoice PDF" });
    return NextResponse.json({ error: "Failed to generate PDF" }, { status: 500 });
  }
}
