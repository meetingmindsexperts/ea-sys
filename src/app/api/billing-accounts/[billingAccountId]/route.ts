import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, denyFinance } from "@/lib/auth-guards";
import { getClientIp } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { updateBillingAccount } from "@/services/billing-account-service";
import { buildPayerEventBreakdown } from "@/lib/payer-breakdown";

interface RouteParams {
  params: Promise<{ billingAccountId: string }>;
}

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  type: z.enum(["INSTITUTION", "COMPANY", "OTHER"]).optional(),
  email: z.string().email().max(255).optional().nullable().or(z.literal("")),
  phone: z.string().max(50).optional().nullable(),
  contactName: z.string().max(150).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  city: z.string().max(255).optional().nullable(),
  state: z.string().max(255).optional().nullable(),
  zipCode: z.string().max(20).optional().nullable(),
  country: z.string().max(255).optional().nullable(),
  taxNumber: z.string().max(100).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  isActive: z.boolean().optional(),
  needsReview: z.boolean().optional(),
});

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ billingAccountId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const noFinance = denyFinance(session, { route: "billing-accounts/[billingAccountId]:GET" });
    if (noFinance) return noFinance;

    const orgId = session.user.organizationId!; // capture before the closure
    // Tenancy: populate the ALS tenant store (passthrough on master).
    return await runWithTenant(orgId, async () => {
    // Org-scoped — never trust the id alone (IDOR).
    const account = await db.billingAccount.findFirst({
      where: { id: billingAccountId, organizationId: session.user.organizationId! },
    });
    if (!account) {
      return NextResponse.json({ error: "Billing account not found" }, { status: 404 });
    }

    // Parallel: "registrations by payer" (AR view), the payer's invoices and
    // payments (which drive the per-event money rollup below), and the events
    // this payer is attached to via the EventBillingAccount junction (powers
    // the Settings → Billing "Events" attach/detach dialog).
    //
    // NOTE on the invoice + payment joins: neither links to the payer
    // directly. An invoice bills EITHER one registration OR one group, so
    // both shapes must be covered — a naive `where: { billingAccountId }`
    // compiles to nothing and would silently drop every consolidated group
    // invoice from a company's view.
    const payerScope = {
      OR: [
        { registration: { billingAccountId } },
        { group: { billingAccountId } },
      ],
      organizationId: orgId,
    };

    const [registrations, invoices, payments, attachedEvents] = await Promise.all([
      db.registration.findMany({
        where: { billingAccountId, event: { organizationId: session.user.organizationId! } },
        select: {
          id: true,
          serialId: true,
          status: true,
          paymentStatus: true,
          payerReference: true,
          attendeeIsGuarantor: true,
          originalPrice: true,
          createdAt: true,
          groupId: true,
          attendee: { select: { firstName: true, lastName: true, email: true } },
          event: { select: { id: true, name: true } },
          ticketType: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
      db.invoice.findMany({
        where: payerScope,
        select: {
          id: true,
          invoiceNumber: true,
          type: true,
          status: true,
          total: true,
          currency: true,
          issueDate: true,
          dueDate: true,
          paidDate: true,
          eventId: true,
          groupId: true,
          registrationId: true,
        },
        orderBy: { issueDate: "desc" },
      }),
      db.payment.findMany({
        where: { ...payerScope, status: "PAID" },
        select: {
          id: true,
          amount: true,
          refundedAmount: true,
          currency: true,
          paidAt: true,
          createdAt: true,
          groupId: true,
          registration: { select: { eventId: true } },
          group: { select: { eventId: true } },
        },
      }),
      db.eventBillingAccount.findMany({
        where: {
          billingAccountId,
          event: { organizationId: session.user.organizationId! },
        },
        select: {
          eventId: true,
          addedAt: true,
          event: { select: { id: true, name: true, startDate: true, status: true } },
        },
        orderBy: { addedAt: "desc" },
      }),
    ]);

    const events = buildPayerEventBreakdown({
      registrations,
      invoices,
      payments,
      attachedEvents,
    });

    return NextResponse.json({
      ...account,
      registrations,
      registrationCount: registrations.length,
      attachedEvents,
      invoices,
      /** Per-event rollup: who, what was invoiced, what was paid. */
      events,
    });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching billing account" });
    return NextResponse.json({ error: "Failed to fetch billing account" }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const [{ billingAccountId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session, { route: "billing-accounts/[billingAccountId]:PATCH" });
    if (denied) return denied;
    const noFinance = denyFinance(session, { route: "billing-accounts/[billingAccountId]:PATCH" });
    if (noFinance) return noFinance;

    const orgId = session.user.organizationId!; // capture before the closure
    return await runWithTenant(orgId, async () => {
    const body = await req.json().catch(() => null);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({
        msg: "billing-account-update:zod-validation-failed",
        billingAccountId,
        errors: parsed.error.flatten(),
      });
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const result = await updateBillingAccount({
      ...parsed.data,
      email: parsed.data.email === "" ? null : parsed.data.email,
      billingAccountId,
      organizationId: session.user.organizationId!,
      userId: session.user.id,
      source: "rest",
      requestIp: getClientIp(req),
    });

    if (!result.ok) {
      const status =
        result.code === "NOT_FOUND"
          ? 404
          : result.code === "DUPLICATE_NAME"
          ? 409
          : result.code === "NAME_REQUIRED"
          ? 400
          : 500;
      return NextResponse.json(
        { error: result.message, code: result.code, ...(result.meta ?? {}) },
        { status },
      );
    }

    return NextResponse.json(result.billingAccount);
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating billing account" });
    return NextResponse.json({ error: "Failed to update billing account" }, { status: 500 });
  }
}
