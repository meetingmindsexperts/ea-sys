import { NextResponse } from "next/server";
import { z } from "zod";
import { runWithTenant } from "@/lib/tenant-context";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmRead, crmCan } from "@/crm/lib/crm-route";
import { INBOX_FOLDERS, INBOX_PAGE_SIZE, inboxWhere, unreadWhere } from "@/crm/lib/crm-inbox-filters";

/**
 * GET /api/crm/inbox — the shared CRM inbox: every email thread in the org,
 * newest activity first (owner decision: one bulk inbox for all CRM staff).
 *
 * Folders, filters, search and "load more" (Oct 27, 2026; rules in
 * crm-inbox-filters.ts): ?folder=inbox|sent|archived (default inbox),
 * &unread=1, &mine=1, &dealId=, &q=, &cursor=<thread id>.
 *
 * Staff-only via `crm.inbox.read` (crmCan) — MEMBER (read-only accounts)
 * passes the generic CRM read gate but must never read rival sponsors'
 * negotiation threads, so this surface layers the narrower predicate on top.
 */
const querySchema = z.object({
  folder: z.enum(INBOX_FOLDERS).default("inbox"),
  unread: z.enum(["1"]).optional(),
  mine: z.enum(["1"]).optional(),
  dealId: z.string().min(1).max(64).optional(),
  q: z.string().max(200).optional(),
  cursor: z.string().min(1).max(64).optional(),
});

const THREAD_SELECT = {
  id: true,
  subject: true,
  counterpartyEmail: true,
  counterpartyName: true,
  hasUnread: true,
  lastMessageAt: true,
  lastInboundAt: true,
  archivedAt: true,
  createdAt: true,
  deal: { select: { id: true, name: true } },
  crmContact: { select: { id: true, firstName: true, lastName: true } },
  _count: { select: { messages: true } },
} as const;

export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;
  // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
  return await runWithTenant(ctx.organizationId, async () => {
  if (!crmCan(ctx, "crm.inbox.read")) {
    apiLogger.warn({ msg: "crm/inbox:forbidden", role: ctx.role, userId: ctx.userId });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const params = Object.fromEntries(
    [...new URL(req.url).searchParams].filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, v.trim()]),
  );
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/inbox:GET", organizationId: ctx.organizationId });
  }
  const { folder, unread, mine, dealId, q, cursor } = parsed.data;

  try {
    const where = inboxWhere(ctx.organizationId, ctx.userId, {
      folder,
      unreadOnly: !!unread,
      mine: !!mine,
      dealId,
      q,
    });
    const [rows, unreadCount] = await Promise.all([
      db.crmEmailThread.findMany({
        where,
        select: THREAD_SELECT,
        // id breaks ties so a page boundary never repeats or skips a thread.
        orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
        take: INBOX_PAGE_SIZE + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
      db.crmEmailThread.count({ where: unreadWhere(ctx.organizationId) }),
    ]);

    const threads = rows.slice(0, INBOX_PAGE_SIZE);
    const nextCursor = rows.length > INBOX_PAGE_SIZE ? threads[threads.length - 1]!.id : null;
    return NextResponse.json({ threads, unreadCount, nextCursor });
  } catch (err) {
    apiLogger.error({
      msg: "crm/inbox:list-failed",
      organizationId: ctx.organizationId,
      folder,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load the inbox" }, { status: 500 });
  }
  });
}
