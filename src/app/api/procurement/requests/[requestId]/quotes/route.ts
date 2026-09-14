/** POST attach a quote to a draft (need "request"). */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { canAdminProcurement } from "@/lib/procurement-visibility";
import { createQuoteSchema } from "@/procurement/lib/budget-schemas";
import { HTTP_STATUS_FOR_SPEND_REQUEST_ERROR, denyUnlessRequestOrAdmin, procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { addQuote } from "@/procurement/services/spend-request-service";

const ROUTE = "procurement/requests/[requestId]/quotes";

export async function POST(req: NextRequest, { params }: { params: Promise<{ requestId: string }> }) {
  const [g, { requestId }] = await Promise.all([procurementGuard({ route: ROUTE, need: "view", write: true }), params]);
  if (!g.ok) return g.response;
  const denied = denyUnlessRequestOrAdmin(ROUTE, g.user);
  if (denied) return denied;
  const parsed = createQuoteSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: ROUTE, userId: g.user.id, requestId });
  return runWithTenant(g.orgId, async () => {
    const result = await addQuote({ organizationId: g.orgId, actor: { id: g.user.id, isAdmin: canAdminProcurement(g.user) }, source: "ui", requestId, ...parsed.data });
    if (!result.ok) return rejected(ROUTE, g.user.id, result, HTTP_STATUS_FOR_SPEND_REQUEST_ERROR);
    return NextResponse.json({ request: result.request }, { status: 201 });
  });
}
