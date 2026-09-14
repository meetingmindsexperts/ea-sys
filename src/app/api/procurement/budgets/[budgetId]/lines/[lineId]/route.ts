/** PATCH a line (planned fields on a draft; forecast, notes and variance note on any open version). DELETE soft-removes a draft line. */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { upsertBudgetLineSchema } from "@/procurement/lib/budget-schemas";
import { HTTP_STATUS_FOR_BUDGET_ERROR, procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { deleteBudgetLine, upsertBudgetLine } from "@/procurement/services/budget-service";

type Params = { params: Promise<{ budgetId: string; lineId: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const [g, { budgetId, lineId }] = await Promise.all([procurementGuard({ route: "procurement/budgets/[budgetId]/lines/[lineId]", need: "author", write: true }), params]);
  if (!g.ok) return g.response;
  const parsed = upsertBudgetLineSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: "procurement/budgets/[budgetId]/lines/[lineId]", userId: g.user.id, budgetId, lineId });
  return runWithTenant(g.orgId, async () => {
    const result = await upsertBudgetLine({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", budgetId, lineId, ...parsed.data });
    if (!result.ok) return rejected("procurement/budgets/[budgetId]/lines/[lineId]", g.user.id, result, HTTP_STATUS_FOR_BUDGET_ERROR);
    return NextResponse.json({ budget: result.budget });
  });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const [g, { budgetId, lineId }] = await Promise.all([procurementGuard({ route: "procurement/budgets/[budgetId]/lines/[lineId]", need: "author", write: true }), params]);
  if (!g.ok) return g.response;
  return runWithTenant(g.orgId, async () => {
    const result = await deleteBudgetLine({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", budgetId, lineId });
    if (!result.ok) return rejected("procurement/budgets/[budgetId]/lines/[lineId]", g.user.id, result, HTTP_STATUS_FOR_BUDGET_ERROR);
    return NextResponse.json({ budget: result.budget });
  });
}
