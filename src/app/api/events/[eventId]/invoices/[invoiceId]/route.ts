import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyReviewer } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { cancelInvoice } from "@/lib/invoice-service";
import { z } from "zod";

interface RouteParams {
  params: Promise<{ eventId: string; invoiceId: string }>;
}

/**
 * GET /api/events/[eventId]/invoices/[invoiceId]
 */
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, invoiceId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const invoice = await db.invoice.findFirst({
      where: { id: invoiceId, eventId, organizationId: session.user.organizationId! },
      include: {
        registration: {
          select: {
            id: true,
            attendee: { select: { firstName: true, lastName: true, email: true } },
          },
        },
        parentInvoice: { select: { invoiceNumber: true } },
        creditNotes: { select: { id: true, invoiceNumber: true, total: true, createdAt: true } },
      },
    });

    if (!invoice) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    return NextResponse.json(invoice);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching invoice" });
    return NextResponse.json({ error: "Failed to fetch invoice" }, { status: 500 });
  }
}

const updateSchema = z.object({
  action: z.enum(["cancel", "mark_overdue"]),
});

/**
 * PUT /api/events/[eventId]/invoices/[invoiceId]
 * Update invoice status (cancel or mark overdue).
 */
export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, invoiceId }, body] = await Promise.all([auth(), params, req.json()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;

    const validated = updateSchema.safeParse(body);
    if (!validated.success) {
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    const invoice = await db.invoice.findFirst({
      where: { id: invoiceId, eventId, organizationId: session.user.organizationId! },
      select: { id: true, status: true },
    });
    if (!invoice) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    if (validated.data.action === "cancel") {
      const updated = await cancelInvoice(invoiceId);
      return NextResponse.json(updated);
    }

    if (validated.data.action === "mark_overdue") {
      const updated = await db.invoice.update({
        where: { id: invoiceId },
        data: { status: "OVERDUE" },
      });
      return NextResponse.json(updated);
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating invoice" });
    return NextResponse.json({ error: "Failed to update invoice" }, { status: 500 });
  }
}
