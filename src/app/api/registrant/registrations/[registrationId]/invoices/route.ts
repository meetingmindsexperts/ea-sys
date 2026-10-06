import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/permissions/require-permission";
import { auth } from "@/lib/auth";
import { resolveRequestOrgId } from "@/lib/tenant/resolver";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { buildEventAccessWhere } from "@/lib/event-access";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ registrationId: string }>;
}

/**
 * GET /api/registrant/registrations/[registrationId]/invoices
 * List invoices for a registration (registrant or org member).
 */
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [session, { registrationId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Tenancy lane (item 6 follow-on). A REGISTRANT is org-null on master by
    // design, and the rows below sit behind an RLS policy on the platform — so
    // the lane cannot come from the session and cannot be read out of the
    // database first. It comes from the host, exactly as sign-in does.
    const orgId = await resolveRequestOrgId(req);
    return await runWithTenantLane(orgId, { route: "registrant/registrations/[registrationId]/invoices", userId: session?.user?.id }, async () => {

    // Owner-scoped: the caller may read only their OWN registration (the where
    // below filters on userId). That is every REGISTRANT, and since Sep 29 2026
    // every org-less account too: a SUBMITTER owns a registration when they
    // are a speaker (the faculty companion) or paid a presenter rate, and was
    // being refused their own barcode, invoices and quote.
    const ownerScoped = session.user.role === "REGISTRANT" || !session.user.organizationId;
    if (!ownerScoped) {
      // Invoice list carries amounts/totals — gate MEMBER. REGISTRANT
      // branch is owner-scoped and stays exempt. See sibling /quote
      // route for the same reasoning. Closed Pass #1 (June 2026).
      const financeGate = requirePermission(session, "finance.view", { route: "registrant/registrations/[registrationId]/invoices:GET" });
      const noFinance = financeGate.ok ? null : financeGate.response;
      if (noFinance) {
        apiLogger.warn({
          msg: "registrant/invoices:denyFinance",
          registrationId,
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
      // An owner-scoped caller asking for a row it does not own lands here too.
      apiLogger.warn({
        msg: "registrant/invoices:not-found-or-no-access",
        registrationId,
        userId: session.user.id,
        role: session.user.role,
        ownerScoped,
      });
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    const invoices = await db.invoice.findMany({
      where: { registrationId },
      select: {
        id: true,
        type: true,
        invoiceNumber: true,
        status: true,
        issueDate: true,
        total: true,
        currency: true,
        sentAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(invoices);
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error listing registration invoices" });
    return NextResponse.json({ error: "Failed to list invoices" }, { status: 500 });
  }
}
