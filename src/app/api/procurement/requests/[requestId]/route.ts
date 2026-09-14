/** GET one spend request with its line, quotes and approval trail (need "view"); PATCH edits a draft (need "request"). */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { canAdminProcurement } from "@/lib/procurement-visibility";
import { updateSpendRequestSchema } from "@/procurement/lib/budget-schemas";
import { HTTP_STATUS_FOR_SPEND_REQUEST_ERROR, guardedRead, denyUnlessRequestOrAdmin, procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { getSpendRequest, updateSpendRequest } from "@/procurement/services/spend-request-service";

type Params = { params: Promise<{ requestId: string }> };
const ROUTE = "procurement/requests/[requestId]";

export async function GET(_req: NextRequest, { params }: Params) {
  const [g, { requestId }] = await Promise.all([procurementGuard({ route: ROUTE, need: "view" }), params]);
  if (!g.ok) return g.response;
  return runWithTenant(g.orgId, () => guardedRead(ROUTE, g.user.id, async () => {
    const result = await getSpendRequest(g.orgId, requestId);
    if (!result.ok) return rejected(ROUTE, g.user.id, result, HTTP_STATUS_FOR_SPEND_REQUEST_ERROR);
    return NextResponse.json({ request: result.request });
  }));
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const [g, { requestId }] = await Promise.all([procurementGuard({ route: ROUTE, need: "view", write: true }), params]);
  if (!g.ok) return g.response;
  const denied = denyUnlessRequestOrAdmin(ROUTE, g.user);
  if (denied) return denied;
  const parsed = updateSpendRequestSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: ROUTE, userId: g.user.id, requestId });
  return runWithTenant(g.orgId, async () => {
    const result = await updateSpendRequest({ organizationId: g.orgId, actor: { id: g.user.id, isAdmin: canAdminProcurement(g.user) }, source: "ui", requestId, ...parsed.data });
    if (!result.ok) return rejected(ROUTE, g.user.id, result, HTTP_STATUS_FOR_SPEND_REQUEST_ERROR);
    return NextResponse.json({ request: result.request });
  });
}
