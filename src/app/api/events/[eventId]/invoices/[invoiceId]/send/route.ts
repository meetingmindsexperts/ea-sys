import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { sendInvoiceEmail, sendGroupInvoiceEmail } from "@/lib/invoice-service";
import { runWithTenantLane } from "@/lib/tenant-lane";

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
      apiLogger.warn({ msg: "invoices:send:unauthenticated" });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session, { route: "events/[eventId]/invoices/[invoiceId]/send:POST" });
    if (denied) return denied;

    return await runWithTenantLane(session.user.organizationId, { route: "invoices:send", userId: session.user.id }, async () => {
    const invoice = await db.invoice.findFirst({
      where: {
        id: invoiceId,
        eventId,
        organizationId: (session.user.organizationId ?? ""),
        // Assignment-gated for finance-capable ONSITE/MEMBER (review H10).
        event: buildEventAccessWhere(session.user),
      },
      select: { id: true, invoiceNumber: true, groupId: true },
    });
    if (!invoice) {
      apiLogger.warn({ msg: "invoices:send:not-found-or-access-denied", eventId, userId: session.user.id, role: session.user.role });
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    // Group invoices go to the payer + coordinator via the group sender —
    // sendInvoiceEmail is per-registration and refuses them (group review M1:
    // the Resend button used to 500 with no recovery path).
    if (invoice.groupId) {
      await sendGroupInvoiceEmail(invoiceId);
    } else {
      await sendInvoiceEmail(invoiceId);
    }

    return NextResponse.json({ success: true, message: `Email sent for ${invoice.invoiceNumber}` });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error sending invoice email" });
    return NextResponse.json({ error: "Failed to send email" }, { status: 500 });
  }
}
