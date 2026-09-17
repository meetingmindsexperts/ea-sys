/** GET the product catalogue (seeded on first read); POST a new product (admin). */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { createProductSchema } from "@/procurement/lib/budget-schemas";
import { guardedRead, procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { createBudgetProduct, ensureBudgetProducts } from "@/procurement/services/budget-product-service";

export const PRODUCT_STATUS: Record<string, number> = { INVALID_SKU: 400, SKU_TAKEN: 409, CATEGORY_NOT_FOUND: 404, CATEGORY_MISMATCH: 400, PRODUCT_NOT_FOUND: 404, UNKNOWN: 500 };

export async function GET() {
  const g = await procurementGuard({ route: "procurement/products", need: "view" });
  if (!g.ok) return g.response;
  return runWithTenant(g.orgId, () => guardedRead("procurement/products", g.user.id, async () => NextResponse.json({ products: await ensureBudgetProducts(g.orgId) })));
}

export async function POST(req: NextRequest) {
  const g = await procurementGuard({ route: "procurement/products", need: "admin", write: true });
  if (!g.ok) return g.response;
  const parsed = createProductSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: "procurement/products", userId: g.user.id });
  return runWithTenant(g.orgId, async () => {
    const result = await createBudgetProduct({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", ...parsed.data });
    if (!result.ok) return rejected("procurement/products", g.user.id, result, PRODUCT_STATUS);
    return NextResponse.json({ product: result.product }, { status: 201 });
  });
}
