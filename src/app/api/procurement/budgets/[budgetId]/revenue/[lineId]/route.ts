/** PATCH or DELETE a planned revenue line (draft versions only; finance sight required). */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { upsertRevenueLineSchema } from "@/procurement/lib/budget-schemas";
import { denyWithoutFinance, HTTP_STATUS_FOR_REVENUE_ERROR, procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { deleteRevenueLine, upsertRevenueLine } from "@/procurement/services/budget-revenue-service";

type Params = { params: Promise<{ budgetId: string; lineId: string }> };
const ROUTE = "procurement/budgets/[budgetId]/revenue/[lineId]";

export async function PATCH(req: NextRequest, { params }: Params) {
  const [g, { budgetId, lineId }] = await Promise.all([procurementGuard({ route: ROUTE, need: "author", write: true }), params]);
  if (!g.ok) return g.response;
  const denied = denyWithoutFinance(ROUTE, g.user);
  if (denied) return denied;
  const parsed = upsertRevenueLineSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: ROUTE, userId: g.user.id, budgetId, lineId });
  return runWithTenant(g.orgId, async () => {
    const result = await upsertRevenueLine({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", budgetId, lineId, ...parsed.data });
    if (!result.ok) return rejected(ROUTE, g.user.id, result, HTTP_STATUS_FOR_REVENUE_ERROR);
    return NextResponse.json({ line: result.value });
  });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const [g, { budgetId, lineId }] = await Promise.all([procurementGuard({ route: ROUTE, need: "author", write: true }), params]);
  if (!g.ok) return g.response;
  const denied = denyWithoutFinance(ROUTE, g.user);
  if (denied) return denied;
  return runWithTenant(g.orgId, async () => {
    const result = await deleteRevenueLine({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", budgetId, lineId });
    if (!result.ok) return rejected(ROUTE, g.user.id, result, HTTP_STATUS_FOR_REVENUE_ERROR);
    return NextResponse.json({ removed: result.value.id });
  });
}
