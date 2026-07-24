import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { denyReviewer, denyFinance } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { createInvoice } from "@/lib/invoice-service";
import { z } from "zod";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

/**
 * GET /api/events/[eventId]/invoices
 * List invoices for an event. Supports ?type=INVOICE&status=PAID&search=
 */
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;

    const noFinance = denyFinance(session);
    if (noFinance) return noFinance;

    // Assignment-gated, not just org-gated: ONSITE (and MEMBER) are
    // finance-capable, so an ONSITE temp assigned to Event A must 404 on
    // Event B's invoices — same rule as the desk routes (review H10).
    const event = await db.event.findFirst({
      where: { id: eventId, ...buildEventAccessWhere(session.user) },
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "invoices:list:event-access-denied", eventId, userId: session.user.id, role: session.user.role });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const url = new URL(req.url);
    const type = url.searchParams.get("type") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const search = url.searchParams.get("search") || undefined;

    const invoices = await db.invoice.findMany({
      where: {
        eventId,
        ...(type && { type: type as "INVOICE" | "RECEIPT" | "CREDIT_NOTE" }),
        ...(status && { status: status as "DRAFT" | "SENT" | "PAID" | "OVERDUE" | "CANCELLED" | "REFUNDED" }),
        ...(search && {
          OR: [
            { invoiceNumber: { contains: search, mode: "insensitive" as const } },
            { registration: { attendee: { email: { contains: search, mode: "insensitive" as const } } } },
            { registration: { attendee: { firstName: { contains: search, mode: "insensitive" as const } } } },
            { registration: { attendee: { lastName: { contains: search, mode: "insensitive" as const } } } },
          ],
        }),
      },
      include: {
        registration: {
          select: {
            id: true,
            attendee: { select: { firstName: true, lastName: true, email: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(invoices);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error listing invoices" });
    return NextResponse.json({ error: "Failed to list invoices" }, { status: 500 });
  }
}

const createInvoiceSchema = z.object({
  registrationId: z.string().min(1),
  dueDate: z.string().datetime().optional(),
});

/**
 * POST /api/events/[eventId]/invoices
 * Manually create an invoice for a registration.
 */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([auth(), params, req.json()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;
    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: { id: eventId, ...buildEventAccessWhere(session.user) },
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "invoices:create:event-access-denied", eventId, userId: session.user.id, role: session.user.role });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const validated = createInvoiceSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ msg: "events/invoices:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    // The body's registrationId must belong to THIS event (review H9) —
    // createInvoice also binds it defensively, but checking here gives a
    // truthful 404 instead of a generic 500.
    const registration = await db.registration.findFirst({
      where: { id: validated.data.registrationId, eventId },
      select: { id: true },
    });
    if (!registration) {
      apiLogger.warn({
        msg: "invoices:create:registration-not-in-event",
        eventId,
        registrationId: validated.data.registrationId,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Registration not found for this event" }, { status: 404 });
    }

    const invoice = await createInvoice({
      registrationId: validated.data.registrationId,
      eventId,
      organizationId: orgGuard.orgId,
      dueDate: validated.data.dueDate ? new Date(validated.data.dueDate) : undefined,
    });

    return NextResponse.json(invoice, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating invoice" });
    return NextResponse.json({ error: "Failed to create invoice" }, { status: 500 });
  }
}
