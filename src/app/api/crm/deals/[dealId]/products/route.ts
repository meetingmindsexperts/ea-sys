/**
 * /api/crm/deals/[dealId]/products — a deal's line items (products).
 *
 * GET list, POST add, PATCH edit a line (qty / unit price), DELETE remove a line.
 * The deal's Value stays MANUAL — these are the itemization. `unitPrice` is stripped
 * for MEMBER by redactForCaller. Mirrors the deal-contacts route shape.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmRead, requireCrmWrite, redactForCaller, crmErrorResponse } from "@/crm/lib/crm-route";
import { listDealProducts, addDealProduct, updateDealProduct, removeDealProduct } from "@/crm/services/crm-product-service";

export async function GET(req: Request, { params }: { params: Promise<{ dealId: string }> }) {
  const [{ error, ctx }, { dealId }] = await Promise.all([requireCrmRead(req), params]);
  if (error) return error;
  try {
    const lines = await listDealProducts(dealId, ctx.organizationId);
    if (lines === null) {
      // R2-M11: this inline null-check bypasses the crmErrorResponse choke point,
      // so it must log its own not-found — it was the ONE silent failure path in
      // the 31 CRM routes.
      apiLogger.warn({ msg: "crm/deal-products:deal-not-found", dealId, organizationId: ctx.organizationId });
      return NextResponse.json({ error: "Deal not found" }, { status: 404 });
    }
    return NextResponse.json({ lines: redactForCaller(lines, ctx) });
  } catch (err) {
    apiLogger.error({ msg: "crm/deal-products:list-failed", dealId, err: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: "Could not load line items" }, { status: 500 });
  }
}

const addSchema = z.object({
  crmProductId: z.string().min(1),
  unitPrice: z.number().nonnegative().max(1_000_000_000).optional(),
  quantity: z.number().int().min(1).max(100_000).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ dealId: string }> }) {
  const [{ error, ctx }, { dealId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;
  const body = await req.json().catch(() => null);
  const parsed = addSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed, { route: "crm/deal-products:POST", organizationId: ctx.organizationId });

  const result = await addDealProduct({ ...parsed.data, dealId, organizationId: ctx.organizationId, userId: ctx.userId });
  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ line: redactForCaller(result.line, ctx) }, { status: 201 });
}

const patchSchema = z.object({
  lineId: z.string().min(1),
  unitPrice: z.number().nonnegative().max(1_000_000_000).optional(),
  quantity: z.number().int().min(1).max(100_000).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ dealId: string }> }) {
  const [{ error, ctx }, { dealId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed, { route: "crm/deal-products:PATCH", organizationId: ctx.organizationId });

  const { lineId, ...fields } = parsed.data;
  const result = await updateDealProduct({ ...fields, lineId, dealId, organizationId: ctx.organizationId });
  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ line: redactForCaller(result.line, ctx) });
}

const deleteSchema = z.object({ lineId: z.string().min(1) });

export async function DELETE(req: Request, { params }: { params: Promise<{ dealId: string }> }) {
  const [{ error, ctx }, { dealId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;
  const body = await req.json().catch(() => null);
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed, { route: "crm/deal-products:DELETE", organizationId: ctx.organizationId });

  const result = await removeDealProduct({ lineId: parsed.data.lineId, dealId, organizationId: ctx.organizationId, userId: ctx.userId });
  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ ok: true });
}
