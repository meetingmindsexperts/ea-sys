import { NextResponse } from "next/server";
import { requireCrmDelete, crmErrorResponse } from "@/crm/lib/crm-route";
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
 *
 * Delete-gated, not write-gated (CRM review M8): removing a pipeline column is an
 * org-wide, irreversible config change — it must not sit at a LOOSER gate than
 * archiving a single deal. ORGANIZER may add/reorder stages but not remove one.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ stageId: string }> }) {
  const [{ error, ctx }, { stageId }] = await Promise.all([requireCrmDelete(req), params]);
  if (error) return error;

  const result = await deleteStage({
    stageId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
  });

  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ success: true });
}
