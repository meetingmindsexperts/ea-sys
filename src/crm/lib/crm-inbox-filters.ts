/**
 * The CRM inbox's folders, filters and search as one Prisma where (Oct 27,
 * 2026, docs/CRM_INBOX_PLAN.md phase 1). Pure, so the rules are tested without
 * a database.
 *
 *   Inbox     a sponsor has replied, and nobody archived it
 *   Sent      every conversation we started (each one starts with our email)
 *   Archived  archived from the inbox; a new reply brings it back
 *
 * Read state and visibility stay shared (owner decisions): every CRM user sees
 * every thread, "Mine" is only a filter.
 */
import type { Prisma } from "@prisma/client";

export const INBOX_FOLDERS = ["inbox", "sent", "archived"] as const;
export type InboxFolder = (typeof INBOX_FOLDERS)[number];

export const INBOX_PAGE_SIZE = 50;

export interface InboxFilters {
  folder: InboxFolder;
  unreadOnly?: boolean;
  /** Only threads on deals the caller owns. */
  mine?: boolean;
  dealId?: string;
  q?: string;
}

function folderWhere(folder: InboxFolder): Prisma.CrmEmailThreadWhereInput {
  if (folder === "inbox") return { lastInboundAt: { not: null }, archivedAt: null };
  if (folder === "archived") return { archivedAt: { not: null } };
  return {};
}

/** Every typed word must match the subject, the person, their email or the deal. */
function searchWhere(q: string): Prisma.CrmEmailThreadWhereInput[] {
  return q
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .map((word) => ({
      OR: [
        { subject: { contains: word, mode: "insensitive" } },
        { counterpartyEmail: { contains: word, mode: "insensitive" } },
        { counterpartyName: { contains: word, mode: "insensitive" } },
        { deal: { name: { contains: word, mode: "insensitive" } } },
      ],
    }));
}

export function inboxWhere(
  organizationId: string,
  userId: string | null,
  f: InboxFilters,
): Prisma.CrmEmailThreadWhereInput {
  const and: Prisma.CrmEmailThreadWhereInput[] = [{ organizationId }, folderWhere(f.folder)];
  if (f.unreadOnly) and.push({ hasUnread: true });
  // An API key has no user: "mine" then matches nothing rather than everything.
  if (f.mine) and.push({ deal: { ownerId: userId ?? "__no-user__" } });
  if (f.dealId) and.push({ dealId: f.dealId });
  if (f.q?.trim()) and.push(...searchWhere(f.q.trim()));
  return { AND: and };
}

/** The Inbox badge: exactly the Inbox folder's unread threads, so the count never names one the Inbox cannot show. */
export function unreadWhere(organizationId: string): Prisma.CrmEmailThreadWhereInput {
  return { organizationId, hasUnread: true, ...folderWhere("inbox") };
}

/**
 * Keyset paging: the cursor carries the last row's own (lastMessageAt, id), so
 * a reply that bumps that row while someone reads page 1 cannot make page 2
 * repeat page 1 (Prisma's `cursor` re-reads the row's CURRENT position).
 */
export function encodeInboxCursor(row: { lastMessageAt: Date; id: string }): string {
  return `${row.lastMessageAt.toISOString()}|${row.id}`;
}

/** The rows after a cursor, or null for a cursor that does not parse. */
export function afterCursor(cursor: string): Prisma.CrmEmailThreadWhereInput | null {
  const [iso, id] = cursor.split("|");
  const at = new Date(iso ?? "");
  if (!id || Number.isNaN(at.getTime())) return null;
  return { OR: [{ lastMessageAt: { lt: at } }, { lastMessageAt: at, id: { lt: id } }] };
}
