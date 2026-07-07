import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { denyFinance } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { invoiceDateFilter } from "@/lib/invoice-export";

/**
 * GET /api/invoices
 *
 * Organization-wide invoice hub — every Invoice-model document (invoices,
 * receipts, credit notes) across ALL of the org's events, filterable by
 * year / month / event / type / status. Powers the org-level Invoices page
 * in the sidebar. Finance-gated (invoices are financial → MEMBER/ONSITE and
 * restricted roles are barred by denyFinance), org-scoped via
 * `organizationId` so it never crosses tenants.
 *
 * Query params (all optional): year, month (1-12), eventId, type, status, search.
 * Returns `{ invoices, earliestYear }` — earliestYear seeds the page's Year filter.
 */
export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // Invoices are financial — MEMBER (read-only viewer), ONSITE, and the
    // restricted roles are barred (same gate as the per-event invoice routes).
    const noFinance = denyFinance(session);
    if (noFinance) return noFinance;

    const organizationId = session.user.organizationId;
    if (!organizationId) {
      // Org-independent accounts (reviewer/submitter/registrant) have no org
      // invoices; denyFinance already blocks them, but fail closed regardless.
      return NextResponse.json({ error: "No organization" }, { status: 403 });
    }

    const url = new URL(req.url);
    const yearRaw = url.searchParams.get("year");
    const monthRaw = url.searchParams.get("month");
    const eventId = url.searchParams.get("eventId") || undefined;
    const type = url.searchParams.get("type") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const search = url.searchParams.get("search")?.trim() || undefined;

    const year = yearRaw ? Number(yearRaw) : undefined;
    const month = monthRaw ? Number(monthRaw) : undefined;
    const currentYear = new Date().getUTCFullYear();

    // Earliest invoice year (unfiltered, org-wide) seeds the Year dropdown AND
    // bounds the "month across all years" filter — computed first so the where
    // can be built from it. Cheap indexed aggregate.
    const earliest = await db.invoice.aggregate({
      where: { organizationId },
      _min: { issueDate: true },
    });
    const earliestYear = earliest._min.issueDate ? earliest._min.issueDate.getUTCFullYear() : currentYear;

    // year+month → that month; year only → that year; month only → that month
    // across every year (so picking "January" with no year works). Spread into
    // `AND` so it coexists with the search `OR` at the same level.
    const dateAnd = invoiceDateFilter(year, month, earliestYear, currentYear);

    const where: Prisma.InvoiceWhereInput = {
      organizationId,
      ...(eventId && { eventId }),
      ...(type && { type: type as Prisma.EnumInvoiceTypeFilter["equals"] }),
      ...(status && { status: status as Prisma.EnumInvoiceStatusFilter["equals"] }),
      ...(search && {
        OR: [
          { invoiceNumber: { contains: search, mode: "insensitive" } },
          { registration: { attendee: { email: { contains: search, mode: "insensitive" } } } },
          { registration: { attendee: { firstName: { contains: search, mode: "insensitive" } } } },
          { registration: { attendee: { lastName: { contains: search, mode: "insensitive" } } } },
        ],
      }),
      ...(dateAnd.length > 0 && { AND: dateAnd }),
    };

    const invoices = await db.invoice.findMany({
      where,
      select: {
        id: true,
        eventId: true,
        invoiceNumber: true,
        type: true,
        status: true,
        issueDate: true,
        dueDate: true,
        paidDate: true,
        total: true,
        currency: true,
        event: { select: { id: true, name: true } },
        registration: {
          select: {
            attendee: { select: { firstName: true, lastName: true, email: true } },
          },
        },
      },
      orderBy: { issueDate: "desc" },
      take: 1000,
    });

    return NextResponse.json({
      invoices: invoices.map((inv) => ({
        id: inv.id,
        eventId: inv.eventId,
        eventName: inv.event.name,
        invoiceNumber: inv.invoiceNumber,
        type: inv.type,
        status: inv.status,
        issueDate: inv.issueDate,
        dueDate: inv.dueDate,
        paidDate: inv.paidDate,
        total: Number(inv.total),
        currency: inv.currency,
        billToName: `${inv.registration.attendee.firstName} ${inv.registration.attendee.lastName}`.trim(),
        billToEmail: inv.registration.attendee.email,
      })),
      earliestYear,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error listing organization invoices" });
    return NextResponse.json({ error: "Failed to list invoices" }, { status: 500 });
  }
}
