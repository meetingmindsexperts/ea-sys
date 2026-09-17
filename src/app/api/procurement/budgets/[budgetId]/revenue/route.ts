/**
 * GET  the budget's revenue side: planned lines, actuals read from paid
 *      registrations and won deals, per income account, and the margin.
 * POST a planned revenue line (draft versions only).
 * Both need finance sight on top of the procurement need (spec §6b).
 */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { createRevenueLineSchema } from "@/procurement/lib/budget-schemas";
import { denyWithoutFinance, guardedRead, HTTP_STATUS_FOR_REVENUE_ERROR, procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { getBudgetRevenue, upsertRevenueLine } from "@/procurement/services/budget-revenue-service";

type Params = { params: Promise<{ budgetId: string }> };
const ROUTE = "procurement/budgets/[budgetId]/revenue";

export async function GET(_req: NextRequest, { params }: Params) {
  const [g, { budgetId }] = await Promise.all([procurementGuard({ route: ROUTE, need: "view" }), params]);
  if (!g.ok) return g.response;
  const denied = denyWithoutFinance(ROUTE, g.user);
  if (denied) return denied;
  return runWithTenant(g.orgId, () => guardedRead(ROUTE, g.user.id, async () => {
    const result = await getBudgetRevenue(g.orgId, budgetId);
    if (!result.ok) return rejected(ROUTE, g.user.id, result, HTTP_STATUS_FOR_REVENUE_ERROR);
    return NextResponse.json({ revenue: result.value });
  }));
}

export async function POST(req: NextRequest, { params }: Params) {
  const [g, { budgetId }] = await Promise.all([procurementGuard({ route: ROUTE, need: "author", write: true }), params]);
  if (!g.ok) return g.response;
  const denied = denyWithoutFinance(ROUTE, g.user);
  if (denied) return denied;
  const parsed = createRevenueLineSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: ROUTE, userId: g.user.id, budgetId });
  return runWithTenant(g.orgId, async () => {
    const result = await upsertRevenueLine({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", budgetId, ...parsed.data });
    if (!result.ok) return rejected(ROUTE, g.user.id, result, HTTP_STATUS_FOR_REVENUE_ERROR);
    return NextResponse.json({ line: result.value }, { status: 201 });
  });
}
