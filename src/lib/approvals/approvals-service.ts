/**
 * The approvals primitive (build plan §4.5), in core because HR will reuse it
 * for leave; the Budget & Procurement module is its first consumer.
 *
 * Phase 1 is SINGLE-STEP: one request, one step, one decision. The rules the
 * primitive owns rather than its callers (spec §4, §8):
 *   - the requester is never the assignee; a request an approver raises
 *     routes to the tier above them;
 *   - a decision is a conditional claim on the step's status, so two tabs
 *     cannot both approve;
 *   - the decider must hold authority for the amount in AED at decision time,
 *     and the settle grant can never decide;
 *   - an amount edit supersedes the pending request (spec §8.1);
 *   - an over-budget exception (spec §6, §8.5) is routed to the final
 *     approver only and can be decided by nobody else, whatever their ceiling;
 *   - every transition writes an AuditLog row with `source`.
 * Reminders, delegation and escalation (spec §8.3) live beside this file:
 * `escalation-rules.ts` (the timeline, pure) and
 * `approval-notifications-worker.ts` (the `approval-escalation` job). A step
 * is decided by its assignee or by the delegate the job named at 48 hours.
 *
 * Errors as values (src/services/README.md). Every function takes the client
 * to write through so a caller can compose the request into its own
 * transaction; it never opens a tenant lane itself.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { apiLogger } from "@/lib/logger";
import { approvalCeilingAed, canApproveProcurement, canSettleProcurement, canViewProcurement, procurementGrantsFromRow, type ProcurementUserLike } from "@/lib/procurement-visibility";
import { APPROVAL_CHAIN_KEY, CHAIN_RULES, chainKindFor, judgeChainDecider, readChainSnapshot, snapshotForRequester, standInAt, type ApprovalChainConfig, type ChainKind, type ChainSnapshot } from "./approval-chain";

export type Db = PrismaClient | Prisma.TransactionClient;

export type ApprovalSubject = "BUDGET" | "BUDGET_REALLOCATION" | "SPEND_REQUEST";

export type ApprovalErrorCode =
  | "NO_APPROVER"
  | "REQUEST_NOT_FOUND"
  | "ALREADY_DECIDED"
  | "NOT_ASSIGNEE"
  | "REQUESTER_CANNOT_DECIDE"
  | "SETTLE_CANNOT_DECIDE"
  | "INSUFFICIENT_AUTHORITY"
  | "ALREADY_APPROVED_EARLIER"
  | "UNKNOWN";

export type ApprovalResult<T> =
  | { ok: true; request: T }
  | { ok: false; code: ApprovalErrorCode; message: string };

/** One band of the launch matrix: the user who decides up to `upToAed`; null = unlimited, last. */
export interface ApprovalBand {
  upToAed: string | null;
  approverUserId: string;
}

export const DEFAULT_STEP_DUE_HOURS = 24;

interface ApproverRow {
  id: string;
  procurementApproveCeilingAed: unknown;
  procurementApproveUnlimited: boolean;
}

/** The one ceiling rule, from core: Infinity for the final approver, NaN for no authority. */
function ceilingOf(row: ApproverRow): number {
  return approvalCeilingAed(procurementGrantsFromRow(row)) ?? Number.NaN;
}

/** The organisation's saved chain of this kind, or null when none is set (the ceiling routing applies). */
export async function loadApprovalChain(db: Db, organizationId: string, kind: ChainKind = "SPEND_REQUEST"): Promise<ApprovalChainConfig | null> {
  const def = await db.approvalWorkflowDefinition.findFirst({
    where: { organizationId, subjectType: kind, isActive: true, chain: { not: Prisma.AnyNull } },
    orderBy: { updatedAt: "desc" },
    select: { chain: true },
  });
  const raw = def?.chain as Partial<ApprovalChainConfig> | null | undefined;
  if (!raw || !Array.isArray(raw.levels) || raw.levels.length === 0) return null;
  return { levels: raw.levels.filter((l): l is string => typeof l === "string"), standInUserId: typeof raw.standInUserId === "string" ? raw.standInUserId : null };
}

/**
 * The saved chain against the people as they are NOW: a request must never be
 * routed into a level whose person has left or lost the access, because a
 * chain level is never skipped and the request would sit there for good. A
 * broken level refuses the submission with a message naming it (the super
 * admin fixes the chain); a stand-in who can no longer act is dropped.
 */
async function liveChainConfig(
  db: Db,
  organizationId: string,
  config: ApprovalChainConfig,
  kind: ChainKind,
): Promise<{ ok: true; config: ApprovalChainConfig } | { ok: false; code: "NO_APPROVER"; message: string }> {
  const ids = [...config.levels, ...(config.standInUserId ? [config.standInUserId] : [])];
  const rows = await db.user.findMany({
    where: { organizationId, id: { in: ids }, deactivatedAt: null },
    select: { id: true, firstName: true, lastName: true, procurementApproveCeilingAed: true, procurementApproveUnlimited: true, procurementSettle: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const [i, id] of config.levels.entries()) {
    const row = byId.get(id);
    const ceiling = row ? approvalCeilingAed(procurementGrantsFromRow(row)) : null;
    const isFinal = i === config.levels.length - 1;
    const usable = !!row && !row.procurementSettle && ceiling !== null && (!isFinal || !CHAIN_RULES[kind].finalUnlimited || ceiling === Number.POSITIVE_INFINITY);
    if (usable) continue;
    const who = row ? `${row.firstName} ${row.lastName}`.trim() : "Someone who has left";
    apiLogger.warn({ msg: "approvals:chain-level-unusable", organizationId, level: i + 1, userId: id, found: !!row });
    return { ok: false, code: "NO_APPROVER", message: `${who}, at level ${i + 1} of the approval chain, can no longer approve, so requests cannot be routed. The super admin must update the chain in Settings, Roles.` };
  }
  const standIn = config.standInUserId && byId.has(config.standInUserId) ? config.standInUserId : null;
  if (config.standInUserId && !standIn) apiLogger.warn({ msg: "approvals:chain-stand-in-dropped", organizationId, userId: config.standInUserId });
  return { ok: true, config: { levels: config.levels, standInUserId: standIn } };
}

/**
 * Who decides a subject worth `amountAed`? A spend request in an
 * organisation with a saved chain goes to the chain's first level for this
 * requester, whatever the amount and over budget or not (owner, 28 Sep
 * 2026); `chain` then carries the snapshot the request keeps. Otherwise the
 * active definition's bands in
 * order, else every grant holder in the organisation by ascending ceiling;
 * in both cases the requester is skipped (the tier above them decides) and a
 * band approver who no longer holds a grant covering the amount is skipped
 * too, because the grant columns are the truth and the definition only the
 * order.
 */
export async function resolveApprover(
  db: Db,
  input: { organizationId: string; subjectType: ApprovalSubject; amountAed: number; requesterUserId: string; requireFinalApprover?: boolean },
): Promise<{ ok: true; approverUserId: string; chain?: ChainSnapshot } | { ok: false; code: "NO_APPROVER"; message: string }> {
  const kind = chainKindFor(input.subjectType);
  if (kind) {
    const config = await loadApprovalChain(db, input.organizationId, kind);
    if (config) {
      const live = await liveChainConfig(db, input.organizationId, config, kind);
      if (!live.ok) return live;
      const chain = snapshotForRequester(live.config, input.requesterUserId, kind);
      if (chain) return { ok: true, approverUserId: chain.levels[0], chain };
      apiLogger.warn({ msg: "approvals:chain-no-approver", organizationId: input.organizationId, requesterUserId: input.requesterUserId });
      return { ok: false, code: "NO_APPROVER", message: "The approval chain has nobody but you at its final level, and no stand-in. Ask the super admin to adjust the chain in Settings, Roles." };
    }
  }
  const holders = await db.user.findMany({
    where: {
      organizationId: input.organizationId,
      deactivatedAt: null,
      OR: [{ procurementApproveUnlimited: true }, { procurementApproveCeilingAed: { gt: 0 } }],
    },
    select: { id: true, procurementApproveCeilingAed: true, procurementApproveUnlimited: true },
  });
  const byId = new Map(holders.map((h) => [h.id, ceilingOf(h)]));
  const covers = (userId: string) => {
    const c = byId.get(userId);
    return c !== undefined && Number.isFinite(input.amountAed) && input.amountAed <= c && userId !== input.requesterUserId;
  };
  if (input.requireFinalApprover) {
    // An exception goes to the final approver and nobody else (spec §6):
    // the bands are not consulted, the amount does not matter, and the
    // requester is still never their own approver. Deterministic on a tie.
    const finals = holders.filter((h) => h.procurementApproveUnlimited && h.id !== input.requesterUserId).sort((a, b) => a.id.localeCompare(b.id));
    if (finals.length > 0) return { ok: true, approverUserId: finals[0].id };
    apiLogger.warn({ msg: "approvals:no-final-approver", organizationId: input.organizationId, subjectType: input.subjectType, requesterUserId: input.requesterUserId, holders: holders.length });
    return { ok: false, code: "NO_APPROVER", message: "Nobody other than the requester holds unlimited approval, and an over-budget exception can only be decided by the final approver. Grant one in Settings, Users." };
  }

  const def = await db.approvalWorkflowDefinition.findFirst({
    where: { organizationId: input.organizationId, subjectType: input.subjectType, isActive: true },
    orderBy: { updatedAt: "desc" },
    select: { bands: true },
  });
  const bands = Array.isArray(def?.bands) ? (def!.bands as unknown as ApprovalBand[]) : [];
  for (const band of bands) {
    if (!band || typeof band.approverUserId !== "string") continue;
    const limit = band.upToAed === null || band.upToAed === undefined ? Number.POSITIVE_INFINITY : Number(band.upToAed);
    if (Number.isFinite(limit) && input.amountAed > limit) continue;
    if (covers(band.approverUserId)) return { ok: true, approverUserId: band.approverUserId };
  }
  // No definition, or no band could take it: the lowest ceiling that covers.
  const candidates = holders
    .map((h) => ({ id: h.id, ceiling: ceilingOf(h) }))
    .filter((h) => covers(h.id))
    .sort((a, b) => a.ceiling - b.ceiling);
  if (candidates.length > 0) return { ok: true, approverUserId: candidates[0].id };
  apiLogger.warn({
    msg: "approvals:no-approver",
    organizationId: input.organizationId,
    subjectType: input.subjectType,
    amountAed: input.amountAed,
    requesterUserId: input.requesterUserId,
    holders: holders.length,
  });
  return {
    ok: false,
    code: "NO_APPROVER",
    message:
      "Nobody in the organisation holds approval authority for this amount (other than the requester). Grant an approver a ceiling in Settings, Users.",
  };
}

export interface CreateApprovalRequestInput {
  organizationId: string;
  subjectType: ApprovalSubject;
  subjectId: string;
  amountAed: number;
  amount?: number | string | null;
  currency?: string | null;
  requesterUserId: string;
  reason?: string | null;
  payload?: Prisma.InputJsonValue | null;
  /** Route to the final approver only (an over-budget exception); the decision is refused to every other ceiling. */
  requireFinalApprover?: boolean;
  source: "ui" | "mcp" | "agent";
  dueHours?: number;
}

/** The exception flag rides in the payload so the decision reads it from the ROW, not from anything the decider sends. */
export const REQUIRE_FINAL_APPROVER_KEY = "requireFinalApprover";
export function requiresFinalApprover(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload) && (payload as Record<string, unknown>)[REQUIRE_FINAL_APPROVER_KEY] === true;
}
function withFinalFlag(payload: Prisma.InputJsonValue | null | undefined, flag: boolean | undefined): Prisma.InputJsonValue | undefined {
  if (!flag) return payload ?? undefined;
  const base = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? (payload as Prisma.InputJsonObject) : {};
  return { ...base, [REQUIRE_FINAL_APPROVER_KEY]: true };
}
/** The chain snapshot rides in the payload too, so the decision reads it from the ROW and a later chain edit never reroutes this request. */
function withChain(payload: Prisma.InputJsonValue | undefined, chain: ChainSnapshot | undefined): Prisma.InputJsonValue | undefined {
  if (!chain) return payload;
  const base = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? (payload as Prisma.InputJsonObject) : {};
  return { ...base, [APPROVAL_CHAIN_KEY]: { levels: chain.levels, standInUserId: chain.standInUserId, finalUnlimited: chain.finalUnlimited } };
}

/**
 * Creates the request and its single step, superseding any pending request
 * on the same subject (an amount edit while approval is pending, spec §8.1).
 */
export async function createApprovalRequest(db: Db, input: CreateApprovalRequestInput) {
  const route = await resolveApprover(db, input);
  if (!route.ok) return route;
  const now = Date.now();
  const superseded = await db.approvalRequest.findMany({
    where: { organizationId: input.organizationId, subjectType: input.subjectType, subjectId: input.subjectId, status: "PENDING" },
    select: { id: true },
  });
  const request = await db.approvalRequest.create({
    data: {
      organizationId: input.organizationId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      amountAed: input.amountAed,
      amount: input.amount ?? null,
      currency: input.currency ?? null,
      requesterUserId: input.requesterUserId,
      reason: input.reason ?? null,
      payload: withChain(withFinalFlag(input.payload, input.requireFinalApprover), route.chain),
      steps: {
        create: {
          organizationId: input.organizationId,
          sequence: 1,
          assigneeUserId: route.approverUserId,
          // A one-level chain (the requester was every other level) opens on the final level, stand-in and all.
          delegateUserId: route.chain ? standInAt(route.chain, 0) : null,
          dueAt: new Date(now + (input.dueHours ?? DEFAULT_STEP_DUE_HOURS) * 3600_000),
        },
      },
    },
    include: { steps: true },
  });
  if (superseded.length > 0) {
    await db.approvalRequest.updateMany({
      where: { id: { in: superseded.map((r) => r.id) }, status: "PENDING" },
      data: { status: "SUPERSEDED", supersededById: request.id, decidedAt: new Date(now) },
    });
    await db.approvalStep.updateMany({
      where: { requestId: { in: superseded.map((r) => r.id) }, status: "PENDING" },
      data: { status: "SKIPPED" },
    });
  }
  await db.auditLog
    .create({
      data: {
        userId: input.requesterUserId,
        organizationId: input.organizationId,
        action: "APPROVAL_REQUESTED",
        entityType: "ApprovalRequest",
        entityId: request.id,
        changes: {
          source: input.source,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          amountAed: input.amountAed,
          assigneeUserId: route.approverUserId,
          requireFinalApprover: input.requireFinalApprover === true,
          chainLevels: route.chain ? route.chain.levels.length : null,
          superseded: superseded.map((r) => r.id),
        },
      },
    })
    .catch((err) => apiLogger.error({ msg: "approvals:audit-failed", err }));
  return { ok: true as const, request };
}

export interface DecideApprovalInput {
  organizationId: string;
  requestId: string;
  decider: ProcurementUserLike & { id: string };
  decision: "APPROVED" | "REJECTED";
  note?: string | null;
  source: "ui" | "mcp" | "agent";
}

/**
 * The decision. A conditional claim on the pending step: the FIRST tab to
 * decide wins and the second gets ALREADY_DECIDED, never a second row. The
 * settle grant is refused before authority is even checked (spec §4).
 */
export async function decideApprovalRequest(db: Db, input: DecideApprovalInput) {
  const request = await db.approvalRequest.findFirst({
    where: { id: input.requestId, organizationId: input.organizationId },
    include: { steps: { orderBy: { sequence: "asc" } } },
  });
  if (!request) return fail("REQUEST_NOT_FOUND", "The approval request was not found.", input);
  if (request.status !== "PENDING") return fail("ALREADY_DECIDED", "This request has already been decided.", input);
  if (request.requesterUserId === input.decider.id) {
    return fail("REQUESTER_CANNOT_DECIDE", "You raised this request, so you cannot decide it.", input);
  }
  // Authority is read from the ROW at decision time, not from the session: a
  // ceiling lowered or a grant removed a minute ago must bite now, not after
  // the JWT's five-minute re-validation. The session only says who is asking.
  const row = await db.user.findFirst({
    where: { id: input.decider.id, organizationId: input.organizationId, deactivatedAt: null },
    select: {
      role: true, procurementRequest: true, procurementApproveCeilingAed: true, procurementApproveUnlimited: true, procurementSettle: true,
      // Custom-role permissions are read HERE for the same reason the grants
      // are: archiving a role must bite now, not after the JWT's five-minute
      // re-validation. Archived roles grant nothing.
      permissionSets: { where: { permissionSet: { archivedAt: null } }, select: { permissionSet: { select: { permissions: { select: { permission: true } } } } } },
    },
  });
  if (!row) return fail("NOT_ASSIGNEE", "This request is assigned to someone else.", input);
  const decider: ProcurementUserLike = { role: row.role, ...procurementGrantsFromRow(row) };
  const chain = readChainSnapshot(request.payload);
  if (chain) return decideChainLevel(db, input, request, chain, decider);
  // Spec §4: the settle grant checks and signs off; it never decides, whatever
  // else the person holds (the users PUT refuses the pair as well).
  if (canSettleProcurement(decider)) {
    return fail("SETTLE_CANNOT_DECIDE", "The settle grant checks and signs off; it never decides a request.", input);
  }
  const step = request.steps.find((s) => s.status === "PENDING");
  if (!step) return fail("ALREADY_DECIDED", "This request has no open step.", input);
  if (step.assigneeUserId !== input.decider.id && step.delegateUserId !== input.decider.id) {
    return fail("NOT_ASSIGNEE", "This request is assigned to someone else.", input);
  }
  const amountAed = Number(String(request.amountAed));
  if (!canApproveProcurement(decider, amountAed)) {
    return fail("INSUFFICIENT_AUTHORITY", `Your approval ceiling does not cover AED ${amountAed.toLocaleString("en-US")}.`, input);
  }
  if (requiresFinalApprover(request.payload) && approvalCeilingAed(decider) !== Number.POSITIVE_INFINITY) {
    return fail("INSUFFICIENT_AUTHORITY", "This is an over-budget exception; only the final approver decides it.", input);
  }
  const now = new Date();
  const claimed = await db.approvalStep.updateMany({
    where: { id: step.id, status: "PENDING" },
    data: { status: input.decision, decidedByUserId: input.decider.id, decidedAt: now, note: input.note ?? null },
  });
  if (claimed.count === 0) {
    // Lost the claim. Either someone decided it, or the escalation job closed
    // this step and opened the next tier's a moment ago; the two need
    // different words, because the second is not a decision at all.
    const moved = await db.approvalStep.findFirst({ where: { requestId: request.id, status: "PENDING", id: { not: step.id } }, select: { id: true } });
    if (moved) return fail("NOT_ASSIGNEE", "This request passed to the next approver a moment ago, so it is no longer yours to decide.", input);
    return fail("ALREADY_DECIDED", "Someone decided this request a moment ago.", input);
  }
  const updated = await db.approvalRequest.update({
    where: { id: request.id },
    data: { status: input.decision, decidedAt: now, version: { increment: 1 } },
    include: { steps: true },
  });
  await db.auditLog
    .create({
      data: {
        userId: input.decider.id,
        organizationId: input.organizationId,
        action: input.decision === "APPROVED" ? "APPROVAL_GRANTED" : "APPROVAL_REJECTED",
        entityType: "ApprovalRequest",
        entityId: request.id,
        changes: {
          source: input.source,
          subjectType: request.subjectType,
          subjectId: request.subjectId,
          amountAed,
          note: input.note ?? null,
        },
      },
    })
    .catch((err) => apiLogger.error({ msg: "approvals:audit-failed", err }));
  return { ok: true as const, request: updated };
}

type RequestWithSteps = Prisma.ApprovalRequestGetPayload<{ include: { steps: true } }>;

function decisionAuditAction(decision: DecideApprovalInput["decision"]): "APPROVAL_GRANTED" | "APPROVAL_REJECTED" {
  return decision === "APPROVED" ? "APPROVAL_GRANTED" : "APPROVAL_REJECTED";
}

/**
 * One level of a chained request. Approving a level before the last opens the
 * next level's step and leaves the request PENDING, so the caller sees
 * `request.status === "PENDING"` and must not act on the subject yet; the
 * last level (or any rejection) closes the request as a single-step decision
 * does. The step claim is the same conditional update, so two tabs still
 * cannot both decide a level.
 */
async function decideChainLevel(db: Db, input: DecideApprovalInput, request: RequestWithSteps, chain: ChainSnapshot, decider: ProcurementUserLike) {
  const step = request.steps.find((s) => s.status === "PENDING");
  if (!step) return fail("ALREADY_DECIDED", "This request has no open step.", input);
  const earlier = request.steps.filter((s) => s.status === "APPROVED" && s.decidedByUserId);
  const levelIndex = earlier.length;
  if (levelIndex >= chain.levels.length) return fail("ALREADY_DECIDED", "Every level of this request is already decided.", input);
  // The stand-in's right to act is read LIVE: removing them must bite at once.
  const kind = chainKindFor(request.subjectType);
  const live = kind ? await loadApprovalChain(db, input.organizationId, kind) : null;
  const judged = judgeChainDecider({
    snapshot: chain,
    levelIndex,
    step,
    deciderId: input.decider.id,
    deciderCeilingAed: approvalCeilingAed(decider),
    deciderSettles: canSettleProcurement(decider),
    earlierApproverIds: earlier.map((s) => s.decidedByUserId as string),
    liveStandInUserId: live?.standInUserId ?? null,
    deciderHasProcurementAccess: canViewProcurement(decider),
  });
  if (!judged.ok) return fail(judged.code, judged.message, input);
  const now = new Date();
  const claimed = await db.approvalStep.updateMany({
    where: { id: step.id, status: "PENDING" },
    data: { status: input.decision, decidedByUserId: input.decider.id, decidedAt: now, note: input.note ?? null },
  });
  if (claimed.count === 0) return fail("ALREADY_DECIDED", "Someone decided this level a moment ago.", input);
  const amountAed = Number(String(request.amountAed));
  const isLast = levelIndex === chain.levels.length - 1;
  const advancing = input.decision === "APPROVED" && !isLast;
  if (advancing) {
    const next = levelIndex + 1;
    await db.approvalStep.create({
      data: {
        organizationId: input.organizationId,
        requestId: request.id,
        sequence: step.sequence + 1,
        assigneeUserId: chain.levels[next],
        delegateUserId: standInAt(chain, next),
        dueAt: new Date(now.getTime() + DEFAULT_STEP_DUE_HOURS * 3600_000),
      },
    });
  }
  const updated = await db.approvalRequest.update({
    where: { id: request.id },
    data: advancing ? { version: { increment: 1 } } : { status: input.decision, decidedAt: now, version: { increment: 1 } },
    include: { steps: true },
  });
  await db.auditLog
    .create({
      data: {
        userId: input.decider.id,
        organizationId: input.organizationId,
        action: advancing ? "APPROVAL_LEVEL_APPROVED" : decisionAuditAction(input.decision),
        entityType: "ApprovalRequest",
        entityId: request.id,
        changes: {
          source: input.source,
          subjectType: request.subjectType,
          subjectId: request.subjectId,
          amountAed,
          note: input.note ?? null,
          level: levelIndex + 1,
          levels: chain.levels.length,
          asStandIn: judged.asStandIn,
          ...(judged.asStandIn ? { standingInFor: step.assigneeUserId } : {}),
          ...(advancing ? { nextAssigneeUserId: chain.levels[levelIndex + 1] } : {}),
        },
      },
    })
    .catch((err) => apiLogger.error({ msg: "approvals:audit-failed", err }));
  apiLogger.info({ msg: advancing ? "approvals:chain-level-approved" : "approvals:chain-decided", organizationId: input.organizationId, requestId: request.id, level: levelIndex + 1, levels: chain.levels.length, decision: input.decision, asStandIn: judged.asStandIn });
  return { ok: true as const, request: updated };
}

/**
 * Which of these subjects did this person approve, at any level? The per-
 * purchase separation (Sep 28, 2026): whoever approved a purchase does not
 * also sign it off, so a receipt confirmation and a budget sign-off ask this
 * first. Read from the steps, so a stand-in's approval counts as theirs.
 */
export async function subjectsApprovedBy(
  db: Db,
  input: { organizationId: string; subjectType: ApprovalSubject; subjectIds: string[]; userId: string },
): Promise<string[]> {
  if (input.subjectIds.length === 0) return [];
  const rows = await db.approvalStep.findMany({
    where: {
      organizationId: input.organizationId,
      status: "APPROVED",
      decidedByUserId: input.userId,
      // Only approvals that went through: a level approved on a request later rejected or replaced approved nothing.
      request: { organizationId: input.organizationId, subjectType: input.subjectType, subjectId: { in: input.subjectIds }, status: "APPROVED" },
    },
    select: { request: { select: { subjectId: true } } },
  });
  return [...new Set(rows.map((r) => r.request.subjectId))];
}

/** Cancels the pending request on a subject (the subject was withdrawn or changed shape). */
export async function cancelPendingApprovals(
  db: Db,
  input: { organizationId: string; subjectType: ApprovalSubject; subjectId: string; actorUserId: string; source: "ui" | "mcp" | "agent" },
): Promise<number> {
  const pending = await db.approvalRequest.findMany({
    where: { organizationId: input.organizationId, subjectType: input.subjectType, subjectId: input.subjectId, status: "PENDING" },
    select: { id: true },
  });
  if (pending.length === 0) return 0;
  const ids = pending.map((p) => p.id);
  await db.approvalStep.updateMany({ where: { requestId: { in: ids }, status: "PENDING" }, data: { status: "SKIPPED" } });
  const res = await db.approvalRequest.updateMany({ where: { id: { in: ids }, status: "PENDING" }, data: { status: "CANCELLED", decidedAt: new Date() } });
  await db.auditLog
    .create({
      data: {
        userId: input.actorUserId,
        organizationId: input.organizationId,
        action: "APPROVAL_CANCELLED",
        entityType: "ApprovalRequest",
        entityId: ids[0],
        changes: { source: input.source, subjectType: input.subjectType, subjectId: input.subjectId, requestIds: ids },
      },
    })
    .catch((err) => apiLogger.error({ msg: "approvals:audit-failed", err }));
  return res.count;
}


function fail(code: ApprovalErrorCode, message: string, input: { organizationId: string; requestId: string; decider: { id: string } }) {
  apiLogger.warn({ msg: "approvals:decision-refused", code, organizationId: input.organizationId, requestId: input.requestId, deciderUserId: input.decider.id });
  return { ok: false as const, code, message };
}
