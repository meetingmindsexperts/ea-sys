/**
 * GET    one budget with its live lines
 * PATCH  header fields (optimistic lock on `expectedVersion`)
 * DELETE discard a draft or submitted version
 */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { updateBudgetHeaderSchema } from "@/procurement/lib/budget-schemas";
import { HTTP_STATUS_FOR_BUDGET_ERROR, procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { discardDraftBudget, getBudget, updateBudgetHeader } from "@/procurement/services/budget-service";

type Params = { params: Promise<{ budgetId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const [g, { budgetId }] = await Promise.all([procurementGuard({ route: "procurement/budgets/[budgetId]", need: "view" }), params]);
  if (!g.ok) return g.response;
  return runWithTenant(g.orgId, async () => {
    const result = await getBudget(g.orgId, budgetId);
    if (!result.ok) return rejected("procurement/budgets/[budgetId]", g.user.id, result, HTTP_STATUS_FOR_BUDGET_ERROR);
    return NextResponse.json({ budget: result.budget });
  });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const [g, { budgetId }] = await Promise.all([procurementGuard({ route: "procurement/budgets/[budgetId]", need: "author", write: true }), params]);
  if (!g.ok) return g.response;
  const parsed = updateBudgetHeaderSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: "procurement/budgets/[budgetId]", userId: g.user.id, budgetId });
  return runWithTenant(g.orgId, async () => {
    const result = await updateBudgetHeader({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", budgetId, ...parsed.data });
    if (!result.ok) return rejected("procurement/budgets/[budgetId]", g.user.id, result, HTTP_STATUS_FOR_BUDGET_ERROR);
    return NextResponse.json({ budget: result.budget });
  });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const [g, { budgetId }] = await Promise.all([procurementGuard({ route: "procurement/budgets/[budgetId]", need: "author", write: true }), params]);
  if (!g.ok) return g.response;
  return runWithTenant(g.orgId, async () => {
    const result = await discardDraftBudget({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", budgetId });
    if (!result.ok) return rejected("procurement/budgets/[budgetId]", g.user.id, result, HTTP_STATUS_FOR_BUDGET_ERROR);
    return NextResponse.json({ discarded: result.budget.id });
  });
}
