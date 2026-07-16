import { NextResponse } from "next/server";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmWrite, requireCrmDelete, crmErrorResponse } from "@/crm/lib/crm-route";
import { deleteStage, updateStage } from "@/crm/services/pipeline-service";

const updateStageSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    terminalOutcome: z.enum(["WON", "LOST"]).nullable().optional(),
  })
  .refine((d) => d.name !== undefined || d.terminalOutcome !== undefined, {
    message: "Provide a name or a terminalOutcome",
  });

/**
 * PATCH /api/crm/pipeline-stages/[stageId] — rename a stage / remap a terminal
 * stage's WON/LOST outcome. Write-gated (an edit, not a removal). Renaming is
 * safe by design: the deal state machine reads terminalOutcome, never the name
 * (CRM review H3); the service refuses to orphan the last WON/LOST mapping.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ stageId: string }> }) {
  const [{ error, ctx }, { stageId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;

  const body = await req.json().catch(() => null);
  const parsed = updateStageSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/pipeline-stages/[stageId]:PATCH", organizationId: ctx.organizationId, stageId });
  }

  const result = await updateStage({
    stageId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    ...parsed.data,
  });
  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ stage: result.stage });
}

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
