/**
 * POST: raise the purchase order for an approved request by hand. Approval
 * issues it by itself; this is the recovery after a conversion that failed
 * and the re-issue after a cancel (the requester with the grant, or an
 * admin; the service decides).
 */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { HTTP_STATUS_FOR_COMMITMENT_ERROR, orderActorFrom, procurementGuard, rejected } from "@/procurement/lib/route-helpers";
import { raiseOrder } from "@/procurement/services/commitment-service";

type Params = { params: Promise<{ requestId: string }> };
const ROUTE = "procurement/requests/[requestId]/order";

export async function POST(_req: NextRequest, { params }: Params) {
  const [g, { requestId }] = await Promise.all([procurementGuard({ route: ROUTE, need: "view", write: true }), params]);
  if (!g.ok) return g.response;
  return runWithTenant(g.orgId, async () => {
    const result = await raiseOrder({ organizationId: g.orgId, actor: orderActorFrom(g.user), source: "ui", requestId });
    if (!result.ok) return rejected(ROUTE, g.user.id, result, HTTP_STATUS_FOR_COMMITMENT_ERROR);
    return NextResponse.json({ commitment: result.commitment }, { status: 201 });
  });
}
