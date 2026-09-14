/** PATCH a product: rename, move to another category, archive or restore (admin). */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { patchProductSchema } from "@/procurement/lib/budget-schemas";
import { procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { updateBudgetProduct } from "@/procurement/services/budget-product-service";

const STATUS: Record<string, number> = { INVALID_SKU: 400, SKU_TAKEN: 409, CATEGORY_NOT_FOUND: 404, PRODUCT_NOT_FOUND: 404, UNKNOWN: 500 };

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ productId: string }> }) {
  const [g, { productId }] = await Promise.all([procurementGuard({ route: "procurement/products/[productId]", need: "admin", write: true }), params]);
  if (!g.ok) return g.response;
  const parsed = patchProductSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: "procurement/products/[productId]", userId: g.user.id, productId });
  return runWithTenant(g.orgId, async () => {
    const result = await updateBudgetProduct({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", productId, ...parsed.data });
    if (!result.ok) return rejected("procurement/products/[productId]", g.user.id, result, STATUS);
    return NextResponse.json({ product: result.product });
  });
}
