/** GET the budget's activity log: its audit rows, its lines' and its approval routing's, newest first, described in words. */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { guardedRead, HTTP_STATUS_FOR_BUDGET_ERROR, procurementGuard, rejected } from "@/procurement/lib/route-helpers";
import { listBudgetActivity } from "@/procurement/services/budget-activity-service";

type Params = { params: Promise<{ budgetId: string }> };
const ROUTE = "procurement/budgets/[budgetId]/activity";

export async function GET(_req: NextRequest, { params }: Params) {
  const [g, { budgetId }] = await Promise.all([procurementGuard({ route: ROUTE, need: "view" }), params]);
  if (!g.ok) return g.response;
  return runWithTenant(g.orgId, () => guardedRead(ROUTE, g.user.id, async () => {
    const result = await listBudgetActivity(g.orgId, budgetId);
    if (!result.ok) return rejected(ROUTE, g.user.id, result, HTTP_STATUS_FOR_BUDGET_ERROR);
    return NextResponse.json({ items: result.items, truncated: result.truncated });
  }));
}
