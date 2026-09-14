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
 *   - every transition writes an AuditLog row with `source`.
 * Reminders, delegation and escalation (spec §8.3) are Phase 2.
 *
 * Errors as values (src/services/README.md). Every function takes the client
 * to write through so a caller can compose the request into its own
 * transaction; it never opens a tenant lane itself.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { apiLogger } from "@/lib/logger";
import { canApproveProcurement, canSettleProcurement, type ProcurementUserLike } from "@/lib/procurement-visibility";

export type Db = PrismaClient | Prisma.TransactionClient;

export type ApprovalSubject = "BUDGET" | "BUDGET_REALLOCATION";

export type ApprovalErrorCode =
  | "NO_APPROVER"
  | "REQUEST_NOT_FOUND"
  | "ALREADY_DECIDED"
  | "NOT_ASSIGNEE"
  | "REQUESTER_CANNOT_DECIDE"
  | "SETTLE_CANNOT_DECIDE"
  | "INSUFFICIENT_AUTHORITY"
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

function ceilingOf(row: ApproverRow): number {
  if (row.procurementApproveUnlimited) return Number.POSITIVE_INFINITY;
  const c = row.procurementApproveCeilingAed;
  const n = c === null || c === undefined ? Number.NaN : Number(String(c));
  return Number.isFinite(n) && n > 0 ? n : Number.NaN;
}

/**
 * Who decides a subject worth `amountAed`? The active definition's bands in
 * order, else every grant holder in the organisation by ascending ceiling;
 * in both cases the requester is skipped (the tier above them decides) and a
 * band approver who no longer holds a grant covering the amount is skipped
 * too, because the grant columns are the truth and the definition only the
 * order.
 */
export async function resolveApprover(
  db: Db,
  input: { organizationId: string; subjectType: ApprovalSubject; amountAed: number; requesterUserId: string },
): Promise<{ ok: true; approverUserId: string } | { ok: false; code: "NO_APPROVER"; message: string }> {
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
  source: "ui" | "mcp";
  dueHours?: number;
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
      payload: input.payload ?? undefined,
      steps: {
        create: {
          organizationId: input.organizationId,
          sequence: 1,
          assigneeUserId: route.approverUserId,
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
  source: "ui" | "mcp";
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
  if (canSettleProcurement(input.decider) && !hasApprovalGrant(input.decider)) {
    return fail("SETTLE_CANNOT_DECIDE", "The settle grant checks and signs off; it never decides a request.", input);
  }
  const step = request.steps.find((s) => s.status === "PENDING");
  if (!step) return fail("ALREADY_DECIDED", "This request has no open step.", input);
  if (step.assigneeUserId !== input.decider.id && step.delegateUserId !== input.decider.id) {
    return fail("NOT_ASSIGNEE", "This request is assigned to someone else.", input);
  }
  const amountAed = Number(String(request.amountAed));
  if (!canApproveProcurement(input.decider, amountAed)) {
    return fail("INSUFFICIENT_AUTHORITY", `Your approval ceiling does not cover AED ${amountAed.toLocaleString("en-US")}.`, input);
  }
  const now = new Date();
  const claimed = await db.approvalStep.updateMany({
    where: { id: step.id, status: "PENDING" },
    data: { status: input.decision, decidedByUserId: input.decider.id, decidedAt: now, note: input.note ?? null },
  });
  if (claimed.count === 0) return fail("ALREADY_DECIDED", "Someone decided this request a moment ago.", input);
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

/** Cancels the pending request on a subject (the subject was withdrawn or changed shape). */
export async function cancelPendingApprovals(
  db: Db,
  input: { organizationId: string; subjectType: ApprovalSubject; subjectId: string; actorUserId: string; source: "ui" | "mcp" },
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

function hasApprovalGrant(u: ProcurementUserLike): boolean {
  return u.procurementApproveUnlimited === true || (typeof u.procurementApproveCeilingAed === "number" && u.procurementApproveCeilingAed > 0);
}

function fail(code: ApprovalErrorCode, message: string, input: { organizationId: string; requestId: string; decider: { id: string } }) {
  apiLogger.warn({ msg: "approvals:decision-refused", code, organizationId: input.organizationId, requestId: input.requestId, deciderUserId: input.decider.id });
  return { ok: false as const, code, message };
}
