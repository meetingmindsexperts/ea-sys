/** DELETE a quote from a draft (need "request"). */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { canAdminProcurement } from "@/lib/procurement-visibility";
import { HTTP_STATUS_FOR_SPEND_REQUEST_ERROR, denyUnlessRequestOrAdmin, procurementGuard, rejected } from "@/procurement/lib/route-helpers";
import { removeQuote } from "@/procurement/services/spend-request-service";

const ROUTE = "procurement/requests/[requestId]/quotes/[quoteId]";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ requestId: string; quoteId: string }> }) {
  const [g, { requestId, quoteId }] = await Promise.all([procurementGuard({ route: ROUTE, need: "view", write: true }), params]);
  if (!g.ok) return g.response;
  const denied = denyUnlessRequestOrAdmin(ROUTE, g.user);
  if (denied) return denied;
  return runWithTenant(g.orgId, async () => {
    const result = await removeQuote({ organizationId: g.orgId, actor: { id: g.user.id, isAdmin: canAdminProcurement(g.user) }, source: "ui", requestId, quoteId });
    if (!result.ok) return rejected(ROUTE, g.user.id, result, HTTP_STATUS_FOR_SPEND_REQUEST_ERROR);
    return NextResponse.json({ request: result.request });
  });
}
