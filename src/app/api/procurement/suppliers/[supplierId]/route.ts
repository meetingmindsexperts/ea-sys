/** GET one supplier (classified fields redacted per caller); PATCH edits it (settle grant, optimistic lock). */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { canViewSupplierFinancials } from "@/lib/procurement-visibility";
import { updateSupplierSchema } from "@/procurement/lib/budget-schemas";
import { guardedRead, procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { getSupplier, redactSupplier, updateSupplier } from "@/procurement/services/supplier-service";

const STATUS: Record<string, number> = { INVALID_CODE: 400, CODE_TAKEN: 409, SUPPLIER_NOT_FOUND: 404, ALREADY_DECIDED: 409, STALE_WRITE: 409, UNKNOWN: 500 };
const ROUTE = "procurement/suppliers/[supplierId]";
type Params = { params: Promise<{ supplierId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const [g, { supplierId }] = await Promise.all([procurementGuard({ route: ROUTE, need: "view" }), params]);
  if (!g.ok) return g.response;
  const canSee = canViewSupplierFinancials(g.user);
  return runWithTenant(g.orgId, () => guardedRead(ROUTE, g.user.id, async () => {
    const result = await getSupplier(g.orgId, supplierId);
    if (!result.ok) return rejected(ROUTE, g.user.id, result, STATUS);
    return NextResponse.json({ supplier: redactSupplier(result.supplier, canSee) });
  }));
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const [g, { supplierId }] = await Promise.all([procurementGuard({ route: ROUTE, need: "settle", write: true }), params]);
  if (!g.ok) return g.response;
  const parsed = updateSupplierSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: ROUTE, userId: g.user.id, supplierId });
  return runWithTenant(g.orgId, async () => {
    const result = await updateSupplier({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", supplierId, ...parsed.data });
    if (!result.ok) return rejected(ROUTE, g.user.id, result, STATUS);
    return NextResponse.json({ supplier: redactSupplier(result.supplier, true) });
  });
}
