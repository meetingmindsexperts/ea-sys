import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmRead, requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { ensureDealTypes, listDealTypes, createDealType, reorderDealTypes } from "@/crm/services/deal-type-service";

const createSchema = z.object({ name: z.string().min(1).max(100) });
const reorderSchema = z.object({ orderedIds: z.array(z.string().min(1)).min(1).max(100) });

/**
 * GET /api/crm/deal-types
 *
 * Seeds the default deal-type list on first call (so the dropdown is never empty
 * and nobody has to run a setup step); idempotent afterwards. `?includeArchived=1`
 * returns archived types too (the management screen).
 */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;
  // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
  return await runWithTenant(ctx.organizationId, async () => {

  try {
    const { searchParams } = new URL(req.url);
    const includeArchived = searchParams.get("includeArchived") === "1";
    // Seed on the default (active) view so a brand-new org gets the list; the
    // management view just reads (incl. archived).
    const dealTypes = includeArchived
      ? await listDealTypes(ctx.organizationId, true)
      : await ensureDealTypes(ctx.organizationId);
    return NextResponse.json({ dealTypes });
  } catch (err) {
    apiLogger.error({
      msg: "crm/deal-types:list-failed",
      organizationId: ctx.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load deal types" }, { status: 500 });
  }
  });
}

/** POST /api/crm/deal-types — add a deal type to the end of the list. */
export async function POST(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;
  // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
  return await runWithTenant(ctx.organizationId, async () => {

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/deal-types:POST", organizationId: ctx.organizationId });
  }

  const result = await createDealType({ organizationId: ctx.organizationId, name: parsed.data.name });
  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ dealType: result.dealType }, { status: 201 });
  });
}

/**
 * PATCH /api/crm/deal-types — reorder the whole list.
 *
 * The client sends the full ordered id list; the server re-derives sortOrder from
 * the array index (a client-supplied sortOrder is never trusted — same rule as
 * the pipeline stages + sponsors editors).
 */
export async function PATCH(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;
  // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
  return await runWithTenant(ctx.organizationId, async () => {

  const body = await req.json().catch(() => null);
  const parsed = reorderSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/deal-types:PATCH", organizationId: ctx.organizationId });
  }

  const result = await reorderDealTypes({ organizationId: ctx.organizationId, orderedIds: parsed.data.orderedIds });
  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ dealTypes: await listDealTypes(ctx.organizationId, true) });
  });
}
