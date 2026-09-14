/**
 * POST { action } for the lifecycle moves that carry no payload of their own:
 *   freeze (author)  unfreeze (admin)  close (author, with variance notes)
 *   sign-off (settle grant)  reopen (admin, with a reason)
 */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { transitionSchema } from "@/procurement/lib/budget-schemas";
import type { ProcurementNeed } from "@/procurement/lib/procurement-roles";
import { HTTP_STATUS_FOR_BUDGET_ERROR, procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { closeBudget, freezeBudget, reopenBudget, signOffBudget, unfreezeBudget } from "@/procurement/services/budget-service";

const NEED: Record<"freeze" | "unfreeze" | "close" | "sign-off" | "reopen", ProcurementNeed> = {
  freeze: "author",
  unfreeze: "admin",
  close: "author",
  "sign-off": "settle",
  reopen: "admin",
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ budgetId: string }> }) {
  const { budgetId } = await params;
  const parsed = transitionSchema.safeParse(await readJson(req));
  if (!parsed.success) {
    // The grant depends on the action, so the body is read first; a bad body
    // still costs the caller an authentication check before any answer.
    const g = await procurementGuard({ route: "procurement/budgets/[budgetId]/transition", need: "view" });
    if (!g.ok) return g.response;
    return zodErrorResponse(parsed, { route: "procurement/budgets/[budgetId]/transition", userId: g.user.id, budgetId });
  }
  const g = await procurementGuard({ route: "procurement/budgets/[budgetId]/transition", need: NEED[parsed.data.action], write: true });
  if (!g.ok) return g.response;
  const base = { organizationId: g.orgId, actorUserId: g.user.id, source: "ui" as const, budgetId };
  return runWithTenant(g.orgId, async () => {
    const result =
      parsed.data.action === "freeze" ? await freezeBudget(base)
      : parsed.data.action === "unfreeze" ? await unfreezeBudget({ ...base, reason: parsed.data.reason ?? "" })
      : parsed.data.action === "close" ? await closeBudget({ ...base, varianceNotes: parsed.data.varianceNotes, aedToReportingRate: parsed.data.aedToReportingRate })
      : parsed.data.action === "sign-off" ? await signOffBudget(base)
      : await reopenBudget({ ...base, reason: parsed.data.reason ?? "" });
    if (!result.ok) return rejected("procurement/budgets/[budgetId]/transition", g.user.id, result, HTTP_STATUS_FOR_BUDGET_ERROR);
    return NextResponse.json({ budget: result.budget });
  });
}
