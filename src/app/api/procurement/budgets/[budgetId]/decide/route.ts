/**
 * POST approve or reject a submitted budget. The guard asks only that the
 * caller holds SOME approval grant; the primitive checks the ceiling against
 * the request's AED amount and refuses the requester and the settle grant.
 */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { decideSchema } from "@/procurement/lib/budget-schemas";
import { HTTP_STATUS_FOR_BUDGET_ERROR, procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { decideBudget } from "@/procurement/services/budget-service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ budgetId: string }> }) {
  const [g, { budgetId }] = await Promise.all([procurementGuard({ route: "procurement/budgets/[budgetId]/decide", need: "approve", amountAed: 0, write: true }), params]);
  if (!g.ok) return g.response;
  const parsed = decideSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: "procurement/budgets/[budgetId]/decide", userId: g.user.id, budgetId });
  return runWithTenant(g.orgId, async () => {
    const result = await decideBudget({ organizationId: g.orgId, decider: g.user, source: "ui", budgetId, ...parsed.data });
    if (!result.ok) return rejected("procurement/budgets/[budgetId]/decide", g.user.id, result, HTTP_STATUS_FOR_BUDGET_ERROR);
    return NextResponse.json({ budget: result.budget });
  });
}
