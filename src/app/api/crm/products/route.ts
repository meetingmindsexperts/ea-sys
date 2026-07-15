/**
 * /api/crm/products — the org's product/service catalog.
 *
 * GET (read): seeds the built-in list on first use, then lists. Prices are stripped
 * for MEMBER by redactForCaller (`price` is in FINANCIAL_KEYS, like `dealValue`).
 * POST (write): create a catalog product.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmRead, requireCrmWrite, redactForCaller, crmErrorResponse } from "@/crm/lib/crm-route";
import { ensureCrmProducts, listCrmProducts, createCrmProduct } from "@/crm/services/crm-product-service";

export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;
  try {
    await ensureCrmProducts(ctx.organizationId);
    const params = new URL(req.url).searchParams;
    const products = await listCrmProducts(ctx.organizationId, {
      includeArchived: params.get("archived") === "1",
      category: params.get("category") || undefined,
      q: params.get("q") || undefined,
    });
    return NextResponse.json({ products: redactForCaller(products, ctx) });
  } catch (err) {
    apiLogger.error({ msg: "crm/products:list-failed", organizationId: ctx.organizationId, err: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: "Could not load products" }, { status: 500 });
  }
}

const createSchema = z.object({
  name: z.string().min(1).max(200),
  sku: z.string().max(60).optional().nullable(),
  category: z.string().min(1).max(80),
  source: z.enum(["IN_HOUSE", "OUTSOURCED"]).optional(),
  price: z.number().nonnegative().max(1_000_000_000).optional(),
  priceIncludesTax: z.boolean().optional(),
  currency: z.string().min(1).max(3).optional(),
});

export async function POST(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/products:POST", organizationId: ctx.organizationId });
  }

  const result = await createCrmProduct({ ...parsed.data, organizationId: ctx.organizationId, userId: ctx.userId });
  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ product: redactForCaller(result.product, ctx) }, { status: 201 });
}
