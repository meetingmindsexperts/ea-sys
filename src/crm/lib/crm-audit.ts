/**
 * THE CRM'S TRANSACTIONAL AUDIT (Nov 6, 2026; CRM product review P1-10, owner
 * decision of the same day). SERVER ONLY.
 *
 * Two records, two promises:
 *   - CrmActivity (crm-activity.ts) is the History timeline people read. It is
 *     written AFTER the change, best-effort; a lost line is an accepted loss
 *     (decided Oct 28, 2026) and that still holds for ordinary edits.
 *   - AuditLog, through THIS writer, is the authoritative trail for the
 *     changes that move money or responsibility: a deal's value or currency,
 *     its owner, won/lost and reopening, archive and restore, a quote created,
 *     edited or deleted, a quote sent to QuickBooks. It is written INSIDE the
 *     change's own transaction, so the change and its record land together or
 *     not at all. (A permanent delete already worked this way:
 *     crm-purge-service.ts.)
 *
 * Takes the transaction client, never `db`, so a call outside a transaction
 * does not type-check by accident. The row carries the organisation
 * explicitly (RLS on the platform) and `changes.source` like every audit row.
 */
import { Prisma } from "@prisma/client";

export type CrmAuditAction =
  | "CRM_DEAL_VALUE_CHANGED"
  | "CRM_DEAL_OWNER_CHANGED"
  | "CRM_DEAL_WON"
  | "CRM_DEAL_LOST"
  | "CRM_DEAL_REOPENED"
  | "CRM_DEAL_ARCHIVED"
  | "CRM_DEAL_RESTORED"
  | "CRM_QUOTE_CREATED"
  | "CRM_QUOTE_UPDATED"
  | "CRM_QUOTE_DELETED"
  | "CRM_QUOTE_SENT_TO_QUICKBOOKS";

export interface CrmAuditEntry {
  organizationId: string;
  actorId: string | null;
  action: CrmAuditAction;
  entityType: "CrmDeal" | "CrmQuote";
  entityId: string;
  /** What changed; `source` (rest / mcp / agent) belongs in here. */
  changes: Record<string, unknown>;
}

export async function writeCrmAudit(tx: Prisma.TransactionClient, entry: CrmAuditEntry): Promise<void> {
  await tx.auditLog.create({
    data: {
      organizationId: entry.organizationId,
      userId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      changes: entry.changes as Prisma.InputJsonValue,
    },
  });
}

/**
 * A money amount as one canonical string ("15000", "15000.5"), whatever it
 * arrived as: the form sends a number, Prisma returns a Decimal. Comparing the
 * raw values made every edit look like a value change (review of 3be7c80e,
 * HIGH), so both the comparison and the stored diff go through this.
 */
export function auditMoney(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  try {
    return new Prisma.Decimal(v as Prisma.Decimal.Value).toString();
  } catch {
    return String(v);
  }
}

/** JSON-safe value for an audit diff (Decimal and Date become strings). */
export function auditValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Prisma.Decimal) return v.toString();
  return v;
}

const OUTCOME_ACTIONS: Record<string, CrmAuditAction> = { WON: "CRM_DEAL_WON", LOST: "CRM_DEAL_LOST" };

/** The audit action for a deal's new status: won, lost, or back to open. */
function outcomeAction(status: string): CrmAuditAction {
  return OUTCOME_ACTIONS[status] ?? "CRM_DEAL_REOPENED";
}

type DealAuditState = { dealValue: unknown; currency: string; ownerId: string | null; status: string };

/**
 * The audit rows a change from `before` to `after` calls for, for writers that
 * replace a deal wholesale (the Freshsales import): value or currency, owner,
 * and an outcome change. Empty when none of those moved.
 */
export function dealChangeAudits(
  before: DealAuditState,
  after: DealAuditState,
  meta: { organizationId: string; actorId: string | null; dealId: string; source: string },
): CrmAuditEntry[] {
  const base = { organizationId: meta.organizationId, actorId: meta.actorId, entityType: "CrmDeal" as const, entityId: meta.dealId };
  const out: CrmAuditEntry[] = [];
  if (auditMoney(before.dealValue) !== auditMoney(after.dealValue) || before.currency !== after.currency) {
    out.push({
      ...base,
      action: "CRM_DEAL_VALUE_CHANGED",
      changes: { source: meta.source, dealValue: { from: auditMoney(before.dealValue), to: auditMoney(after.dealValue) }, currency: { from: before.currency, to: after.currency } },
    });
  }
  if (before.ownerId !== after.ownerId) {
    out.push({ ...base, action: "CRM_DEAL_OWNER_CHANGED", changes: { source: meta.source, ownerId: { from: before.ownerId, to: after.ownerId } } });
  }
  if (before.status !== after.status) {
    out.push({ ...base, action: outcomeAction(after.status), changes: { source: meta.source, status: { from: before.status, to: after.status } } });
  }
  return out;
}
