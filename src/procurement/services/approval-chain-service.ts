/**
 * Settings, Roles, approval chains (Sep 28, 2026): read and save the
 * organisation's two chains, the spend request chain and the budget approver
 * (budgets, their new versions and moves between their lines). The rules
 * live in the pure `src/lib/approvals/approval-chain.ts`; this file loads the
 * people they are judged against and writes the definition rows with their
 * audit entries.
 *
 * Saving never touches a request already in flight: each carries the
 * snapshot it was submitted with (its stand-in apart, which is read live).
 */
import { Prisma } from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { approvalCeilingAed, canSettleProcurement, canViewProcurement, procurementGrantsFromRow } from "@/lib/procurement-visibility";
import { TEAM_ROLES } from "@/lib/team-roles";
import { loadApprovalChain } from "@/lib/approvals/approvals-service";
import { validateChainConfig, type ApprovalChainConfig, type ChainConfigError, type ChainKind, type ChainPerson } from "@/lib/approvals/approval-chain";

const DEFINITION_NAME: Record<ChainKind, string> = {
  SPEND_REQUEST: "Spend request approval chain",
  BUDGET: "Budget approver",
};

/** A person the dropdowns offer, with what the save rules need to know about them. */
export interface ChainCandidate {
  id: string;
  name: string;
  role: string;
  /** "unlimited" = may be a spend request's final approver; "limited" = an AED ceiling; null = no approval access. */
  approval: "unlimited" | "limited" | null;
  settles: boolean;
  /** Can open Budgets at all (a stand-in needs it). */
  procurementAccess: boolean;
}

export interface ApprovalChainView {
  chains: Record<ChainKind, ApprovalChainConfig | null>;
  candidates: ChainCandidate[];
}

async function loadPeople(organizationId: string): Promise<ChainPerson[]> {
  const rows = await db.user.findMany({
    where: { organizationId, deactivatedAt: null, role: { in: [...TEAM_ROLES] } },
    select: {
      id: true, firstName: true, lastName: true, email: true, role: true,
      procurementRequest: true, procurementApproveCeilingAed: true, procurementApproveUnlimited: true, procurementSettle: true,
      permissionSets: { where: { permissionSet: { archivedAt: null } }, select: { permissionSet: { select: { permissions: { select: { permission: true } } } } } },
    },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
  return rows.map((r) => {
    const grants = procurementGrantsFromRow(r);
    return {
      id: r.id,
      name: `${r.firstName} ${r.lastName}`.trim() || r.email,
      role: r.role,
      active: true,
      ceilingAed: approvalCeilingAed(grants),
      settles: canSettleProcurement(grants),
      hasProcurementAccess: canViewProcurement({ role: r.role, ...grants }),
    };
  });
}

export async function getApprovalChain(organizationId: string): Promise<ApprovalChainView> {
  const [spend, budget, people] = await Promise.all([
    loadApprovalChain(db, organizationId, "SPEND_REQUEST"),
    loadApprovalChain(db, organizationId, "BUDGET"),
    loadPeople(organizationId),
  ]);
  return {
    chains: { SPEND_REQUEST: spend, BUDGET: budget },
    candidates: people.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      approval: p.ceilingAed === null ? null : p.ceilingAed === Number.POSITIVE_INFINITY ? "unlimited" : "limited",
      settles: p.settles,
      procurementAccess: p.hasProcurementAccess,
    })),
  };
}

export type SaveChainResult = { ok: true; view: ApprovalChainView } | { ok: false; code: ChainConfigError | "UNKNOWN"; message: string };

/**
 * Save a chain, or turn it off with no levels. Turning it off hands that kind
 * of approval back to the ceiling routing; requests in flight keep their chain.
 */
export async function saveApprovalChain(input: { organizationId: string; actorUserId: string; kind: ChainKind; config: ApprovalChainConfig }): Promise<SaveChainResult> {
  const turningOff = input.config.levels.length === 0;
  const people = await loadPeople(input.organizationId);
  if (!turningOff) {
    const valid = validateChainConfig(input.config, people, input.kind);
    if (!valid.ok) {
      apiLogger.warn({ msg: "procurement/approval-chain:rejected", code: valid.code, kind: input.kind, organizationId: input.organizationId, userId: input.actorUserId });
      return valid;
    }
  }
  const names = new Map(people.map((p) => [p.id, p.name]));
  const standIn = input.config.standInUserId ? names.get(input.config.standInUserId) ?? input.config.standInUserId : null;
  const summary = turningOff
    ? input.kind === "BUDGET" ? "Budgets go back to the approval limits." : "Spend requests go back to the approval limits."
    : input.kind === "BUDGET"
      ? `Budgets approved by ${names.get(input.config.levels[0]) ?? input.config.levels[0]}${standIn ? `; backup: ${standIn}` : ""}`
      : `${input.config.levels.map((id, i) => `${i + 1}. ${names.get(id) ?? id}`).join(", ")}${standIn ? `; stand-in at the last level: ${standIn}` : ""}`;
  try {
    await tenantTransaction(async (tx) => {
      const existing = await tx.approvalWorkflowDefinition.findFirst({ where: { organizationId: input.organizationId, subjectType: input.kind, name: DEFINITION_NAME[input.kind] }, select: { id: true } });
      const chain = turningOff ? null : { levels: input.config.levels, standInUserId: input.config.standInUserId };
      const row = existing
        ? await tx.approvalWorkflowDefinition.update({ where: { id: existing.id }, data: { chain: chain ?? Prisma.DbNull, isActive: true, version: { increment: 1 } }, select: { id: true } })
        : await tx.approvalWorkflowDefinition.create({ data: { organizationId: input.organizationId, name: DEFINITION_NAME[input.kind], subjectType: input.kind, bands: [], ...(chain ? { chain } : {}) }, select: { id: true } });
      await tx.auditLog.create({
        data: {
          userId: input.actorUserId,
          organizationId: input.organizationId,
          action: "APPROVAL_CHAIN_UPDATED",
          entityType: "ApprovalWorkflowDefinition",
          entityId: row.id,
          changes: { source: "ui", kind: input.kind, levels: input.config.levels, standInUserId: input.config.standInUserId, summary },
        },
      });
    });
    apiLogger.info({ msg: "procurement/approval-chain:saved", kind: input.kind, organizationId: input.organizationId, userId: input.actorUserId, levels: input.config.levels.length, standIn: !!input.config.standInUserId });
    return { ok: true, view: await getApprovalChain(input.organizationId) };
  } catch (err) {
    apiLogger.error({ msg: "procurement/approval-chain:save-failed", err, kind: input.kind, organizationId: input.organizationId, userId: input.actorUserId });
    return { ok: false, code: "UNKNOWN", message: "Could not save the approval chain." };
  }
}
