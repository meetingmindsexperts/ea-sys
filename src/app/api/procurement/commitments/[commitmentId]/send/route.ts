/** POST: email the purchase order PDF to the supplier's contacts (the requester, the settle holder or an admin; the service decides). */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { rateLimited } from "@/lib/api-errors";
import { checkRateLimit } from "@/lib/security";
import { HTTP_STATUS_FOR_COMMITMENT_ERROR, orderActorFrom, procurementGuard, rejected } from "@/procurement/lib/route-helpers";
import { sendOrderToSupplier } from "@/procurement/services/commitment-service";

type Params = { params: Promise<{ commitmentId: string }> };
const ROUTE = "procurement/commitments/[commitmentId]/send";

export async function POST(_req: NextRequest, { params }: Params) {
  const [g, { commitmentId }] = await Promise.all([procurementGuard({ route: ROUTE, need: "view", write: true }), params]);
  if (!g.ok) return g.response;
  // Each send renders the PDF and emails every supplier contact from the org's identity: 10 an hour per person.
  const rl = checkRateLimit({ key: `procurement-send:${g.user.id}`, limit: 10, windowMs: 60 * 60 * 1000 });
  if (!rl.allowed) return rateLimited(rl, { route: ROUTE, userId: g.user.id, limit: 10, windowSeconds: 3600 });
  return runWithTenant(g.orgId, async () => {
    const result = await sendOrderToSupplier({ organizationId: g.orgId, actor: orderActorFrom(g.user), source: "ui", commitmentId });
    if (!result.ok) return rejected(ROUTE, g.user.id, result, HTTP_STATUS_FOR_COMMITMENT_ERROR);
    return NextResponse.json({ commitment: result.commitment });
  });
}
