import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
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
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { registrationId, invoiceId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify ownership
    const registration = await db.registration.findFirst({
      where: {
        id: registrationId,
        ...(session.user.role === "REGISTRANT"
          ? { userId: session.user.id }
          : { event: { organizationId: session.user.organizationId! } }),
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
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error generating registrant invoice PDF" });
    return NextResponse.json({ error: "Failed to generate PDF" }, { status: 500 });
  }
}
