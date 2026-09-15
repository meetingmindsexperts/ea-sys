/** POST a decision on any pending request, dispatched by its subject type: a budget, a reallocation or a spend request. */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
import { decideSchema } from "@/procurement/lib/budget-schemas";
import { HTTP_STATUS_FOR_BUDGET_ERROR, HTTP_STATUS_FOR_SPEND_REQUEST_ERROR, procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { decideBudget, decideReallocation } from "@/procurement/services/budget-service";
import { decideSpendRequest } from "@/procurement/services/spend-request-service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ requestId: string }> }) {
  const [g, { requestId }] = await Promise.all([procurementGuard({ route: "procurement/approvals/[requestId]/decide", need: "approve", amountAed: 0, write: true }), params]);
  if (!g.ok) return g.response;
  const parsed = decideSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: "procurement/approvals/[requestId]/decide", userId: g.user.id, requestId });
  return runWithTenant(g.orgId, async () => {
    const request = await db.approvalRequest.findFirst({ where: { id: requestId, organizationId: g.orgId }, select: { subjectType: true, subjectId: true } });
    if (!request) {
      apiLogger.warn({ msg: "procurement/approvals/[requestId]/decide:not-found", requestId, userId: g.user.id });
      return NextResponse.json({ error: "The approval request was not found." }, { status: 404 });
    }
    if (request.subjectType === "SPEND_REQUEST") {
      const result = await decideSpendRequest({ organizationId: g.orgId, decider: g.user, source: "ui", approvalRequestId: requestId, ...parsed.data });
      if (!result.ok) return rejected("procurement/approvals/[requestId]/decide", g.user.id, result, HTTP_STATUS_FOR_SPEND_REQUEST_ERROR);
      return NextResponse.json({ spendRequest: result.request, autoSend: result.autoSend ?? null });
    }
    const result =
      request.subjectType === "BUDGET"
        ? await decideBudget({ organizationId: g.orgId, decider: g.user, source: "ui", budgetId: request.subjectId, ...parsed.data })
        : await decideReallocation({ organizationId: g.orgId, decider: g.user, source: "ui", requestId, ...parsed.data });
    if (!result.ok) return rejected("procurement/approvals/[requestId]/decide", g.user.id, result, HTTP_STATUS_FOR_BUDGET_ERROR);
    return NextResponse.json({ budget: result.budget });
  });
}
