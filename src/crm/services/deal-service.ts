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
import { Prisma, type CrmDeal, type CrmDealStatus, type CrmDealContactRole } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { recordCrmActivity, diffFields } from "@/crm/lib/crm-activity";
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
  | "STAGE_NOT_FOUND"
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
        // stage and the status can't disagree from the very first write.
        status: terminalStatusFor(stage.name, stage.isTerminal) ?? "OPEN",
        ...(stage.isTerminal ? closeStamps(terminalStatusFor(stage.name, stage.isTerminal)) : {}),
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

    const fieldChanges = diffFields(before, deal, DEAL_DIFF_KEYS);
    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "DEAL",
      entityId: deal.id,
      action: "UPDATE",
      actorId: input.userId,
      changes: { source: input.source, ...(fieldChanges ? { changes: fieldChanges } : {}) },
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
        select: { id: true, eventId: true },
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
