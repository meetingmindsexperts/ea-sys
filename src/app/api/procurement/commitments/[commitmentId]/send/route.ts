/** POST: email the purchase order PDF to the supplier's contacts (the requester, the settle holder or an admin; the service decides). */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { HTTP_STATUS_FOR_COMMITMENT_ERROR, orderActorFrom, procurementGuard, rejected } from "@/procurement/lib/route-helpers";
import { sendOrderToSupplier } from "@/procurement/services/commitment-service";

type Params = { params: Promise<{ commitmentId: string }> };
const ROUTE = "procurement/commitments/[commitmentId]/send";

export async function POST(_req: NextRequest, { params }: Params) {
  const [g, { commitmentId }] = await Promise.all([procurementGuard({ route: ROUTE, need: "view", write: true }), params]);
  if (!g.ok) return g.response;
  return runWithTenant(g.orgId, async () => {
    const result = await sendOrderToSupplier({ organizationId: g.orgId, actor: orderActorFrom(g.user), source: "ui", commitmentId });
    if (!result.ok) return rejected(ROUTE, g.user.id, result, HTTP_STATUS_FOR_COMMITMENT_ERROR);
    return NextResponse.json({ commitment: result.commitment });
  });
}
