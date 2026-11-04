/**
 * PUT /api/crm/products/[productId]/quickbooks: link a catalogue product to a
 * QuickBooks product/service, or unlink it with `itemId: null` (Nov 4, 2026).
 * A quote line posts to its product's link, so every product a sponsor buys
 * needs one before its quote can be sent.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { linkProductToItem } from "@/crm/services/crm-quickbooks-service";

const schema = z.object({ itemId: z.string().min(1).max(40).nullable() });

export async function PUT(req: Request, { params }: { params: Promise<{ productId: string }> }) {
  const [{ error, ctx }, { productId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    const parsed = schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return zodErrorResponse(parsed, { route: "crm/products/quickbooks:PUT", organizationId: ctx.organizationId, productId });

    const result = await linkProductToItem({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      source: ctx.fromApiKey ? "api" : "rest",
      productId,
      itemId: parsed.data.itemId,
    });
    if (!result.ok) return crmErrorResponse(result);
    return NextResponse.json({ product: result.product });
  });
}
