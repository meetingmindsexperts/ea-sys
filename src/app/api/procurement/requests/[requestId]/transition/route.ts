/**
 * POST withdraw (the requester, back to draft) or cancel (the requester or
 * an admin, with a reason). Need "view" at the guard because an admin may
 * cancel without holding the request grant; the route then insists on one
 * of the two, logged.
 */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { canAdminProcurement } from "@/lib/procurement-visibility";
import { spendRequestTransitionSchema } from "@/procurement/lib/budget-schemas";
import { HTTP_STATUS_FOR_SPEND_REQUEST_ERROR, denyUnlessRequestOrAdmin, procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { transitionSpendRequest } from "@/procurement/services/spend-request-service";

const ROUTE = "procurement/requests/[requestId]/transition";

export async function POST(req: NextRequest, { params }: { params: Promise<{ requestId: string }> }) {
  const [g, { requestId }] = await Promise.all([procurementGuard({ route: ROUTE, need: "view", write: true }), params]);
  if (!g.ok) return g.response;
  const isAdmin = canAdminProcurement(g.user);
  const denied = denyUnlessRequestOrAdmin(ROUTE, g.user);
  if (denied) return denied;
  const parsed = spendRequestTransitionSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: ROUTE, userId: g.user.id, requestId });
  return runWithTenant(g.orgId, async () => {
    const result = await transitionSpendRequest({ organizationId: g.orgId, actor: { id: g.user.id, isAdmin }, source: "ui", requestId, ...parsed.data });
    if (!result.ok) return rejected(ROUTE, g.user.id, result, HTTP_STATUS_FOR_SPEND_REQUEST_ERROR);
    return NextResponse.json({ request: result.request });
  });
}
