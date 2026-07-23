/**
 * The CRM in-app notification service — SERVER ONLY.
 *
 * DELIBERATELY SEPARATE from the core notification service
 * (src/lib/notifications.ts — owner decision, July 17): the event platform's
 * bell reads `Notification`, the CRM bell reads `CrmNotification`, and neither
 * feed leaks into the other. Keeping it inside src/crm/ also keeps the module
 * boundary intact — core never imports this file, and this file only imports
 * core (db + logger), never the core notification helpers.
 *
 * ONE WRITER. `notifyCrmUser()` is the only function that inserts rows — every
 * trigger (deal assigned / stage moved / won / lost, task assigned, task due)
 * funnels through it, same one-writer rule as `recordCrmActivity`. That is
 * where the two cross-cutting rules live so no call site can forget them:
 *
 *   1. NEVER notify a user about their own action. You dragged the card — you
 *      know. The actor/recipient comparison is here, not at nine call sites.
 *   2. NEVER throw. The mutation this notification describes has already
 *      committed; a notification-insert blip must not flip a committed op into
 *      an error (the registrations-review M13 class). Failures log loudly and
 *      are swallowed. Callers `void`-call it after the real write.
 *
 * In-app only (owner decision): no email — the reminders worker already emails
 * task owners — and no push. Titles/messages carry NO deal money, so the
 * FINANCIAL_KEYS redaction question never arises for this feed.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

/** The notification kinds. A string column in the DB (no enum migration per new kind). */
export type CrmNotificationType =
  | "DEAL_ASSIGNED"
  | "DEAL_STAGE_MOVED"
  | "DEAL_WON"
  | "DEAL_LOST"
  | "TASK_ASSIGNED"
  | "TASK_DUE"
  | "EMAIL_RECEIVED";

export interface CrmNotificationEntry {
  organizationId: string;
  /** Who should see it. null/undefined = nobody to tell → silent no-op. */
  recipientId: string | null | undefined;
  /**
   * Who caused it. A user is never notified about their own action; a null
   * actor (the reminders worker, an API-key caller) always notifies.
   */
  actorId: string | null;
  type: CrmNotificationType;
  title: string;
  message: string;
  /** In-app path to navigate to on click (e.g. /crm/deals/{id}). */
  link?: string;
}

/**
 * Append one notification. Never throws — see the file header. Skips silently
 * (and correctly) when there is no recipient or the recipient IS the actor.
 */
export function notifyCrmUser(entry: CrmNotificationEntry): Promise<unknown> {
  if (!entry.recipientId) return Promise.resolve();
  if (entry.actorId && entry.actorId === entry.recipientId) return Promise.resolve();

  return db.crmNotification
    .create({
      data: {
        organizationId: entry.organizationId,
        userId: entry.recipientId,
        type: entry.type,
        title: entry.title,
        message: entry.message,
        link: entry.link ?? null,
      },
    })
    .catch((err: unknown) => {
      apiLogger.error({
        msg: "crm-notification:write-failed",
        type: entry.type,
        recipientId: entry.recipientId,
        organizationId: entry.organizationId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export interface CrmNotificationRecord {
  id: string;
  type: string;
  title: string;
  message: string;
  link: string | null;
  isRead: boolean;
  createdAt: Date;
}

/**
 * One user's feed, newest first. Scoped by BOTH userId and organizationId —
 * the org scope is belt-and-braces today (a notification is only ever written
 * under the recipient's own org) but keeps the read tenant-safe if a user ever
 * spans orgs.
 */
export async function listCrmNotifications(args: {
  organizationId: string;
  userId: string;
  limit?: number;
}): Promise<CrmNotificationRecord[]> {
  return db.crmNotification.findMany({
    where: { organizationId: args.organizationId, userId: args.userId },
    orderBy: { createdAt: "desc" },
    take: Math.min(args.limit ?? 50, 200),
    select: {
      id: true,
      type: true,
      title: true,
      message: true,
      link: true,
      isRead: true,
      createdAt: true,
    },
  });
}

/** Unread count for the bell badge. Same user+org scoping as the list. */
export async function countUnreadCrmNotifications(args: {
  organizationId: string;
  userId: string;
}): Promise<number> {
  return db.crmNotification.count({
    where: { organizationId: args.organizationId, userId: args.userId, isRead: false },
  });
}

/**
 * Mark notifications read. The where clause carries userId + organizationId, so
 * a caller can only ever flip their OWN rows — an id belonging to someone else
 * simply matches nothing (no IDOR by construction, the house pattern). Omitting
 * `ids` marks everything read ("mark all read"). Idempotent: already-read rows
 * are excluded from the match, so the returned count is real work done.
 */
export async function markCrmNotificationsRead(args: {
  organizationId: string;
  userId: string;
  ids?: string[];
}): Promise<{ count: number }> {
  const res = await db.crmNotification.updateMany({
    where: {
      organizationId: args.organizationId,
      userId: args.userId,
      isRead: false,
      ...(args.ids ? { id: { in: args.ids } } : {}),
    },
    data: { isRead: true },
  });
  return { count: res.count };
}
