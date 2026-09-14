/** POST a new draft version cloned from the active one (lineKeys preserved). */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { HTTP_STATUS_FOR_BUDGET_ERROR, procurementGuard, rejected } from "@/procurement/lib/route-helpers";
import { newBudgetVersion } from "@/procurement/services/budget-service";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ budgetId: string }> }) {
  const [g, { budgetId }] = await Promise.all([procurementGuard({ route: "procurement/budgets/[budgetId]/versions", need: "author", write: true }), params]);
  if (!g.ok) return g.response;
  return runWithTenant(g.orgId, async () => {
    const result = await newBudgetVersion({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", budgetId });
    if (!result.ok) return rejected("procurement/budgets/[budgetId]/versions", g.user.id, result, HTTP_STATUS_FOR_BUDGET_ERROR);
    return NextResponse.json({ budget: result.budget }, { status: 201 });
  });
}
