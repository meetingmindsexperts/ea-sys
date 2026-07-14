import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmRead, requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { ensurePipelineStages, createStage, reorderStages } from "@/crm/services/pipeline-service";

const createStageSchema = z.object({
  name: z.string().min(1).max(100),
  isTerminal: z.boolean().optional(),
});

const reorderSchema = z.object({
  orderedStageIds: z.array(z.string().min(1)).min(1).max(50),
});

/**
 * GET /api/crm/pipeline-stages
 *
 * Seeds the default pipeline on first call, so an org never sees an empty board
 * and nobody has to remember to run a setup step. Idempotent: once stages exist
 * this is a single indexed read.
 */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;

  try {
    const stages = await ensurePipelineStages(ctx.organizationId);
    return NextResponse.json({ stages });
  } catch (err) {
    apiLogger.error({
      msg: "crm/pipeline-stages:list-failed",
      organizationId: ctx.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load the pipeline" }, { status: 500 });
  }
}

/** POST /api/crm/pipeline-stages — add a stage to the end of the pipeline. */
export async function POST(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;

  const body = await req.json().catch(() => null);
  const parsed = createStageSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/pipeline-stages:POST", organizationId: ctx.organizationId });
  }

  const result = await createStage({ organizationId: ctx.organizationId, userId: ctx.userId, ...parsed.data });
  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ stage: result.stage }, { status: 201 });
}

/**
 * PATCH /api/crm/pipeline-stages — reorder the whole pipeline.
 *
 * The client sends the full ordered id list; the server re-derives sortOrder from
 * the array index. A client-supplied sortOrder is never trusted (the same rule
 * the sponsors editor follows).
 */
export async function PATCH(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;

  const body = await req.json().catch(() => null);
  const parsed = reorderSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/pipeline-stages:PATCH", organizationId: ctx.organizationId });
  }

  const result = await reorderStages({
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    orderedStageIds: parsed.data.orderedStageIds,
  });
  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ stages: result.stages });
}
