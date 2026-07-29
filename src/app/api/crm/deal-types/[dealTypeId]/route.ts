import { NextResponse } from "next/server";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { updateDealType } from "@/crm/services/deal-type-service";

const updateSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    /** Soft delete (true) / restore (false) — archived types drop out of the picker. */
    archived: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.archived !== undefined, { message: "Nothing to update" });

/** PATCH /api/crm/deal-types/[dealTypeId] — rename and/or archive/restore. */
export async function PATCH(req: Request, { params }: { params: Promise<{ dealTypeId: string }> }) {
  const [{ error, ctx }, { dealTypeId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;

  const body = await req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/deal-types/[dealTypeId]:PATCH", organizationId: ctx.organizationId, dealTypeId });
  }

  const result = await updateDealType({
    dealTypeId,
    organizationId: ctx.organizationId,
    name: parsed.data.name,
    archived: parsed.data.archived,
  });
  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ dealType: result.dealType });
}
