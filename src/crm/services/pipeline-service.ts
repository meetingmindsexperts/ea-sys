/**
 * CRM pipeline-stage service.
 *
 * The pipeline is a TABLE, not an enum (§9 decision 3), because sales WILL change
 * its mind and that must be a row edit rather than a migration against a live DB.
 *
 * The cost of that choice is that a stageId becomes user-supplied input on every
 * deal write and every kanban drag — i.e. an IDOR surface. `resolveStage()` below
 * is the one place that turns an untrusted stage id into a trusted stage, and it
 * always binds to the caller's org. Nothing else in the CRM should look a stage up
 * by bare id.
 */
import { Prisma, type CrmPipelineStage } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

/**
 * The seed pipeline (§9 decision 3). Won/Lost are terminal — a deal in a terminal
 * stage has a matching CrmDeal.status, and closeDeal() keeps the two in step.
 */
export const DEFAULT_PIPELINE_STAGES: ReadonlyArray<{ name: string; isTerminal: boolean }> = [
  { name: "Prospect", isTerminal: false },
  { name: "Contacted", isTerminal: false },
  { name: "Proposal", isTerminal: false },
  { name: "Negotiation", isTerminal: false },
  { name: "Won", isTerminal: true },
  { name: "Lost", isTerminal: true },
];

export type PipelineErrorCode = "STAGE_NOT_FOUND" | "STAGE_HAS_DEALS" | "NAME_REQUIRED" | "UNKNOWN";

/**
 * Idempotently ensure the org has a pipeline. Safe to call on every board load:
 * once stages exist it is a single indexed read.
 *
 * Deliberately does NOT re-seed if the org has deleted a default stage — the
 * presence of ANY stage means the org owns its pipeline, and helpfully
 * resurrecting "Negotiation" every time someone deletes it would be maddening.
 */
export async function ensurePipelineStages(organizationId: string): Promise<CrmPipelineStage[]> {
  const existing = await db.crmPipelineStage.findMany({
    where: { organizationId },
    orderBy: { sortOrder: "asc" },
  });
  if (existing.length > 0) return existing;

  try {
    await db.crmPipelineStage.createMany({
      data: DEFAULT_PIPELINE_STAGES.map((s, i) => ({
        organizationId,
        name: s.name,
        sortOrder: i,
        isTerminal: s.isTerminal,
      })),
      skipDuplicates: true,
    });
    apiLogger.info({ msg: "crm-pipeline:seeded", organizationId, count: DEFAULT_PIPELINE_STAGES.length });
  } catch (err) {
    // Two concurrent first-loads can both try to seed. Losing that race is
    // harmless — re-read below and use whatever landed.
    apiLogger.warn({
      msg: "crm-pipeline:seed-race",
      organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return db.crmPipelineStage.findMany({
    where: { organizationId },
    orderBy: { sortOrder: "asc" },
  });
}

/**
 * Turn an UNTRUSTED stage id into a trusted stage, bound to the caller's org.
 *
 * Every path that accepts a stageId from a request body or a drag payload must
 * go through here. Returns null when the stage does not exist *in this org* —
 * callers map that to a 404/400, never to "stage not found in some other org",
 * which would confirm its existence.
 */
export async function resolveStage(
  stageId: string,
  organizationId: string,
): Promise<CrmPipelineStage | null> {
  return db.crmPipelineStage.findFirst({ where: { id: stageId, organizationId } });
}

export async function createStage(input: {
  organizationId: string;
  name: string;
  isTerminal?: boolean;
}): Promise<
  { ok: true; stage: CrmPipelineStage } | { ok: false; code: PipelineErrorCode; message: string }
> {
  const name = input.name?.trim() ?? "";
  if (!name) return { ok: false, code: "NAME_REQUIRED", message: "Stage name is required" };

  try {
    // Compute the next sortOrder inside a transaction so two concurrent adds
    // can't both claim the same slot (the sortOrder race from the certificates
    // review, H3 — same fix).
    const stage = await db.$transaction(async (tx) => {
      const agg = await tx.crmPipelineStage.aggregate({
        where: { organizationId: input.organizationId },
        _max: { sortOrder: true },
      });
      return tx.crmPipelineStage.create({
        data: {
          organizationId: input.organizationId,
          name,
          sortOrder: (agg._max.sortOrder ?? -1) + 1,
          isTerminal: input.isTerminal ?? false,
        },
      });
    });

    apiLogger.info({ msg: "crm-pipeline:stage-created", stageId: stage.id, organizationId: input.organizationId });
    return { ok: true, stage };
  } catch (err) {
    apiLogger.error({
      msg: "crm-pipeline:stage-create-failed",
      organizationId: input.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not create the stage" };
  }
}

/**
 * Reorder the whole pipeline in one atomic write. The client sends the full
 * ordered id list; we re-derive sortOrder from the array index (never trusting a
 * client-supplied sortOrder), and every id is bound to the org.
 */
export async function reorderStages(input: {
  organizationId: string;
  orderedStageIds: string[];
}): Promise<{ ok: true; stages: CrmPipelineStage[] } | { ok: false; code: PipelineErrorCode; message: string }> {
  try {
    const owned = await db.crmPipelineStage.findMany({
      where: { id: { in: input.orderedStageIds }, organizationId: input.organizationId },
      select: { id: true },
    });
    if (owned.length !== input.orderedStageIds.length) {
      apiLogger.warn({
        msg: "crm-pipeline:reorder-unknown-stage",
        organizationId: input.organizationId,
        requested: input.orderedStageIds.length,
        owned: owned.length,
      });
      return { ok: false, code: "STAGE_NOT_FOUND", message: "One or more stages were not found" };
    }

    await db.$transaction(
      input.orderedStageIds.map((id, i) =>
        db.crmPipelineStage.update({ where: { id }, data: { sortOrder: i } }),
      ),
    );

    apiLogger.info({ msg: "crm-pipeline:reordered", organizationId: input.organizationId });
    return {
      ok: true,
      stages: await db.crmPipelineStage.findMany({
        where: { organizationId: input.organizationId },
        orderBy: { sortOrder: "asc" },
      }),
    };
  } catch (err) {
    apiLogger.error({
      msg: "crm-pipeline:reorder-failed",
      organizationId: input.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not reorder the pipeline" };
  }
}

/**
 * Delete a stage. REFUSES if the stage still holds deals — the FK is Restrict, so
 * the DB would reject it anyway, but we check first to return a useful message
 * ("move its 4 deals first") instead of a raw P2003.
 */
export async function deleteStage(input: {
  organizationId: string;
  stageId: string;
}): Promise<{ ok: true } | { ok: false; code: PipelineErrorCode; message: string; meta?: Record<string, unknown> }> {
  const stage = await resolveStage(input.stageId, input.organizationId);
  if (!stage) {
    apiLogger.warn({ msg: "crm-pipeline:delete-not-found", stageId: input.stageId, organizationId: input.organizationId });
    return { ok: false, code: "STAGE_NOT_FOUND", message: "Stage not found" };
  }

  const dealCount = await db.crmDeal.count({ where: { stageId: stage.id } });
  if (dealCount > 0) {
    apiLogger.warn({ msg: "crm-pipeline:delete-blocked-has-deals", stageId: stage.id, dealCount });
    return {
      ok: false,
      code: "STAGE_HAS_DEALS",
      message: `Move this stage's ${dealCount} deal${dealCount === 1 ? "" : "s"} to another stage before deleting it`,
      meta: { dealCount },
    };
  }

  try {
    await db.crmPipelineStage.delete({ where: { id: stage.id } });
    apiLogger.info({ msg: "crm-pipeline:stage-deleted", stageId: stage.id, organizationId: input.organizationId });
    return { ok: true };
  } catch (err) {
    // A deal could have been dropped into the stage between the count and the
    // delete. The Restrict FK catches it; we translate rather than 500.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
      apiLogger.warn({ msg: "crm-pipeline:delete-raced-a-deal", stageId: stage.id });
      return {
        ok: false,
        code: "STAGE_HAS_DEALS",
        message: "A deal was moved into this stage — reload and try again",
      };
    }
    apiLogger.error({
      msg: "crm-pipeline:stage-delete-failed",
      stageId: stage.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not delete the stage" };
  }
}
