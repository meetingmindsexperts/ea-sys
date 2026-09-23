/** POST: take a receipt back while it is unconfirmed (the recorder, the settle holder or an admin; the service decides). */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { confirmReceiptSchema } from "@/procurement/lib/budget-schemas";
import { HTTP_STATUS_FOR_COMMITMENT_ERROR, orderActorFrom, procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { undoReceipt } from "@/procurement/services/commitment-service";

type Params = { params: Promise<{ commitmentId: string }> };
const ROUTE = "procurement/commitments/[commitmentId]/undo-receipt";

export async function POST(req: NextRequest, { params }: Params) {
  const [g, { commitmentId }] = await Promise.all([procurementGuard({ route: ROUTE, need: "view", write: true }), params]);
  if (!g.ok) return g.response;
  // The same body as confirm: the version this undo is judged against.
  const parsed = confirmReceiptSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: ROUTE, userId: g.user.id, commitmentId });
  return runWithTenant(g.orgId, async () => {
    const result = await undoReceipt({ organizationId: g.orgId, actor: orderActorFrom(g.user), source: "ui", commitmentId, expectedVersion: parsed.data.expectedVersion });
    if (!result.ok) return rejected(ROUTE, g.user.id, result, HTTP_STATUS_FOR_COMMITMENT_ERROR);
    return NextResponse.json({ commitment: result.commitment });
  });
}
