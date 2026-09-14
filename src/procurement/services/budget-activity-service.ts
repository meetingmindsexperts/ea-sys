/**
 * The budget's activity log, read from AuditLog: every row the budget
 * service and the approvals primitive wrote about this budget, its lines and
 * its approval routing, newest first, each described in words by
 * `describeBudgetActivity`. Read-only; org-bound before any row is read.
 *
 * Only the ROUTING rows of ApprovalRequest are included (requested,
 * cancelled). Its granted/rejected rows duplicate the budget's own APPROVE /
 * REJECT / REALLOCATE rows, which carry the decider and the note, so listing
 * both would show one decision twice.
 *
 * The line and approval arms filter on a JSON path (changes.budgetId,
 * changes.subjectId) because those rows are keyed on their own entity id.
 * The rows are few per organisation (module writes only); if the log ever
 * slows, stamp a budgetId column on the audit row rather than widen this.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { describeBudgetActivity, type BudgetActivityItem, type BudgetActivityRow } from "@/procurement/lib/budget-activity";

export const BUDGET_ACTIVITY_LIMIT = 200;

export type BudgetActivityResult =
  | { ok: true; items: BudgetActivityItem[]; truncated: boolean }
  | { ok: false; code: "BUDGET_NOT_FOUND"; message: string };

function displayName(u: { firstName: string; lastName: string; email: string }): string {
  return `${u.firstName} ${u.lastName}`.trim() || u.email;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export async function listBudgetActivity(organizationId: string, budgetId: string): Promise<BudgetActivityResult> {
  const budget = await db.eventBudget.findFirst({ where: { id: budgetId, organizationId }, select: { id: true } });
  if (!budget) {
    apiLogger.warn({ msg: "procurement/budget-activity:rejected", code: "BUDGET_NOT_FOUND", budgetId });
    return { ok: false, code: "BUDGET_NOT_FOUND", message: "The budget was not found." };
  }

  const [lines, rows] = await Promise.all([
    db.budgetLine.findMany({ where: { budgetId }, select: { lineKey: true, description: true } }),
    db.auditLog.findMany({
      where: {
        organizationId,
        OR: [
          { entityType: "EventBudget", entityId: budgetId },
          { entityType: "BudgetLine", changes: { path: ["budgetId"], equals: budgetId } },
          { entityType: "ApprovalRequest", action: { in: ["APPROVAL_REQUESTED", "APPROVAL_CANCELLED"] }, changes: { path: ["subjectId"], equals: budgetId } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: BUDGET_ACTIVITY_LIMIT + 1,
      select: { id: true, action: true, entityType: true, changes: true, createdAt: true, user: { select: { firstName: true, lastName: true, email: true } } },
    }),
  ]);

  const truncated = rows.length > BUDGET_ACTIVITY_LIMIT;
  const kept = truncated ? rows.slice(0, BUDGET_ACTIVITY_LIMIT) : rows;

  const assigneeIds = [...new Set(kept.map((r) => asRecord(r.changes).assigneeUserId).filter((v): v is string => typeof v === "string"))];
  const users = assigneeIds.length
    ? await db.user.findMany({ where: { id: { in: assigneeIds }, organizationId }, select: { id: true, firstName: true, lastName: true, email: true } })
    : [];

  const ctx = {
    lineNames: Object.fromEntries(lines.map((l) => [l.lineKey, l.description])),
    userNames: Object.fromEntries(users.map((u) => [u.id, displayName(u)])),
  };

  const items = kept.map((r) => {
    const row: BudgetActivityRow = {
      id: r.id,
      at: r.createdAt.toISOString(),
      entityType: r.entityType,
      action: r.action,
      changes: asRecord(r.changes),
      actor: r.user ? { name: displayName(r.user) || null, email: r.user.email } : null,
    };
    return { ...row, ...describeBudgetActivity(row, ctx) };
  });

  return { ok: true, items, truncated };
}
