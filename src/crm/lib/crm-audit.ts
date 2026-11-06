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

/** JSON-safe value for an audit diff (Decimal and Date become strings). */
export function auditValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Prisma.Decimal) return v.toString();
  return v;
}
