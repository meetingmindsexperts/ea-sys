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
import { Prisma, type CrmDeal, type CrmDealStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { resolveStage } from "./pipeline-service";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CreateDealInput {
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api";
  requestIp?: string;

  name: string;
  stageId: string;
  companyId?: string | null;
  contactId?: string | null;
  /** THE differentiator — ties the deal to the event it is being sold against. */
  eventId?: string | null;
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
  contactId?: string | null;
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
  | "DEAL_NOT_FOUND"
  | "STAGE_NOT_FOUND"
  | "COMPANY_NOT_FOUND"
  | "CONTACT_NOT_FOUND"
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
  rel: { companyId?: string | null; contactId?: string | null; eventId?: string | null; ownerId?: string | null },
): Promise<Fail | null> {
  const checks: Array<Promise<Fail | null>> = [];

  if (rel.companyId) {
    checks.push(
      db.crmCompany
        .findFirst({ where: { id: rel.companyId, organizationId }, select: { id: true } })
        .then((r) => (r ? null : ({ ok: false, code: "COMPANY_NOT_FOUND", message: "Company not found" } as Fail))),
    );
  }
  if (rel.contactId) {
    checks.push(
      db.contact
        .findFirst({ where: { id: rel.contactId, organizationId }, select: { id: true } })
        .then((r) => (r ? null : ({ ok: false, code: "CONTACT_NOT_FOUND", message: "Contact not found" } as Fail))),
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
        contactId: input.contactId ?? null,
        eventId: input.eventId ?? null,
        ownerId: input.ownerId ?? null,
        dealValue: input.dealValue ?? null,
        currency: input.currency?.trim() || "USD",
        expectedClose: input.expectedClose ?? null,
        // A deal created directly INTO a terminal stage is born closed, so the
        // stage and the status can't disagree from the very first write.
        status: terminalStatusFor(stage.name, stage.isTerminal) ?? "OPEN",
        ...(stage.isTerminal ? closeStamps(terminalStatusFor(stage.name, stage.isTerminal)) : {}),
      },
    });

    void writeAudit({
      userId: input.userId,
      action: "CREATE",
      entityId: deal.id,
      eventId: deal.eventId,
      ipAddress: input.requestIp,
      changes: { source: input.source, name, stage: stage.name, dealValue: input.dealValue ?? null },
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
  const data: Prisma.CrmDealUpdateManyMutationInput & { companyId?: string | null; contactId?: string | null; eventId?: string | null; ownerId?: string | null } = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return { ok: false, code: "NAME_REQUIRED", message: "Deal name cannot be empty" };
    data.name = name;
  }
  if (input.dealValue !== undefined) data.dealValue = input.dealValue;
  if (input.currency !== undefined) data.currency = input.currency.trim() || "USD";
  if (input.expectedClose !== undefined) data.expectedClose = input.expectedClose;
  if (input.companyId !== undefined) data.companyId = input.companyId;
  if (input.contactId !== undefined) data.contactId = input.contactId;
  if (input.eventId !== undefined) data.eventId = input.eventId;
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
    // Bound to the org IN THE WRITE, so a deal id from another tenant matches
    // zero rows rather than being updated.
    const res = await db.crmDeal.updateMany({
      where: { id: input.dealId, organizationId: input.organizationId },
      data,
    });
    if (res.count === 0) {
      apiLogger.warn({ msg: "crm-deal:update-not-found", dealId: input.dealId, organizationId: input.organizationId });
      return { ok: false, code: "DEAL_NOT_FOUND", message: "Deal not found" };
    }

    const deal = await db.crmDeal.findUniqueOrThrow({ where: { id: input.dealId } });

    void writeAudit({
      userId: input.userId,
      action: "UPDATE",
      entityId: deal.id,
      eventId: deal.eventId,
      ipAddress: input.requestIp,
      changes: { source: input.source, fields: Object.keys(data) },
    });

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
  const toStage = await resolveStage(input.toStageId, input.organizationId);
  if (!toStage) {
    apiLogger.warn({ msg: "crm-deal:move-unknown-stage", stageId: input.toStageId, organizationId: input.organizationId });
    return { ok: false, code: "STAGE_NOT_FOUND", message: "Pipeline stage not found" };
  }

  // Moving INTO a terminal column IS closing the deal — keep stage and status in
  // step, so the board and the reports can never disagree about what's won.
  const nextStatus: CrmDealStatus = terminalStatusFor(toStage.name, toStage.isTerminal) ?? "OPEN";

  try {
    const claim = await db.crmDeal.updateMany({
      where: {
        id: input.dealId,
        organizationId: input.organizationId,
        stageId: input.fromStageId, // ← the precondition. This is the whole fix.
      },
      data: {
        stageId: toStage.id,
        status: nextStatus,
        ...closeStamps(nextStatus),
      },
    });

    if (claim.count === 0) {
      // Distinguish "someone beat me to it" from "that deal doesn't exist",
      // because they mean very different things to the person at the board.
      const current = await db.crmDeal.findFirst({
        where: { id: input.dealId, organizationId: input.organizationId },
        select: { id: true, stageId: true },
      });

      if (!current) {
        apiLogger.warn({ msg: "crm-deal:move-not-found", dealId: input.dealId, organizationId: input.organizationId });
        return { ok: false, code: "DEAL_NOT_FOUND", message: "Deal not found" };
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

    void writeAudit({
      userId: input.userId,
      action: "STAGE_MOVE",
      entityId: deal.id,
      eventId: deal.eventId,
      changes: {
        source: input.source,
        fromStageId: input.fromStageId,
        toStageId: toStage.id,
        toStage: toStage.name,
        status: nextStatus,
      },
    });

    apiLogger.info({
      msg: "crm-deal:stage-moved",
      dealId: deal.id,
      fromStageId: input.fromStageId,
      toStageId: toStage.id,
      status: nextStatus,
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
    // Land it in the matching terminal stage if the org has one, so the board
    // reflects the close. If the org deleted its Won/Lost columns, the status is
    // still authoritative — we just leave the card where it is.
    const terminal = await db.crmPipelineStage.findFirst({
      where: {
        organizationId: input.organizationId,
        isTerminal: true,
        name: { equals: status === "WON" ? "Won" : "Lost", mode: "insensitive" },
      },
      select: { id: true },
    });

    const claim = await db.crmDeal.updateMany({
      where: { id: input.dealId, organizationId: input.organizationId, status: "OPEN" },
      data: {
        status,
        ...closeStamps(status),
        lostReason: status === "LOST" ? (input.lostReason?.trim() || null) : null,
        ...(terminal ? { stageId: terminal.id } : {}),
      },
    });

    if (claim.count === 0) {
      const current = await db.crmDeal.findFirst({
        where: { id: input.dealId, organizationId: input.organizationId },
        select: { id: true, status: true },
      });
      if (!current) {
        apiLogger.warn({ msg: "crm-deal:close-not-found", dealId: input.dealId });
        return { ok: false, code: "DEAL_NOT_FOUND", message: "Deal not found" };
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

    void writeAudit({
      userId: input.userId,
      action: status === "WON" ? "DEAL_WON" : "DEAL_LOST",
      entityId: deal.id,
      eventId: deal.eventId,
      changes: {
        source: input.source,
        status,
        dealValue: deal.dealValue ? Number(deal.dealValue) : null,
        currency: deal.currency,
        ...(status === "LOST" && deal.lostReason ? { lostReason: deal.lostReason } : {}),
      },
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
 * Map a terminal STAGE to the deal STATUS it implies, so dragging a card into
 * "Won" and pressing the Won button converge on the same state.
 *
 * A terminal stage that isn't recognisably Won/Lost (an org could rename them)
 * closes the deal as LOST only if it literally says so; otherwise we leave the
 * deal OPEN rather than guess an outcome — inventing a "won" from an ambiguous
 * column name would put fictional money in a revenue report.
 */
function terminalStatusFor(stageName: string, isTerminal: boolean): CrmDealStatus | null {
  if (!isTerminal) return null;
  const n = stageName.trim().toLowerCase();
  if (n === "won" || n === "closed won") return "WON";
  if (n === "lost" || n === "closed lost") return "LOST";
  return null;
}

function closeStamps(status: CrmDealStatus | null) {
  if (status === "WON") return { wonAt: new Date(), lostAt: null };
  if (status === "LOST") return { lostAt: new Date(), wonAt: null };
  // Moving a card back OUT of a terminal column reopens it — clear the stamps so
  // a reopened deal can't linger in a "won in July" report.
  return { wonAt: null, lostAt: null };
}

function writeAudit(entry: {
  userId: string | null;
  action: string;
  entityId: string;
  eventId?: string | null;
  ipAddress?: string;
  changes: Record<string, unknown>;
}) {
  return db.auditLog
    .create({
      data: {
        userId: entry.userId,
        eventId: entry.eventId ?? null,
        action: entry.action,
        entityType: "CrmDeal",
        entityId: entry.entityId,
        ipAddress: entry.ipAddress ?? null,
        changes: entry.changes as Prisma.InputJsonValue,
      },
    })
    .catch((err: unknown) => {
      apiLogger.error({
        msg: "crm-deal:audit-failed",
        entityId: entry.entityId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
}
