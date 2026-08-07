import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { recordExport } from "@/lib/audit-data-transfer";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { toCsv } from "@/lib/csv-escape";
import { requireCrmExport } from "@/crm/lib/crm-route";
import { canViewDealValues } from "@/crm/lib/crm-roles";
import { buildDealWhere } from "@/crm/lib/deal-filters";

/**
 * GET /api/crm/deals/export — CSV of the (filtered) deal list.
 *
 * Honours the board's filters via buildDealWhere. FINANCE-GATED: the Value/Currency
 * columns are omitted entirely for a caller who may not see money — not blanked,
 * OMITTED, so a MEMBER's export has no value column at all (a blank column would
 * still confirm which deals have high vs low values by omission patterns; dropping
 * it removes the channel). CSV cells escaped via the shared escapeCsvCell (formula
 * injection safe).
 *
 * ADMIN AND ABOVE ONLY (owner decision, August 7 2026): an export is a whole-
 * pipeline read, the highest-value single object in the domain, so the gate is
 * narrower than both CRM read and CRM write — a MEMBER, an ORGANIZER and a
 * CRM_USER all work the board but none of them can dump it. See CRM_EXPORT_ROLES.
 * The finance gating below is now belt-and-braces for the API-key path (a session
 * that reaches here is an admin, who may see money) and is kept deliberately.
 *
 * Rate-limited on top of the gate.
 */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmExport(req);
  if (error) return error;
  // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
  return await runWithTenant(ctx.organizationId, async () => {

  const canSeeValues = canViewDealValues(ctx.role, ctx.fromApiKey);

  const limit = checkRateLimit({
    key: `crm-deals-export:org:${ctx.organizationId}`,
    limit: 30,
    windowMs: 60 * 60 * 1000,
  });
  if (!limit.allowed) {
    apiLogger.warn({ msg: "crm/deals/export:rate-limited", organizationId: ctx.organizationId });
    return NextResponse.json(
      { error: "Too many exports — try again shortly", retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  try {
    const { searchParams } = new URL(req.url);
    const where = buildDealWhere(
      {
        eventId: searchParams.get("eventId"),
        ownerId: searchParams.get("ownerId"),
        status: searchParams.get("status"),
        pipeline: searchParams.get("pipeline"),
        dealTypeId: searchParams.get("dealTypeId"),
        dateField: searchParams.get("dateField"),
        from: searchParams.get("from"),
        to: searchParams.get("to"),
        min: searchParams.get("min"),
        max: searchParams.get("max"),
      },
      { organizationId: ctx.organizationId, canSeeValues },
    );

    const deals = await db.crmDeal.findMany({
      where,
      select: {
        name: true,
        dealValue: true,
        currency: true,
        status: true,
        pipeline: true,
        dealType: { select: { name: true } },
        tags: true,
        expectedClose: true,
        wonAt: true,
        lostAt: true,
        lostReason: true,
        createdAt: true,
        stage: { select: { name: true } },
        company: { select: { name: true } },
        // Project date + location are derived from the event (city/country only).
        event: { select: { name: true, startDate: true, endDate: true, city: true, country: true } },
        owner: { select: { firstName: true, lastName: true } },
        _count: { select: { contacts: true, tasks: true, notes: true } },
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 5000,
    });

    const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
    // Project date + location are DERIVED from the linked event (city/country only).
    const projectDates = (e: { startDate: Date; endDate: Date } | null) => {
      if (!e?.startDate) return "";
      const start = iso(e.startDate);
      const end = iso(e.endDate);
      return end && end !== start ? `${start} – ${end}` : start;
    };
    const projectLocation = (e: { city: string | null; country: string | null } | null) =>
      [e?.city, e?.country].filter(Boolean).join(", ");
    const headers = [
      "Deal",
      "Company",
      "Pipeline",
      "Deal type",
      "Stage",
      "Status",
      ...(canSeeValues ? ["Value", "Currency"] : []),
      "Owner",
      "Event",
      "Project dates",
      "Project location",
      "Tags",
      "Expected close",
      "Won",
      "Lost",
      // Lost reason is negotiation PROSE ("they wanted 300k, we held at 500k") —
      // omitted for money-blind callers like the Value columns (review R2-M12).
      ...(canSeeValues ? ["Lost reason"] : []),
      "Contacts",
      "Tasks",
      "Notes",
      "Created",
    ];
    const rows = deals.map((d) => [
      d.name,
      d.company?.name ?? "",
      d.pipeline ?? "",
      d.dealType?.name ?? "",
      d.stage?.name ?? "",
      d.status,
      ...(canSeeValues ? [d.dealValue != null ? Number(d.dealValue) : "", d.currency] : []),
      d.owner ? `${d.owner.firstName} ${d.owner.lastName}` : "Unassigned",
      d.event?.name ?? "",
      projectDates(d.event),
      projectLocation(d.event),
      d.tags.join(", "),
      iso(d.expectedClose),
      iso(d.wonAt),
      iso(d.lostAt),
      ...(canSeeValues ? [d.lostReason ?? ""] : []),
      d._count.contacts,
      d._count.tasks,
      d._count.notes,
      iso(d.createdAt),
    ]);

    const csv = toCsv([headers, ...rows]);
    apiLogger.info({
      msg: "crm/deals/export:generated",
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      count: deals.length,
      withValues: canSeeValues,
      ip: getClientIp(req),
    });

    const stamp = new Date().toISOString().slice(0, 10);
    recordExport(req, {
      entityType: "CrmDeal",
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      role: ctx.role,
      source: ctx.fromApiKey ? "api" : "rest",
      rowCount: deals.length,
      format: "csv",
      // Deal money is role-gated — record whether this pull included it.
      filters: { includedDealValues: canSeeValues },
    });

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="crm-deals-${stamp}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    apiLogger.error({
      msg: "crm/deals/export:failed",
      organizationId: ctx.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not export deals" }, { status: 500 });
  }
  });
}
