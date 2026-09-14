/**
 * GET the spend requests (need "view"; every org staff member reads them, the
 * `mine=1` filter narrows to the caller's own); POST drafts one (need
 * "request"). The check and the routing run at submit, not here.
 */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
import { canAdminProcurement } from "@/lib/procurement-visibility";
import { createSpendRequestSchema } from "@/procurement/lib/budget-schemas";
import { HTTP_STATUS_FOR_SPEND_REQUEST_ERROR, guardedRead, procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { createSpendRequest, invalidSpendRequestStatusFilter, listSpendRequests } from "@/procurement/services/spend-request-service";

const ROUTE = "procurement/requests";

export async function GET(req: NextRequest) {
  const g = await procurementGuard({ route: ROUTE, need: "view" });
  if (!g.ok) return g.response;
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? undefined;
  if (invalidSpendRequestStatusFilter(status)) {
    apiLogger.warn({ msg: `${ROUTE}:invalid-status-filter`, status, userId: g.user.id });
    return NextResponse.json({ error: "Invalid status filter", code: "INVALID_FILTER" }, { status: 400 });
  }
  const budgetId = url.searchParams.get("budgetId") ?? undefined;
  const mine = url.searchParams.get("mine") === "1";
  return runWithTenant(g.orgId, () => guardedRead(ROUTE, g.user.id, async () => {
    const requests = await listSpendRequests(g.orgId, { status, budgetId, requesterUserId: mine ? g.user.id : undefined });
    return NextResponse.json({ requests });
  }));
}

export async function POST(req: NextRequest) {
  const g = await procurementGuard({ route: ROUTE, need: "request", write: true });
  if (!g.ok) return g.response;
  const parsed = createSpendRequestSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: ROUTE, userId: g.user.id });
  return runWithTenant(g.orgId, async () => {
    const result = await createSpendRequest({ organizationId: g.orgId, actor: { id: g.user.id, isAdmin: canAdminProcurement(g.user) }, source: "ui", ...parsed.data });
    if (!result.ok) return rejected(ROUTE, g.user.id, result, HTTP_STATUS_FOR_SPEND_REQUEST_ERROR);
    return NextResponse.json({ request: result.request }, { status: 201 });
  });
}
