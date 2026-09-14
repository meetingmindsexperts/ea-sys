/** POST submit a draft (need "request"): the budget check runs at once and the request is routed on the AED matrix. */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { canAdminProcurement } from "@/lib/procurement-visibility";
import { submitSpendRequestSchema } from "@/procurement/lib/budget-schemas";
import { HTTP_STATUS_FOR_SPEND_REQUEST_ERROR, procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { submitSpendRequest } from "@/procurement/services/spend-request-service";

const ROUTE = "procurement/requests/[requestId]/submit";

export async function POST(req: NextRequest, { params }: { params: Promise<{ requestId: string }> }) {
  const [g, { requestId }] = await Promise.all([procurementGuard({ route: ROUTE, need: "request", write: true }), params]);
  if (!g.ok) return g.response;
  const parsed = submitSpendRequestSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: ROUTE, userId: g.user.id, requestId });
  return runWithTenant(g.orgId, async () => {
    const result = await submitSpendRequest({ organizationId: g.orgId, actor: { id: g.user.id, isAdmin: canAdminProcurement(g.user) }, source: "ui", requestId, ...parsed.data });
    if (!result.ok) return rejected(ROUTE, g.user.id, result, HTTP_STATUS_FOR_SPEND_REQUEST_ERROR);
    return NextResponse.json({ request: result.request });
  });
}
