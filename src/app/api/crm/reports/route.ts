import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { requireCrmRead } from "@/crm/lib/crm-route";
import { canViewDealValues } from "@/crm/lib/crm-roles";
import { buildCrmReport } from "@/crm/services/report-service";

/**
 * GET /api/crm/reports — pipeline summary, win/loss, and a per-rep leaderboard.
 *
 * Honours the same filters as the board (event/owner/date/value) via buildDealWhere,
 * so a report reflects whatever the operator is looking at. Money is finance-gated:
 * a MEMBER gets counts + win-rate but every VALUE comes back null (rendered as "—",
 * never a fabricated 0).
 *
 * The assembly lives in report-service (review R2-M9) — ONE implementation shared
 * with the MCP `get_crm_report` tool, which used to carry its own thinner copy.
 */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;

  const canSeeValues = canViewDealValues(ctx.role, ctx.fromApiKey);

  try {
    const { searchParams } = new URL(req.url);
    const report = await buildCrmReport({
      organizationId: ctx.organizationId,
      canSeeValues,
      filters: {
        eventId: searchParams.get("eventId"),
        ownerId: searchParams.get("ownerId"),
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
}
