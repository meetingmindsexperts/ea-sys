import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { requireCrmRead, crmCan } from "@/crm/lib/crm-route";
import { buildCrmReportHeadline } from "@/crm/services/report-service";

/**
 * GET /api/crm/reports/headline: CRM Home's two totals, the open pipeline
 * (count and value) and the win rate, over every deal.
 *
 * Everyone in the CRM may read it. The report beside it (../route.ts) is
 * admins only since Nov 12, 2026, and the owner kept Home's totals for the
 * sales team ("Reports page only"), so this door is deliberately on the read
 * gate ALONE: no stages, no won or lost values, no per-person results, no
 * breakdown and no filters come out of it. Never widen what it returns without
 * asking whether it belongs behind `crm.reports.view` instead.
 *
 * The value is null for a caller without `crm.dealValues.view`, as everywhere.
 */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    const canSeeValues = crmCan(ctx, "crm.dealValues.view");
    try {
      const headline = await buildCrmReportHeadline({ organizationId: ctx.organizationId, canSeeValues });
      return NextResponse.json({ canSeeValues, ...headline });
    } catch (err) {
      apiLogger.error({
        msg: "crm/reports/headline:failed",
        organizationId: ctx.organizationId,
        err: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({ error: "Could not load the totals" }, { status: 500 });
    }
  });
}
