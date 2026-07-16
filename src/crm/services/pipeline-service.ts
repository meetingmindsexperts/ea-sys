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
import { Prisma, type CrmPipelineStage, type CrmStageOutcome } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

/**
 * Fire-and-forget WITH a logged catch — an audit-insert blip must never 500 a
 * write that already committed (the M13 class from the registrations review).
 *
 * Pipeline edits ARE audited: the stage list is the shape of the sales process,
 * and "who deleted Negotiation, and when?" is exactly the question you ask after
 * a quarter's numbers look wrong. (The contacts review, M2, flagged us for
 * auditing only 2 of 9 mutation paths. Not repeating that here.)
 */
function writeAudit(entry: {
  userId: string | null;
  action: string;
  entityId: string;
  changes: Record<string, unknown>;
}) {
  return db.auditLog
    .create({
      data: {
        userId: entry.userId,
        action: entry.action,
        entityType: "CrmPipelineStage",
        entityId: entry.entityId,
        changes: entry.changes as Prisma.InputJsonValue,
      },
    })
    .catch((err: unknown) => {
      apiLogger.error({
        msg: "crm-pipeline:audit-failed",
        entityId: entry.entityId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
}

/**
 * The seed pipeline (§9 decision 3). Won/Lost are terminal, and each terminal
 * stage carries a `terminalOutcome` — the deal status it maps a card to.
 *
 * The OUTCOME lives on the row, not in the name (CRM review H3): closeDeal()
 * finds its landing column by `terminalOutcome`, and the stage-move state machine
 * reads the same column. Renaming "Won" to anything at all no longer breaks
 * drag-to-close. The names stay unique per org (`@@unique([organizationId, name])`)
 * because the board and the reconcile planner still look stages up by name.
 */
export const DEFAULT_PIPELINE_STAGES: ReadonlyArray<{
  name: string;
  isTerminal: boolean;
  terminalOutcome: CrmStageOutcome | null;
}> = [
  { name: "New", isTerminal: false, terminalOutcome: null },
  { name: "Proposal", isTerminal: false, terminalOutcome: null },
  { name: "Negotiation", isTerminal: false, terminalOutcome: null },
  { name: "Contract Signed", isTerminal: false, terminalOutcome: null },
  { name: "Purchase Order", isTerminal: false, terminalOutcome: null },
  { name: "Invoice Sent", isTerminal: false, terminalOutcome: null },
  { name: "Won", isTerminal: true, terminalOutcome: "WON" },
  { name: "Lost", isTerminal: true, terminalOutcome: "LOST" },
];

/**
 * Best-effort outcome for a stage created WITHOUT an explicit terminalOutcome —
 * an org adding a column called "Closed Won" obviously means WON. Used only at
 * stage-creation time (and mirrored by the migration backfill); the runtime deal
 * state machine reads the stored column, never the name.
 */
export function deriveStageOutcome(name: string): CrmStageOutcome | null {
  const n = name.trim().toLowerCase();
  if (n === "won" || n === "closed won") return "WON";
  if (n === "lost" || n === "closed lost") return "LOST";
  return null;
}

export type PipelineErrorCode =
  | "STAGE_NOT_FOUND"
  | "STAGE_HAS_DEALS"
  | "NAME_REQUIRED"
  | "NAME_TAKEN"
  | "LAST_TERMINAL_STAGE"
  | "UNKNOWN";

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
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  if (existing.length > 0) return existing;

  try {
    await db.crmPipelineStage.createMany({
      data: DEFAULT_PIPELINE_STAGES.map((s, i) => ({
        organizationId,
        name: s.name,
        sortOrder: i,
        isTerminal: s.isTerminal,
        terminalOutcome: s.terminalOutcome,
      })),
      // Real, not decorative: @@unique([organizationId, name]) backs this, so when
      // two concurrent first-loads both pass the count===0 fast-path the second
      // createMany skips every row instead of inserting a duplicate pipeline
      // (CRM review H1 — skipDuplicates without a unique constraint skips nothing).
      skipDuplicates: true,
    });
    apiLogger.info({ msg: "crm-pipeline:seeded", organizationId, count: DEFAULT_PIPELINE_STAGES.length });
  } catch (err) {
    // Anything else that raced us is settled by the re-read below.
    apiLogger.warn({
      msg: "crm-pipeline:seed-race",
      organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return db.crmPipelineStage.findMany({
    where: { organizationId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
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
  userId: string | null;
  name: string;
  isTerminal?: boolean;
  /** Explicit outcome for a terminal stage; defaults from the name ("Closed Won" → WON). */
  terminalOutcome?: CrmStageOutcome | null;
}): Promise<
  { ok: true; stage: CrmPipelineStage } | { ok: false; code: PipelineErrorCode; message: string }
> {
  const name = input.name?.trim() ?? "";
  if (!name) {
    apiLogger.warn({ msg: "crm-pipeline:create-name-required", organizationId: input.organizationId });
    return { ok: false, code: "NAME_REQUIRED", message: "Stage name is required" };
  }

  const isTerminal = input.isTerminal ?? false;
  const terminalOutcome = isTerminal ? (input.terminalOutcome ?? deriveStageOutcome(name)) : null;

  try {
    // NOTE this transaction does NOT serialize concurrent adds — under READ
    // COMMITTED both racers can read the same _max and insert the same slot (an
    // aggregate takes no lock). A duplicate sortOrder is tolerable: the list reads
    // order by [sortOrder, createdAt], so ties render deterministically. What IS
    // hard-guarded is the name: @@unique([organizationId, name]) → P2002 below.
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
          isTerminal,
          terminalOutcome,
        },
      });
    });

    void writeAudit({
      userId: input.userId,
      action: "CREATE",
      entityId: stage.id,
      changes: { name: stage.name, sortOrder: stage.sortOrder, isTerminal: stage.isTerminal, terminalOutcome: stage.terminalOutcome },
    });

    apiLogger.info({ msg: "crm-pipeline:stage-created", stageId: stage.id, organizationId: input.organizationId });
    return { ok: true, stage };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // A second "Won" (or any duplicate name) would make every name-keyed lookup
      // (board rendering, the reconcile planner) pick one arbitrarily.
      apiLogger.warn({ msg: "crm-pipeline:stage-name-taken", organizationId: input.organizationId, name });
      return { ok: false, code: "NAME_TAKEN", message: "A stage with that name already exists" };
    }
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
  userId: string | null;
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

    void writeAudit({
      userId: input.userId,
      action: "REORDER",
      entityId: `org:${input.organizationId}`,
      changes: { orderedStageIds: input.orderedStageIds },
    });

    apiLogger.info({ msg: "crm-pipeline:reordered", organizationId: input.organizationId });
    return {
      ok: true,
      stages: await db.crmPipelineStage.findMany({
        where: { organizationId: input.organizationId },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
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
  userId: string | null;
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

  // Never delete the LAST stage mapped to an outcome (CRM review H3): with no
  // WON-mapped column, closeDeal() has nowhere to land a won deal and refuses —
  // the org would lose the ability to close deals with one errant click.
  if (stage.terminalOutcome) {
    const siblings = await db.crmPipelineStage.count({
      where: { organizationId: input.organizationId, terminalOutcome: stage.terminalOutcome, id: { not: stage.id } },
    });
    if (siblings === 0) {
      apiLogger.warn({ msg: "crm-pipeline:delete-blocked-last-terminal", stageId: stage.id, outcome: stage.terminalOutcome });
      return {
        ok: false,
        code: "LAST_TERMINAL_STAGE",
        message: `This is the only ${stage.terminalOutcome === "WON" ? "Won" : "Lost"} column — deals could no longer be closed ${stage.terminalOutcome.toLowerCase()}. Add a replacement first.`,
        meta: { terminalOutcome: stage.terminalOutcome },
      };
    }
  }

  try {
    await db.crmPipelineStage.delete({ where: { id: stage.id } });

    void writeAudit({
      userId: input.userId,
      action: "DELETE",
      entityId: stage.id,
      // Snapshot the deleted row — after the delete there is nothing left to
      // diff against, so the audit entry IS the only record it ever existed.
      changes: { name: stage.name, sortOrder: stage.sortOrder, isTerminal: stage.isTerminal, terminalOutcome: stage.terminalOutcome },
    });

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
