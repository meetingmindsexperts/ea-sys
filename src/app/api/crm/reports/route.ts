import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { requireCrmRead } from "@/crm/lib/crm-route";
import { canViewDealValues } from "@/crm/lib/crm-roles";
import { buildCrmReport } from "@/crm/services/report-service";
import { parseReportDimension } from "@/crm/lib/reports";

/**
 * GET /api/crm/reports — pipeline summary, win/loss, and a per-rep leaderboard.
 *
 * Honours the same filters as the board (event/owner/pipeline/deal type/date/value)
 * via buildDealWhere, so a report reflects whatever the operator is looking at.
 * `groupBy` adds a breakdown by one dimension (pipeline, owner, event, dealType,
 * lostReason, expectedCloseMonth, closedMonth); a value that is not a dimension is
 * a logged 400, never a silently missing table. Money is finance-gated:
 * a MEMBER gets counts + win-rate but every VALUE comes back null (rendered as "—",
 * never a fabricated 0).
 *
 * The assembly lives in report-service (review R2-M9) — ONE implementation shared
 * with the MCP `get_crm_report` tool, which used to carry its own thinner copy.
 */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;
  // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
  return await runWithTenant(ctx.organizationId, async () => {

  const canSeeValues = canViewDealValues(ctx.role, ctx.fromApiKey);

  try {
    const { searchParams } = new URL(req.url);
    const groupByParam = searchParams.get("groupBy");
    const groupBy = parseReportDimension(groupByParam);
    if (groupByParam && !groupBy) {
      apiLogger.warn({ msg: "crm/reports:invalid-group-by", organizationId: ctx.organizationId, groupBy: groupByParam });
      return NextResponse.json(
        { error: `"${groupByParam}" is not a report dimension`, code: "INVALID_GROUP_BY" },
        { status: 400 },
      );
    }
    const report = await buildCrmReport({
      organizationId: ctx.organizationId,
      canSeeValues,
      groupBy,
      filters: {
        eventId: searchParams.get("eventId"),
        ownerId: searchParams.get("ownerId"),
        pipeline: searchParams.get("pipeline"),
        dealTypeId: searchParams.get("dealTypeId"),
        dateField: searchParams.get("dateField"),
        from: searchParams.get("from"),
        to: searchParams.get("to"),
        min: searchParams.get("min"),
        max: searchParams.get("max"),
      },
    });

    return NextResponse.json({
      canSeeValues,
      ...report,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    apiLogger.error({
      msg: "crm/reports:failed",
      organizationId: ctx.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not build the report" }, { status: 500 });
  }
  });
}
