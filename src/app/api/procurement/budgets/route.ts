/**
 * GET  /api/procurement/budgets?eventId=&status=   list (org staff or any grant)
 * POST /api/procurement/budgets                    create from a template, or from the lines of
 *                                                   an imported budget sheet (ORGANIZER and above;
 *                                                   imported billed lines also need finance sight),
 *                                                   or as a copy of a past budget's plan
 */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { createBudgetSchema } from "@/procurement/lib/budget-schemas";
import { denyWithoutFinance, HTTP_STATUS_FOR_BUDGET_ERROR, procurementCan, procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { apiLogger } from "@/lib/logger";
import { createBudget, invalidBudgetStatusFilter, listBudgets } from "@/procurement/services/budget-service";

export async function GET(req: NextRequest) {
  const g = await procurementGuard({ route: "procurement/budgets", need: "view" });
  if (!g.ok) return g.response;
  const eventId = req.nextUrl.searchParams.get("eventId") ?? undefined;
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  if (invalidBudgetStatusFilter(status)) {
    // Refused, never silently widened to every status (the INVALID_FILTER rule).
    return rejected("procurement/budgets", g.user.id, { code: "INVALID_FILTER", message: `Unknown status "${status}".` }, HTTP_STATUS_FOR_BUDGET_ERROR);
  }
  return runWithTenant(g.orgId, async () => {
    try {
      return NextResponse.json({ budgets: await listBudgets(g.orgId, { eventId, status }) });
    } catch (err) {
      apiLogger.error({ msg: "procurement/budgets:list-failed", err, userId: g.user.id });
      return NextResponse.json({ error: "Could not load the budgets." }, { status: 500 });
    }
  });
}

export async function POST(req: NextRequest) {
  const g = await procurementGuard({ route: "procurement/budgets", need: "author", write: true });
  if (!g.ok) return g.response;
  const parsed = createBudgetSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: "procurement/budgets", userId: g.user.id });
  // Revenue is finance data on every other door (the revenue route); an import is not a side door.
  if ((parsed.data.revenueLines?.length ?? 0) > 0) {
    const denied = denyWithoutFinance("procurement/budgets", g.user);
    if (denied) return denied;
  }
  return runWithTenant(g.orgId, async () => {
    // A copy brings the source's revenue lines only for someone who may see revenue; the cost plan always.
    const copyRevenue = !!parsed.data.fromBudgetId && procurementCan(g.user, "finance.view");
    const result = await createBudget({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", ...parsed.data, copyRevenue });
    if (!result.ok) return rejected("procurement/budgets", g.user.id, result, HTTP_STATUS_FOR_BUDGET_ERROR);
    if (parsed.data.fromBudgetId) {
      apiLogger.info({ msg: "procurement/budgets:copied", userId: g.user.id, budgetId: result.budget.id, fromBudgetId: parsed.data.fromBudgetId, priceChangePercent: parsed.data.priceChangePercent ?? 0, copyRevenue });
    }
    if (parsed.data.importedFrom) {
      apiLogger.info({ msg: "procurement/budgets:imported", userId: g.user.id, budgetId: result.budget.id, lines: parsed.data.lines?.length ?? 0, revenueLines: parsed.data.revenueLines?.length ?? 0 });
    }
    return NextResponse.json({ budget: result.budget }, { status: 201 });
  });
}
