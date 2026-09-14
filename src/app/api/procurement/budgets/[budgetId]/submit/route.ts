/** POST submit a draft: the completeness check, then an approval request routed on the AED matrix. */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { submitBudgetSchema } from "@/procurement/lib/budget-schemas";
import { HTTP_STATUS_FOR_BUDGET_ERROR, procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { submitBudget } from "@/procurement/services/budget-service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ budgetId: string }> }) {
  const [g, { budgetId }] = await Promise.all([procurementGuard({ route: "procurement/budgets/[budgetId]/submit", need: "author", write: true }), params]);
  if (!g.ok) return g.response;
  const parsed = submitBudgetSchema.safeParse((await readJson(req)) ?? {});
  if (!parsed.success) return zodErrorResponse(parsed, { route: "procurement/budgets/[budgetId]/submit", userId: g.user.id, budgetId });
  return runWithTenant(g.orgId, async () => {
    const result = await submitBudget({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", budgetId, ...parsed.data });
    if (!result.ok) return rejected("procurement/budgets/[budgetId]/submit", g.user.id, result, HTTP_STATUS_FOR_BUDGET_ERROR);
    return NextResponse.json({ budget: result.budget });
  });
}
