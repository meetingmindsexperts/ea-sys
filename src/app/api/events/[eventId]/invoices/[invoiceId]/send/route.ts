import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyReviewer } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { sendInvoiceEmail } from "@/lib/invoice-service";

interface RouteParams {
  params: Promise<{ eventId: string; invoiceId: string }>;
}

/**
 * POST /api/events/[eventId]/invoices/[invoiceId]/send
 * Send or resend invoice email with PDF attachment.
 */
export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, invoiceId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;

    const invoice = await db.invoice.findFirst({
      where: { id: invoiceId, eventId, organizationId: session.user.organizationId! },
      select: { id: true, invoiceNumber: true },
    });
    if (!invoice) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    await sendInvoiceEmail(invoiceId);

    return NextResponse.json({ success: true, message: `Email sent for ${invoice.invoiceNumber}` });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error sending invoice email" });
    return NextResponse.json({ error: "Failed to send email" }, { status: 500 });
  }
}
