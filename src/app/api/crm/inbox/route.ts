import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requireCrmRead } from "@/crm/lib/crm-route";
import { canViewCrmInbox } from "@/crm/lib/crm-visibility";

/**
 * GET /api/crm/inbox — the shared CRM inbox: every email thread in the org,
 * newest activity first (owner decision: one bulk inbox for all CRM staff).
 *
 * Staff-only via canViewCrmInbox — MEMBER (sponsor-side read-only accounts)
 * passes the generic CRM read gate but must never read rival sponsors'
 * negotiation threads, so this surface layers the narrower predicate on top.
 */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;
  if (!canViewCrmInbox(ctx.role, ctx.fromApiKey)) {
    apiLogger.warn({ msg: "crm/inbox:forbidden", role: ctx.role, userId: ctx.userId });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const url = new URL(req.url);
    const dealId = url.searchParams.get("dealId")?.trim() || undefined;

    const [threads, unreadCount] = await Promise.all([
      db.crmEmailThread.findMany({
        where: { organizationId: ctx.organizationId, ...(dealId ? { dealId } : {}) },
        select: {
          id: true,
          subject: true,
          counterpartyEmail: true,
          counterpartyName: true,
          hasUnread: true,
          lastMessageAt: true,
          lastInboundAt: true,
          createdAt: true,
          deal: { select: { id: true, name: true } },
          crmContact: { select: { id: true, firstName: true, lastName: true } },
          _count: { select: { messages: true } },
        },
        orderBy: { lastMessageAt: "desc" },
        take: 100,
      }),
      db.crmEmailThread.count({
        where: { organizationId: ctx.organizationId, hasUnread: true },
      }),
    ]);

    return NextResponse.json({ threads, unreadCount });
  } catch (err) {
    apiLogger.error({
      msg: "crm/inbox:list-failed",
      organizationId: ctx.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load the inbox" }, { status: 500 });
  }
}
