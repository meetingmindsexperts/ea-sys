/**
 * /api/crm/products/[productId] — edit / archive / restore one catalog product.
 *
 * PATCH edits (write-gated) OR restores (`archived:false`, delete-gated). DELETE
 * archives (soft delete, delete-gated: admin + CRM_USER — an ORGANIZER may edit but
 * not archive). Prices stripped for MEMBER by redactForCaller.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmWrite, requireCrmDelete, denyCrmDelete, redactForCaller, crmErrorResponse } from "@/crm/lib/crm-route";
import { updateCrmProduct, setCrmProductArchived } from "@/crm/services/crm-product-service";

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  sku: z.string().max(60).nullable().optional(),
  category: z.string().min(1).max(80).optional(),
  source: z.enum(["IN_HOUSE", "OUTSOURCED"]).optional(),
  price: z.number().nonnegative().max(1_000_000_000).optional(),
  priceIncludesTax: z.boolean().optional(),
  currency: z.string().min(1).max(3).optional(),
  archived: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ productId: string }> }) {
  const [{ error, ctx }, { productId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/products/[productId]:PATCH", organizationId: ctx.organizationId });
  }

  const { archived, ...fields } = parsed.data;

  if (archived !== undefined) {
    const denied = denyCrmDelete(ctx);
    if (denied) return denied;
    const result = await setCrmProductArchived({ productId, organizationId: ctx.organizationId, userId: ctx.userId, archived });
    if (!result.ok) return crmErrorResponse(result);
    return NextResponse.json({ product: redactForCaller(result.product, ctx) });
  }

  const result = await updateCrmProduct({ ...fields, productId, organizationId: ctx.organizationId, userId: ctx.userId });
  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ product: redactForCaller(result.product, ctx) });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ productId: string }> }) {
  const [{ error, ctx }, { productId }] = await Promise.all([requireCrmDelete(req), params]);
  if (error) return error;

  const result = await setCrmProductArchived({ productId, organizationId: ctx.organizationId, userId: ctx.userId, archived: true });
  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ product: redactForCaller(result.product, ctx) });
}
