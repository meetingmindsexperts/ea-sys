/** POST a line onto a draft budget. */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { upsertBudgetLineSchema } from "@/procurement/lib/budget-schemas";
import { HTTP_STATUS_FOR_BUDGET_ERROR, procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { upsertBudgetLine } from "@/procurement/services/budget-service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ budgetId: string }> }) {
  const [g, { budgetId }] = await Promise.all([procurementGuard({ route: "procurement/budgets/[budgetId]/lines", need: "author", write: true }), params]);
  if (!g.ok) return g.response;
  const parsed = upsertBudgetLineSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: "procurement/budgets/[budgetId]/lines", userId: g.user.id, budgetId });
  return runWithTenant(g.orgId, async () => {
    const result = await upsertBudgetLine({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", budgetId, ...parsed.data });
    if (!result.ok) return rejected("procurement/budgets/[budgetId]/lines", g.user.id, result, HTTP_STATUS_FOR_BUDGET_ERROR);
    return NextResponse.json({ budget: result.budget }, { status: 201 });
  });
}
