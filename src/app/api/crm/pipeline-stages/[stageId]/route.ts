import { NextResponse } from "next/server";
import { requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { deleteStage } from "@/crm/services/pipeline-service";

/**
 * DELETE /api/crm/pipeline-stages/[stageId]
 *
 * Refuses (409 STAGE_HAS_DEALS) while the column still holds deals. The FK is
 * Restrict, so the DB would reject it anyway — the service checks first purely so
 * the operator gets "move this stage's 4 deals first" instead of a raw P2003.
 *
 * Without this route the "org-editable pipeline" (§9 decision 3) is only half
 * delivered: you could add and reorder columns but never remove one.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ stageId: string }> }) {
  const [{ error, ctx }, { stageId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;

  const result = await deleteStage({
    stageId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
  });

  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ success: true });
}
