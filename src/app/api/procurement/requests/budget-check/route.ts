/**
 * GET the live side panel's answer (need "view"): this amount on this line,
 * what the budget check says and who would decide. The same rules and the
 * same routing the submit runs, so the panel and the outcome agree.
 */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { budgetCheckQuerySchema } from "@/procurement/lib/budget-schemas";
import { HTTP_STATUS_FOR_SPEND_REQUEST_ERROR, guardedRead, procurementGuard, rejected } from "@/procurement/lib/route-helpers";
import { previewBudgetCheck } from "@/procurement/services/spend-request-service";

const ROUTE = "procurement/requests/budget-check";

export async function GET(req: NextRequest) {
  const g = await procurementGuard({ route: ROUTE, need: "view" });
  if (!g.ok) return g.response;
  const q = Object.fromEntries(new URL(req.url).searchParams.entries());
  const parsed = budgetCheckQuerySchema.safeParse({ ...q, fxRateToReporting: q.fxRateToReporting || null, reportingToAedRate: q.reportingToAedRate || null, excludeRequestId: q.excludeRequestId || null });
  if (!parsed.success) return zodErrorResponse(parsed, { route: ROUTE, userId: g.user.id });
  return runWithTenant(g.orgId, () => guardedRead(ROUTE, g.user.id, async () => {
    const result = await previewBudgetCheck({ organizationId: g.orgId, actorUserId: g.user.id, ...parsed.data });
    if (!result.ok) return rejected(ROUTE, g.user.id, result, HTTP_STATUS_FOR_SPEND_REQUEST_ERROR);
    return NextResponse.json({ preview: result.request });
  }));
}
