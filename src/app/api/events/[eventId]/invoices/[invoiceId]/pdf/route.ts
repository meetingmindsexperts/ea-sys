import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { generatePDFForInvoice } from "@/lib/invoice-service";

interface RouteParams {
  params: Promise<{ eventId: string; invoiceId: string }>;
}

/**
 * GET /api/events/[eventId]/invoices/[invoiceId]/pdf
 * Download invoice PDF.
 */
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, invoiceId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const invoice = await db.invoice.findFirst({
      where: { id: invoiceId, eventId, organizationId: session.user.organizationId! },
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
    apiLogger.error({ err: error, msg: "Error generating invoice PDF" });
    return NextResponse.json({ error: "Failed to generate PDF" }, { status: 500 });
  }
}
