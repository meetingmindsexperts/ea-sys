/** POST move planned amount between two lines of the active version (10% rule; larger moves route for approval). */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { reallocateSchema } from "@/procurement/lib/budget-schemas";
import { HTTP_STATUS_FOR_BUDGET_ERROR, procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { reallocateBudget } from "@/procurement/services/budget-service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ budgetId: string }> }) {
  const [g, { budgetId }] = await Promise.all([procurementGuard({ route: "procurement/budgets/[budgetId]/reallocate", need: "author", write: true }), params]);
  if (!g.ok) return g.response;
  const parsed = reallocateSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: "procurement/budgets/[budgetId]/reallocate", userId: g.user.id, budgetId });
  return runWithTenant(g.orgId, async () => {
    const result = await reallocateBudget({ organizationId: g.orgId, actorUserId: g.user.id, actor: g.user, source: "ui", budgetId, ...parsed.data });
    if (!result.ok) return rejected("procurement/budgets/[budgetId]/reallocate", g.user.id, result, HTTP_STATUS_FOR_BUDGET_ERROR);
    return NextResponse.json({ budget: result.budget, pendingApprovalId: "pendingApprovalId" in result ? result.pendingApprovalId : null }, { status: "pendingApprovalId" in result ? 202 : 200 });
  });
}
