/**
 * CRM deal service — the sponsorship pipeline.
 *
 * This is the important one. Two things here are load-bearing:
 *
 * 1. THE STAGE MOVE IS A CONDITIONAL CLAIM, NOT A WRITE.
 *    A kanban board is the most concurrent surface in the product: two people
 *    have the board open, both drag the same card, both releases fire. A naive
 *    `update({ where: { id } , data: { stageId }})` lets the LAST write win
 *    silently — the first person's move vanishes with no error, and if the moves
 *    were to different stages the card lands somewhere nobody chose.
 *
 *    So `moveDealStage()` takes the stage the mover BELIEVED the card was in and
 *    makes it a precondition of the write (`updateMany where { id, stageId:
 *    fromStageId }`). Zero rows affected = someone else got there first; the
 *    loser gets 409 STAGE_CHANGED and the UI rolls its optimistic move back.
 *    Same shape as the check-in claim and the abstract-status claim — this
 *    codebase has been bitten by check-then-act enough times to have a house
 *    pattern, and this is it.
 *
 * 2. STAGE IDS ARE UNTRUSTED INPUT.
 *    Because the pipeline is org-configurable (§9 d3), a stageId arrives from the
 *    client on every create and every move. Every one is resolved through
 *    `resolveStage(id, organizationId)` before use, so a stage id belonging to
 *    another org can never be written onto this org's deal.
 *
 * Conventions: src/services/README.md.
 */
import { Prisma, type CrmDeal, type CrmDealStatus, type CrmDealContactRole, type CrmStageOutcome } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { recordCrmActivity, diffFields } from "@/crm/lib/crm-activity";
import { notifyCrmUser } from "@/crm/lib/crm-notifications";
import { resolveStage } from "./pipeline-service";

/** Fields worth showing in the change log when a deal is edited. */
const DEAL_DIFF_KEYS = ["name", "dealValue", "currency", "expectedClose", "companyId", "eventId", "ownerId"] as const;

// ── Types ────────────────────────────────────────────────────────────────────

export interface CreateDealInput {
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api";
  requestIp?: string;

  name: string;
  stageId: string;
  companyId?: string | null;
  /**
   * THE differentiator — ties the deal to the event (project) it is being sold
   * against. REQUIRED on create (owner decision, July 15): a sponsorship deal that
   * isn't against a project is meaningless. The DB column stays nullable so the deal
   * survives its event being deleted (onDelete: SetNull); the requirement is enforced
   * here at create/edit, not as a NOT-NULL constraint.
   */
  eventId: string;
  ownerId?: string | null;
  dealValue?: number | null;
  currency?: string;
  expectedClose?: Date | null;
}

export interface UpdateDealInput {
  dealId: string;
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api";
  requestIp?: string;

  name?: string;
  companyId?: string | null;
  eventId?: string | null;
  ownerId?: string | null;
  dealValue?: number | null;
  currency?: string;
  expectedClose?: Date | null;
}

export interface MoveDealStageInput {
  dealId: string;
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api";
  /** The stage the caller BELIEVED the deal was in — the concurrency precondition. */
  fromStageId: string;
  toStageId: string;
}

export interface CloseDealInput {
  dealId: string;
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api";
  outcome: "WON" | "LOST";
  lostReason?: string | null;
}

export type DealErrorCode =
  | "NAME_REQUIRED"
  | "EVENT_REQUIRED"
  | "DEAL_NOT_FOUND"
  | "DEAL_ARCHIVED"
  | "STAGE_NOT_FOUND"
  | "NO_TERMINAL_STAGE"
  | "COMPANY_NOT_FOUND"
  | "CONTACT_NOT_FOUND"
  | "CONTACT_ALREADY_ON_DEAL"
  | "EVENT_NOT_FOUND"
  | "OWNER_NOT_FOUND"
  | "STAGE_CHANGED"
  | "ALREADY_CLOSED"
  | "NO_FIELDS"
  | "UNKNOWN";

type Fail = { ok: false; code: DealErrorCode; message: string; meta?: Record<string, unknown> };
export type CreateDealResult = { ok: true; deal: CrmDeal } | Fail;
export type UpdateDealResult = { ok: true; deal: CrmDeal } | Fail;
export type MoveDealStageResult = { ok: true; deal: CrmDeal } | Fail;
export type CloseDealResult = { ok: true; deal: CrmDeal } | Fail;

// ── Relation validation ──────────────────────────────────────────────────────

/**
 * Every relation id on a deal arrives from the client. Each is bound to the
 * caller's org before it is written — an unbound nested id straight from the
 * request body is this codebase's single most-repeated IDOR (accommodation H1,
 * invoices H9, contacts H1).
 */
async function validateRelations(
  organizationId: string,
  rel: { companyId?: string | null; eventId?: string | null; ownerId?: string | null },
): Promise<Fail | null> {
  const checks: Array<Promise<Fail | null>> = [];

  if (rel.companyId) {
    checks.push(
      db.crmCompany
        .findFirst({ where: { id: rel.companyId, organizationId }, select: { id: true } })
        .then((r) => (r ? null : ({ ok: false, code: "COMPANY_NOT_FOUND", message: "Company not found" } as Fail))),
    );
  }
  if (rel.eventId) {
    checks.push(
      db.event
        .findFirst({ where: { id: rel.eventId, organizationId }, select: { id: true } })
        .then((r) => (r ? null : ({ ok: false, code: "EVENT_NOT_FOUND", message: "Event not found" } as Fail))),
    );
  }
  if (rel.ownerId) {
    // The owner must be a team member of THIS org. (Role is enforced at the
    // route boundary via canOwnDeals(); here we enforce tenancy.)
    checks.push(
      db.user
        .findFirst({ where: { id: rel.ownerId, organizationId }, select: { id: true } })
        .then((r) => (r ? null : ({ ok: false, code: "OWNER_NOT_FOUND", message: "Owner not found in this organization" } as Fail))),
    );
  }

  const results = await Promise.all(checks);
  return results.find((r) => r !== null) ?? null;
}

// ── Create ───────────────────────────────────────────────────────────────────

export async function createDeal(input: CreateDealInput): Promise<CreateDealResult> {
  const name = input.name?.trim() ?? "";
  if (!name) return { ok: false, code: "NAME_REQUIRED", message: "Deal name is required" };

  // A deal must be sold against a project (event) — the reason this pipeline exists
  // rather than a generic CRM. Enforced here so every create path (not just the
  // dialog) honours it.
  if (!input.eventId) {
    return { ok: false, code: "EVENT_REQUIRED", message: "Select the event (project) this deal is for" };
  }

  const stage = await resolveStage(input.stageId, input.organizationId);
  if (!stage) {
    apiLogger.warn({ msg: "crm-deal:create-unknown-stage", stageId: input.stageId, organizationId: input.organizationId });
    return { ok: false, code: "STAGE_NOT_FOUND", message: "Pipeline stage not found" };
  }

  const relFail = await validateRelations(input.organizationId, input);
  if (relFail) {
    apiLogger.warn({ msg: "crm-deal:create-bad-relation", code: relFail.code, organizationId: input.organizationId });
    return relFail;
  }

  try {
    const deal = await db.crmDeal.create({
      data: {
        organizationId: input.organizationId,
        name,
        stageId: stage.id,
        companyId: input.companyId ?? null,
        eventId: input.eventId ?? null,
        ownerId: input.ownerId ?? null,
        dealValue: input.dealValue ?? null,
        currency: input.currency?.trim() || "USD",
        expectedClose: input.expectedClose ?? null,
        // A deal created directly INTO a terminal stage is born closed, so the
        // stage and the status can't disagree from the very first write. The
        // outcome comes from the stage's stored terminalOutcome, never its name.
        status: stageOutcome(stage) ?? "OPEN",
        ...(stageOutcome(stage) ? closeStamps(stageOutcome(stage)) : {}),
      },
    });

    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "DEAL",
      entityId: deal.id,
      action: "CREATE",
      actorId: input.userId,
      changes: { source: input.source, name, stage: stage.name, dealValue: input.dealValue ?? null },
    });

    // Creating a deal FOR someone else assigns it to them — tell them. The
    // writer skips the self-assign case (creator === owner) internally.
    void notifyCrmUser({
      organizationId: input.organizationId,
      recipientId: deal.ownerId,
      actorId: input.userId,
      type: "DEAL_ASSIGNED",
      title: "Deal assigned to you",
      message: `You are now the owner of "${deal.name}"`,
      link: `/crm/deals/${deal.id}`,
    });

    apiLogger.info({
      msg: "crm-deal:created",
      dealId: deal.id,
      organizationId: input.organizationId,
      eventId: deal.eventId,
      source: input.source,
    });
    return { ok: true, deal };
  } catch (err) {
    apiLogger.error({
      msg: "crm-deal:create-failed",
      organizationId: input.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not create the deal" };
  }
}

// ── Update (fields only — stage moves go through moveDealStage) ───────────────

export async function updateDeal(input: UpdateDealInput): Promise<UpdateDealResult> {
  const data: Prisma.CrmDealUpdateManyMutationInput & { companyId?: string | null; eventId?: string | null; ownerId?: string | null } = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return { ok: false, code: "NAME_REQUIRED", message: "Deal name cannot be empty" };
    data.name = name;
  }
  if (input.dealValue !== undefined) data.dealValue = input.dealValue;
  if (input.currency !== undefined) data.currency = input.currency.trim() || "USD";
  if (input.expectedClose !== undefined) data.expectedClose = input.expectedClose;
  if (input.companyId !== undefined) data.companyId = input.companyId;
  if (input.eventId !== undefined) {
    // A deal must stay tied to a project — you can re-point it at another event, but
    // not clear it. (An event-less legacy deal, e.g. one whose event was deleted,
    // must be given an event on its next edit.)
    if (input.eventId === null) {
      return { ok: false, code: "EVENT_REQUIRED", message: "A deal must be linked to an event" };
    }
    data.eventId = input.eventId;
  }
  if (input.ownerId !== undefined) data.ownerId = input.ownerId;

  if (Object.keys(data).length === 0) {
    return { ok: false, code: "NO_FIELDS", message: "No fields to update" };
  }

  const relFail = await validateRelations(input.organizationId, input);
  if (relFail) {
    apiLogger.warn({ msg: "crm-deal:update-bad-relation", code: relFail.code, dealId: input.dealId });
    return relFail;
  }

  try {
    // Snapshot BEFORE the write so the change log can record real before→after
    // values, not just which field names changed. Bound to the org, so a deal id
    // from another tenant 404s here rather than being touched.
    const before = await db.crmDeal.findFirst({
      where: { id: input.dealId, organizationId: input.organizationId },
      select: { name: true, dealValue: true, currency: true, expectedClose: true, companyId: true, eventId: true, ownerId: true },
    });
    if (!before) {
      apiLogger.warn({ msg: "crm-deal:update-not-found", dealId: input.dealId, organizationId: input.organizationId });
      return { ok: false, code: "DEAL_NOT_FOUND", message: "Deal not found" };
    }

    await db.crmDeal.updateMany({
      where: { id: input.dealId, organizationId: input.organizationId },
      data,
    });

    const deal = await db.crmDeal.findUniqueOrThrow({ where: { id: input.dealId } });

    // Diff BEFORE + the submitted patch — NOT the post-write re-read (CRM review
    // M4): a concurrent writer landing between our write and a re-read would have
    // ITS change recorded under THIS actor's name in the History log. The patch
    // is what this actor actually did; diff exactly that.
    const fieldChanges = diffFields(before, { ...before, ...data } as typeof before, DEAL_DIFF_KEYS);
    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "DEAL",
      entityId: deal.id,
      action: "UPDATE",
      actorId: input.userId,
      changes: { source: input.source, ...(fieldChanges ? { changes: fieldChanges } : {}) },
    });

    // Re-assignment notifies the NEW owner only (the writer skips self-assign).
    // Compared against the pre-write snapshot so an edit that merely re-sends the
    // unchanged ownerId doesn't re-nag.
    if (input.ownerId !== undefined && input.ownerId !== null && input.ownerId !== before.ownerId) {
      void notifyCrmUser({
        organizationId: input.organizationId,
        recipientId: input.ownerId,
        actorId: input.userId,
        type: "DEAL_ASSIGNED",
        title: "Deal assigned to you",
        message: `You are now the owner of "${deal.name}"`,
        link: `/crm/deals/${deal.id}`,
      });
    }

    apiLogger.info({ msg: "crm-deal:updated", dealId: deal.id, source: input.source });
    return { ok: true, deal };
  } catch (err) {
    apiLogger.error({
      msg: "crm-deal:update-failed",
      dealId: input.dealId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not update the deal" };
  }
}

// ── Move stage — THE concurrency-critical path ───────────────────────────────

/**
 * Move a deal from one pipeline stage to another.
 *
 * The move is a CONDITIONAL CLAIM: the write only lands if the deal is still in
 * `fromStageId` — the stage the mover saw when they picked the card up. If
 * someone else moved it first, zero rows match and we return STAGE_CHANGED so the
 * UI can roll its optimistic move back and refetch, instead of silently
 * clobbering a colleague's decision.
 */
export async function moveDealStage(input: MoveDealStageInput): Promise<MoveDealStageResult> {
  // Resolve BOTH ends of the move. The from-stage's terminality decides whether
  // this drag crosses a close/reopen boundary — a move between two ordinary
  // columns must NOT touch status (CRM review H3c: it used to unconditionally
  // write status OPEN, silently reopening a divergent WON deal on a tidy-up drag).
  const [toStage, fromStage] = await Promise.all([
    resolveStage(input.toStageId, input.organizationId),
    resolveStage(input.fromStageId, input.organizationId),
  ]);
  if (!toStage) {
    apiLogger.warn({ msg: "crm-deal:move-unknown-stage", stageId: input.toStageId, organizationId: input.organizationId });
    return { ok: false, code: "STAGE_NOT_FOUND", message: "Pipeline stage not found" };
  }

  const toOutcome = stageOutcome(toStage);
  const fromOutcome = fromStage ? stageOutcome(fromStage) : null;

  // Status/stamps change ONLY when the move crosses a terminality boundary.
  let statusData: Record<string, unknown> = {};
  let reopened = false;
  if (toOutcome) {
    // Into a mapped terminal column = closing the deal. Clear a stale lostReason
    // when the outcome is WON (CRM review M10 — closeDeal already does this).
    statusData = {
      status: toOutcome,
      ...closeStamps(toOutcome),
      ...(toOutcome === "WON" ? { lostReason: null } : {}),
    };
  } else if (toStage.isTerminal) {
    // A terminal column the org hasn't mapped to WON/LOST: never invent an
    // outcome from a column name — leave the status alone, loudly.
    apiLogger.warn({
      msg: "crm-deal:terminal-stage-no-outcome",
      dealId: input.dealId,
      toStageId: toStage.id,
      toStage: toStage.name,
    });
  } else if (fromStage?.isTerminal) {
    // Out of a terminal column into an open one = reopening.
    statusData = { status: "OPEN" as CrmDealStatus, wonAt: null, lostAt: null, lostReason: null };
    // Only call it a REOPEN when the source column actually implied a close —
    // dragging an (erroneously) OPEN deal out of an unmapped terminal column
    // isn't a reopen event.
    reopened = fromOutcome !== null;
  }
  // (non-terminal → non-terminal: statusData stays empty — status untouched.)

  try {
    const claim = await db.crmDeal.updateMany({
      where: {
        id: input.dealId,
        organizationId: input.organizationId,
        stageId: input.fromStageId, // ← the precondition. This is the whole fix.
        archivedAt: null, // an archived deal is frozen — a stale board can't move it (CRM review M1)
      },
      data: {
        stageId: toStage.id,
        ...statusData,
      },
    });

    if (claim.count === 0) {
      // Distinguish "someone beat me to it" from "archived under me" from "that
      // deal doesn't exist" — they mean very different things at the board.
      const current = await db.crmDeal.findFirst({
        where: { id: input.dealId, organizationId: input.organizationId },
        select: { id: true, stageId: true, archivedAt: true },
      });

      if (!current) {
        apiLogger.warn({ msg: "crm-deal:move-not-found", dealId: input.dealId, organizationId: input.organizationId });
        return { ok: false, code: "DEAL_NOT_FOUND", message: "Deal not found" };
      }

      if (current.archivedAt) {
        apiLogger.warn({ msg: "crm-deal:move-archived", dealId: input.dealId });
        return { ok: false, code: "DEAL_ARCHIVED", message: "This deal was archived — restore it before moving it" };
      }

      apiLogger.warn({
        msg: "crm-deal:move-lost-race",
        dealId: input.dealId,
        expectedStageId: input.fromStageId,
        actualStageId: current.stageId,
      });
      return {
        ok: false,
        code: "STAGE_CHANGED",
        message: "Someone else moved this deal — reload the board",
        meta: { currentStageId: current.stageId },
      };
    }

    const deal = await db.crmDeal.findUniqueOrThrow({ where: { id: input.dealId } });

    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "DEAL",
      entityId: deal.id,
      action: "STAGE_MOVE",
      actorId: input.userId,
      changes: {
        source: input.source,
        fromStageId: input.fromStageId,
        toStageId: toStage.id,
        toStage: toStage.name,
        status: deal.status,
      },
    });
    if (reopened) {
      // An explicit trail entry for the close being undone — "why did July's won
      // number shrink?" must be answerable from the deal's History.
      void recordCrmActivity({
        organizationId: input.organizationId,
        entityType: "DEAL",
        entityId: deal.id,
        action: "REOPENED",
        actorId: input.userId,
        changes: { source: input.source, fromStage: fromStage?.name ?? null, toStage: toStage.name },
      });
    }

    // Tell the owner their deal moved — a drag into a mapped terminal column IS
    // a close, so it announces the outcome rather than a generic stage move. The
    // writer skips the case where the owner did the dragging themselves.
    void notifyCrmUser({
      organizationId: input.organizationId,
      recipientId: deal.ownerId,
      actorId: input.userId,
      type: toOutcome === "WON" ? "DEAL_WON" : toOutcome === "LOST" ? "DEAL_LOST" : "DEAL_STAGE_MOVED",
      title:
        toOutcome === "WON"
          ? "Your deal was won"
          : toOutcome === "LOST"
            ? "Your deal was closed as lost"
            : "Your deal moved stage",
      message: toOutcome
        ? `"${deal.name}" was closed as ${toOutcome.toLowerCase()}`
        : `"${deal.name}" moved to ${toStage.name}`,
      link: `/crm/deals/${deal.id}`,
    });

    apiLogger.info({
      msg: "crm-deal:stage-moved",
      dealId: deal.id,
      fromStageId: input.fromStageId,
      toStageId: toStage.id,
      status: deal.status,
      reopened,
      source: input.source,
    });
    return { ok: true, deal };
  } catch (err) {
    apiLogger.error({
      msg: "crm-deal:move-failed",
      dealId: input.dealId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not move the deal" };
  }
}

// ── Close (won / lost) ───────────────────────────────────────────────────────

/**
 * Close a deal explicitly (as opposed to dragging it into a terminal column).
 *
 * Guarded against double-close with the same conditional-claim shape: the write
 * requires the deal to still be OPEN. Re-closing an already-won deal would
 * otherwise re-stamp `wonAt`, which quietly corrupts any "deals won in July"
 * report.
 */
export async function closeDeal(input: CloseDealInput): Promise<CloseDealResult> {
  const status: CrmDealStatus = input.outcome;

  try {
    // Land it in the outcome-mapped terminal stage — matched by terminalOutcome,
    // never by name (CRM review H3: name-matching meant renaming "Won" silently
    // broke closing). Multiple stages can share an outcome; take the first by
    // board order so the landing column is deterministic.
    const terminal = await db.crmPipelineStage.findFirst({
      where: { organizationId: input.organizationId, terminalOutcome: status },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    });

    // No mapped column → REFUSE rather than close the deal in place. Closing
    // without a landing column mints a stage/status divergence: the deal counts
    // as open (it sits in an open column's report bucket) AND as won — fictional
    // pipeline money. deleteStage() guards the last mapped column, so this only
    // fires on hand-built pipelines.
    if (!terminal) {
      apiLogger.warn({ msg: "crm-deal:close-no-terminal-stage", dealId: input.dealId, outcome: status, organizationId: input.organizationId });
      return {
        ok: false,
        code: "NO_TERMINAL_STAGE",
        message: `This pipeline has no ${status === "WON" ? "Won" : "Lost"} column — add one before closing deals`,
        meta: { outcome: status },
      };
    }

    const claim = await db.crmDeal.updateMany({
      where: { id: input.dealId, organizationId: input.organizationId, status: "OPEN", archivedAt: null },
      data: {
        status,
        ...closeStamps(status),
        lostReason: status === "LOST" ? (input.lostReason?.trim() || null) : null,
        stageId: terminal.id,
      },
    });

    if (claim.count === 0) {
      const current = await db.crmDeal.findFirst({
        where: { id: input.dealId, organizationId: input.organizationId },
        select: { id: true, status: true, archivedAt: true },
      });
      if (!current) {
        apiLogger.warn({ msg: "crm-deal:close-not-found", dealId: input.dealId });
        return { ok: false, code: "DEAL_NOT_FOUND", message: "Deal not found" };
      }
      if (current.archivedAt) {
        apiLogger.warn({ msg: "crm-deal:close-archived", dealId: input.dealId });
        return { ok: false, code: "DEAL_ARCHIVED", message: "This deal was archived — restore it before closing it" };
      }
      apiLogger.warn({ msg: "crm-deal:already-closed", dealId: input.dealId, status: current.status });
      return {
        ok: false,
        code: "ALREADY_CLOSED",
        message: `This deal is already ${current.status.toLowerCase()}`,
        meta: { status: current.status },
      };
    }

    const deal = await db.crmDeal.findUniqueOrThrow({ where: { id: input.dealId } });

    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "DEAL",
      entityId: deal.id,
      action: status === "WON" ? "WON" : "LOST",
      actorId: input.userId,
      changes: {
        source: input.source,
        status,
        dealValue: deal.dealValue ? Number(deal.dealValue) : null,
        currency: deal.currency,
        ...(status === "LOST" && deal.lostReason ? { lostReason: deal.lostReason } : {}),
      },
    });

    // The owner hears about a close they didn't perform themselves. No money in
    // the message — the notification feed is deliberately value-free.
    void notifyCrmUser({
      organizationId: input.organizationId,
      recipientId: deal.ownerId,
      actorId: input.userId,
      type: status === "WON" ? "DEAL_WON" : "DEAL_LOST",
      title: status === "WON" ? "Your deal was won" : "Your deal was closed as lost",
      message: `"${deal.name}" was marked ${status.toLowerCase()}`,
      link: `/crm/deals/${deal.id}`,
    });

    apiLogger.info({ msg: "crm-deal:closed", dealId: deal.id, status, source: input.source });
    return { ok: true, deal };
  } catch (err) {
    apiLogger.error({
      msg: "crm-deal:close-failed",
      dealId: input.dealId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not close the deal" };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The deal STATUS a terminal stage implies — read from the stage's stored
 * `terminalOutcome`, never derived from its name (CRM review H3: name-keying
 * meant a renamed "Won" column silently stopped closing deals, and any stage/
 * status divergence corrupted the reports). A terminal stage with no mapped
 * outcome returns null: we never invent a close from a column name.
 */
function stageOutcome(stage: { isTerminal: boolean; terminalOutcome: CrmStageOutcome | null }): CrmDealStatus | null {
  if (!stage.isTerminal) return null;
  return stage.terminalOutcome; // "WON" | "LOST" ⊂ CrmDealStatus
}

function closeStamps(status: CrmDealStatus | null) {
  if (status === "WON") return { wonAt: new Date(), lostAt: null };
  if (status === "LOST") return { lostAt: new Date(), wonAt: null };
  // Moving a card back OUT of a terminal column reopens it — clear the stamps so
  // a reopened deal can't linger in a "won in July" report.
  return { wonAt: null, lostAt: null };
}

// ── Archive / restore (soft delete) ──────────────────────────────────────────

/**
 * Archive or restore a deal (soft delete). We never hard-delete: the row and its
 * change log survive, and an archived deal drops out of the board/reports/export
 * (the list filters exclude `archivedAt != null`).
 *
 * Idempotent: archiving an already-archived deal (or restoring an active one) is a
 * no-op success that records NOTHING, so a double-click can't spam the log or
 * re-stamp `archivedAt`. RBAC (who may archive) is enforced at the route boundary.
 */
export async function setDealArchived(input: {
  dealId: string;
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api";
  archived: boolean;
}): Promise<{ ok: true; deal: CrmDeal } | Fail> {
  try {
    const current = await db.crmDeal.findFirst({
      where: { id: input.dealId, organizationId: input.organizationId },
    });
    if (!current) {
      apiLogger.warn({ msg: "crm-deal:archive-not-found", dealId: input.dealId, organizationId: input.organizationId });
      return { ok: false, code: "DEAL_NOT_FOUND", message: "Deal not found" };
    }

    const alreadyInState = input.archived ? current.archivedAt !== null : current.archivedAt === null;
    if (alreadyInState) {
      // No-op — return the row unchanged, record nothing.
      return { ok: true, deal: current };
    }

    const deal = await db.crmDeal.update({
      where: { id: current.id },
      data: { archivedAt: input.archived ? new Date() : null },
    });

    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "DEAL",
      entityId: deal.id,
      action: input.archived ? "ARCHIVE" : "RESTORE",
      actorId: input.userId,
      // Snapshot the name + value so the log line means something even for a deal
      // that later stops being reachable in the active list.
      changes: {
        source: input.source,
        name: deal.name,
        dealValue: deal.dealValue ? Number(deal.dealValue) : null,
        currency: deal.currency,
      },
    });

    apiLogger.info({
      msg: input.archived ? "crm-deal:archived" : "crm-deal:restored",
      dealId: deal.id,
      source: input.source,
    });
    return { ok: true, deal };
  } catch (err) {
    apiLogger.error({
      msg: "crm-deal:archive-failed",
      dealId: input.dealId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not archive the deal" };
  }
}

// ── Deal ↔ contacts (the people who actually decide) ─────────────────────────

/**
 * Attach a person to a deal with the role they play ON THIS DEAL.
 *
 * A sponsorship deal is not negotiated with one human: there's the rep who wants
 * it, the marketing lead who owns the budget, and the procurement officer who can
 * veto it. The role lives on the JOIN, not on the contact, because the same rep can
 * be PRIMARY on one deal and merely INFLUENCER on another.
 *
 * Idempotent on re-add: calling again with a different role UPDATES the role rather
 * than 409-ing, which is what "set Sarah as procurement" should obviously do.
 */
export async function addDealContact(input: {
  dealId: string;
  crmContactId: string;
  role?: CrmDealContactRole;
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api";
}): Promise<{ ok: true } | Fail> {
  try {
    // Both ids come from the client. Bind BOTH to the caller's org before writing —
    // an unbound nested id is this codebase's most-repeated IDOR.
    const [deal, contact] = await Promise.all([
      db.crmDeal.findFirst({
        where: { id: input.dealId, organizationId: input.organizationId },
        select: { id: true, eventId: true, archivedAt: true },
      }),
      db.crmContact.findFirst({
        where: { id: input.crmContactId, organizationId: input.organizationId },
        select: { id: true },
      }),
    ]);

    if (!deal) {
      apiLogger.warn({ msg: "crm-deal:add-contact-deal-not-found", dealId: input.dealId });
      return { ok: false, code: "DEAL_NOT_FOUND", message: "Deal not found" };
    }
    if (deal.archivedAt) {
      apiLogger.warn({ msg: "crm-deal:add-contact-deal-archived", dealId: input.dealId });
      return { ok: false, code: "DEAL_ARCHIVED", message: "This deal was archived — restore it before adding people" };
    }
    if (!contact) {
      apiLogger.warn({ msg: "crm-deal:add-contact-not-found", crmContactId: input.crmContactId });
      return { ok: false, code: "CONTACT_NOT_FOUND", message: "Contact not found" };
    }

    await db.crmDealContact.upsert({
      where: { dealId_crmContactId: { dealId: deal.id, crmContactId: contact.id } },
      create: { dealId: deal.id, crmContactId: contact.id, role: input.role ?? "PRIMARY" },
      update: { role: input.role ?? "PRIMARY" },
    });

    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "DEAL",
      entityId: deal.id,
      action: "CONTACT_ADDED",
      actorId: input.userId,
      changes: { source: input.source, crmContactId: contact.id, role: input.role ?? "PRIMARY" },
    });

    apiLogger.info({
      msg: "crm-deal:contact-added",
      dealId: deal.id,
      crmContactId: contact.id,
      role: input.role ?? "PRIMARY",
    });
    return { ok: true };
  } catch (err) {
    apiLogger.error({
      msg: "crm-deal:add-contact-failed",
      dealId: input.dealId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not add the contact to the deal" };
  }
}

/** Detach a person from a deal. Does NOT delete the CrmContact — they still exist. */
export async function removeDealContact(input: {
  dealId: string;
  crmContactId: string;
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api";
}): Promise<{ ok: true } | Fail> {
  try {
    const deal = await db.crmDeal.findFirst({
      where: { id: input.dealId, organizationId: input.organizationId },
      select: { id: true, eventId: true },
    });
    if (!deal) {
      apiLogger.warn({ msg: "crm-deal:remove-contact-deal-not-found", dealId: input.dealId });
      return { ok: false, code: "DEAL_NOT_FOUND", message: "Deal not found" };
    }

    const res = await db.crmDealContact.deleteMany({
      where: { dealId: deal.id, crmContactId: input.crmContactId },
    });
    if (res.count === 0) {
      apiLogger.warn({
        msg: "crm-deal:remove-contact-not-on-deal",
        dealId: deal.id,
        crmContactId: input.crmContactId,
      });
      return { ok: false, code: "CONTACT_NOT_FOUND", message: "That person is not on this deal" };
    }

    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "DEAL",
      entityId: deal.id,
      action: "CONTACT_REMOVED",
      actorId: input.userId,
      changes: { source: input.source, crmContactId: input.crmContactId },
    });

    apiLogger.info({ msg: "crm-deal:contact-removed", dealId: deal.id, crmContactId: input.crmContactId });
    return { ok: true };
  } catch (err) {
    apiLogger.error({
      msg: "crm-deal:remove-contact-failed",
      dealId: input.dealId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not remove the contact from the deal" };
  }
}
