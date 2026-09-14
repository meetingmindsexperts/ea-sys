/**
 * GET  /api/procurement/budgets?eventId=&status=   list (org staff or any grant)
 * POST /api/procurement/budgets                    create from a template (ORGANIZER and above)
 */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { createBudgetSchema } from "@/procurement/lib/budget-schemas";
import { HTTP_STATUS_FOR_BUDGET_ERROR, procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { createBudget, listBudgets } from "@/procurement/services/budget-service";

export async function GET(req: NextRequest) {
  const g = await procurementGuard({ route: "procurement/budgets", need: "view" });
  if (!g.ok) return g.response;
  const eventId = req.nextUrl.searchParams.get("eventId") ?? undefined;
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  return runWithTenant(g.orgId, async () => NextResponse.json({ budgets: await listBudgets(g.orgId, { eventId, status }) }));
}

export async function POST(req: NextRequest) {
  const g = await procurementGuard({ route: "procurement/budgets", need: "author", write: true });
  if (!g.ok) return g.response;
  const parsed = createBudgetSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: "procurement/budgets", userId: g.user.id });
  return runWithTenant(g.orgId, async () => {
    const result = await createBudget({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", ...parsed.data });
    if (!result.ok) return rejected("procurement/budgets", g.user.id, result, HTTP_STATUS_FOR_BUDGET_ERROR);
    return NextResponse.json({ budget: result.budget }, { status: 201 });
  });
}
