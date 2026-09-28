/**
 * Settings, Roles, spend request approval chain (Sep 28, 2026): read and save
 * the organisation's one chain. The rules live in the pure
 * `src/lib/approvals/approval-chain.ts`; this file loads the people they are
 * judged against and writes the definition row with its audit entry.
 *
 * Saving never touches a request already in flight: each carries the
 * snapshot it was submitted with.
 */
import { Prisma } from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { approvalCeilingAed, canSettleProcurement, procurementGrantsFromRow } from "@/lib/procurement-visibility";
import { TEAM_ROLES } from "@/lib/team-roles";
import { loadApprovalChain } from "@/lib/approvals/approvals-service";
import { validateChainConfig, type ApprovalChainConfig, type ChainConfigError, type ChainPerson } from "@/lib/approvals/approval-chain";

const DEFINITION_NAME = "Spend request approval chain";

/** A person the dropdowns offer, with what the save rules need to know about them. */
export interface ChainCandidate {
  id: string;
  name: string;
  role: string;
  /** "unlimited" = the final approver; "limited" = an AED ceiling; null = no approval access. */
  approval: "unlimited" | "limited" | null;
  settles: boolean;
}

export interface ApprovalChainView {
  chain: ApprovalChainConfig | null;
  candidates: ChainCandidate[];
  updatedAt: Date | null;
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
    };
  });
}

export async function getApprovalChain(organizationId: string): Promise<ApprovalChainView> {
  const [chain, people, def] = await Promise.all([
    loadApprovalChain(db, organizationId),
    loadPeople(organizationId),
    db.approvalWorkflowDefinition.findFirst({ where: { organizationId, subjectType: "SPEND_REQUEST", name: DEFINITION_NAME }, select: { updatedAt: true } }),
  ]);
  return {
    chain,
    updatedAt: def?.updatedAt ?? null,
    candidates: people.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      approval: p.ceilingAed === null ? null : p.ceilingAed === Number.POSITIVE_INFINITY ? "unlimited" : "limited",
      settles: p.settles,
    })),
  };
}

export type SaveChainResult = { ok: true; view: ApprovalChainView } | { ok: false; code: ChainConfigError | "UNKNOWN"; message: string };

/**
 * Save the chain, or turn it off with no levels. Turning it off hands spend
 * requests back to the ceiling routing; requests in flight keep their chain.
 */
export async function saveApprovalChain(input: { organizationId: string; actorUserId: string; config: ApprovalChainConfig }): Promise<SaveChainResult> {
  const turningOff = input.config.levels.length === 0;
  const people = await loadPeople(input.organizationId);
  if (!turningOff) {
    const valid = validateChainConfig(input.config, people);
    if (!valid.ok) {
      apiLogger.warn({ msg: "procurement/approval-chain:rejected", code: valid.code, organizationId: input.organizationId, userId: input.actorUserId });
      return valid;
    }
  }
  const names = new Map(people.map((p) => [p.id, p.name]));
  const summary = turningOff
    ? "Spend requests go back to the approval limits."
    : `${input.config.levels.map((id, i) => `${i + 1}. ${names.get(id) ?? id}`).join(", ")}${input.config.standInUserId ? `; stand-in at the last level: ${names.get(input.config.standInUserId) ?? input.config.standInUserId}` : ""}`;
  try {
    await tenantTransaction(async (tx) => {
      const existing = await tx.approvalWorkflowDefinition.findFirst({ where: { organizationId: input.organizationId, subjectType: "SPEND_REQUEST", name: DEFINITION_NAME }, select: { id: true } });
      const chain = turningOff ? null : { levels: input.config.levels, standInUserId: input.config.standInUserId };
      const row = existing
        ? await tx.approvalWorkflowDefinition.update({ where: { id: existing.id }, data: { chain: chain ?? Prisma.DbNull, isActive: true, version: { increment: 1 } }, select: { id: true } })
        : await tx.approvalWorkflowDefinition.create({ data: { organizationId: input.organizationId, name: DEFINITION_NAME, subjectType: "SPEND_REQUEST", bands: [], ...(chain ? { chain } : {}) }, select: { id: true } });
      await tx.auditLog.create({
        data: {
          userId: input.actorUserId,
          organizationId: input.organizationId,
          action: "APPROVAL_CHAIN_UPDATED",
          entityType: "ApprovalWorkflowDefinition",
          entityId: row.id,
          changes: { source: "ui", levels: input.config.levels, standInUserId: input.config.standInUserId, summary },
        },
      });
    });
    apiLogger.info({ msg: "procurement/approval-chain:saved", organizationId: input.organizationId, userId: input.actorUserId, levels: input.config.levels.length, standIn: !!input.config.standInUserId });
    return { ok: true, view: await getApprovalChain(input.organizationId) };
  } catch (err) {
    apiLogger.error({ msg: "procurement/approval-chain:save-failed", err, organizationId: input.organizationId, userId: input.actorUserId });
    return { ok: false, code: "UNKNOWN", message: "Could not save the approval chain." };
  }
}
