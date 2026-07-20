import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { toCsv } from "@/lib/csv-escape";
import { requireCrmRead } from "@/crm/lib/crm-route";
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
 * Rate-limited: an export is a whole-pipeline read, the highest-value single object
 * in the domain.
 */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;

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
        expectedClose: true,
        wonAt: true,
        lostAt: true,
        lostReason: true,
        createdAt: true,
        stage: { select: { name: true } },
        company: { select: { name: true } },
        event: { select: { name: true } },
        owner: { select: { firstName: true, lastName: true } },
        _count: { select: { contacts: true, tasks: true, notes: true } },
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 5000,
    });

    const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
    const headers = [
      "Deal",
      "Company",
      "Stage",
      "Status",
      ...(canSeeValues ? ["Value", "Currency"] : []),
      "Owner",
      "Event",
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
      d.stage?.name ?? "",
      d.status,
      ...(canSeeValues ? [d.dealValue != null ? Number(d.dealValue) : "", d.currency] : []),
      d.owner ? `${d.owner.firstName} ${d.owner.lastName}` : "Unassigned",
      d.event?.name ?? "",
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
}
