import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { requirePermission } from "@/lib/permissions/require-permission";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { invoiceDateFilter, parseInvoiceEnumFilters } from "@/lib/invoice-export";
import { runWithTenant } from "@/lib/tenant-context";

/**
 * GET /api/invoices
 *
 * Organization-wide invoice hub — every Invoice-model document (invoices,
 * receipts, credit notes) across ALL of the org's events, filterable by
 * year / month / event / type / status. Powers the org-level Invoices page
 * in the sidebar. Gated on `invoices.ledger` (SUPER_ADMIN, ADMIN, ORGANIZER,
 * MEMBER). Org-scoped via `organizationId` so it never crosses tenants.
 *
 * WEBINARS and ONSITE are finance-capable for their DESK duties (payment
 * amounts on their own events), but this is an ORG-WIDE ledger covering every
 * event, so neither holds the key (WEBINARS: review H-1; ONSITE: Oct 5, 2026,
 * custom roles Phase 2, after the route matrix showed it reading the book).
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
    // The organisation's whole invoice book: `invoices.ledger`. Finance-capable
    // is not ledger access: WEBINARS (review H-1) and ONSITE (temp desk staff,
    // which read it until Oct 5, 2026) see amounts on their own events only.
    const gate = requirePermission(session, "invoices.ledger", { route: "invoices:GET" });
    if (!gate.ok) return gate.response;

    const organizationId = session.user.organizationId;
    if (!organizationId) {
      // Org-independent accounts (reviewer/submitter/registrant) have no org
      // invoices; the ledger key already refuses them, but fail closed regardless.
      return NextResponse.json({ error: "No organization" }, { status: 403 });
    }

    return await runWithTenant(organizationId, async () => {
    const url = new URL(req.url);
    const yearRaw = url.searchParams.get("year");
    const monthRaw = url.searchParams.get("month");
    const eventId = url.searchParams.get("eventId") || undefined;
    const search = url.searchParams.get("search")?.trim() || undefined;

    // `as Prisma.Enum...Filter["equals"]` used to sit on type/status straight
    // from the URL. A cast converts nothing; it only switches off the one
    // check that would have caught a bad value, so `?status=banana` compiled,
    // reached Postgres as an invalid enum and threw. ONE parser now serves
    // this route, its export, and the two per-event siblings (they share the
    // page's query string), so a bad value is the same logged 400 on all four
    // instead of a 400 here and a 500 next door. See parseInvoiceEnumFilters.
    const enumFilters = parseInvoiceEnumFilters(url.searchParams);
    if (!enumFilters.ok) {
      apiLogger.warn({
        msg: "org-invoices:invalid-filter",
        filter: enumFilters.filter,
        userId: session.user.id,
        organizationId,
      });
      return NextResponse.json(
        { error: `Unknown invoice ${enumFilters.filter}`, code: "INVALID_FILTER", valid: enumFilters.valid },
        { status: 400 },
      );
    }
    const { type, status } = enumFilters;

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
      // Already narrowed to the Prisma enum by parseInvoiceEnumFilters; no cast.
      ...(type && { type }),
      ...(status && { status }),
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
        // Group-registration (Aug 2026): consolidated group invoices have no
        // registration — bill-to is the group's payer (BillingAccount).
        group: {
          select: {
            coordinatorEmail: true,
            billingAccount: { select: { name: true, email: true } },
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
        billToName: inv.registration
          ? `${inv.registration.attendee.firstName} ${inv.registration.attendee.lastName}`.trim()
          : (inv.group?.billingAccount.name ?? "—"),
        billToEmail: inv.registration?.attendee.email ?? inv.group?.billingAccount.email ?? inv.group?.coordinatorEmail ?? "",
      })),
      earliestYear,
    });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error listing organization invoices" });
    return NextResponse.json({ error: "Failed to list invoices" }, { status: 500 });
  }
}
