/** POST approve or reject a PROPOSED supplier (settle grant only; a conditional claim, decided once). */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { decideSupplierSchema } from "@/procurement/lib/budget-schemas";
import { procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { decideSupplier, redactSupplier } from "@/procurement/services/supplier-service";

const STATUS: Record<string, number> = { SUPPLIER_NOT_FOUND: 404, ALREADY_DECIDED: 409, UNKNOWN: 500 };
const ROUTE = "procurement/suppliers/[supplierId]/decide";

export async function POST(req: NextRequest, { params }: { params: Promise<{ supplierId: string }> }) {
  const [g, { supplierId }] = await Promise.all([procurementGuard({ route: ROUTE, need: "settle", write: true }), params]);
  if (!g.ok) return g.response;
  const parsed = decideSupplierSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: ROUTE, userId: g.user.id, supplierId });
  return runWithTenant(g.orgId, async () => {
    const result = await decideSupplier({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", supplierId, ...parsed.data });
    if (!result.ok) return rejected(ROUTE, g.user.id, result, STATUS);
    // What the approval did to the requests waiting on this supplier, so the page can say it.
    return NextResponse.json({ supplier: redactSupplier(result.supplier, true), ordersIssued: result.conversion?.issued ?? 0, ordersFailed: result.conversion?.failed ?? 0, ordersEmailFailed: result.conversion?.sendFailed ?? 0 });
  });
}
