import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requireCrmRead } from "@/crm/lib/crm-route";
import { canViewCrmInbox } from "@/crm/lib/crm-visibility";

/**
 * GET /api/crm/inbox/[threadId] — one thread with its messages (oldest first).
 *
 * Opening a thread CLEARS its unread flag — shared-inbox semantics (owner
 * decision): read state is per-thread, not per-user; whoever opens it has
 * "handled" it for the team. The clear is a conditional updateMany so a
 * thread that isn't unread costs no write.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const [{ error, ctx }, { threadId }] = await Promise.all([requireCrmRead(req), params]);
  if (error) return error;
  if (!canViewCrmInbox(ctx.role, ctx.fromApiKey)) {
    apiLogger.warn({ msg: "crm/inbox:thread-forbidden", role: ctx.role, userId: ctx.userId });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const thread = await db.crmEmailThread.findFirst({
      where: { id: threadId, organizationId: ctx.organizationId },
      select: {
        id: true,
        subject: true,
        counterpartyEmail: true,
        counterpartyName: true,
        hasUnread: true,
        lastMessageAt: true,
        createdAt: true,
        deal: { select: { id: true, name: true } },
        crmContact: { select: { id: true, firstName: true, lastName: true } },
        messages: {
          select: {
            id: true,
            direction: true,
            fromEmail: true,
            fromName: true,
            subject: true,
            textBody: true,
            htmlBody: true,
            attachments: true,
            unverifiedSender: true,
            sentBy: { select: { firstName: true, lastName: true } },
            createdAt: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!thread) {
      apiLogger.warn({ msg: "crm/inbox:thread-not-found", threadId, organizationId: ctx.organizationId });
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }

    if (thread.hasUnread) {
      await db.crmEmailThread.updateMany({
        where: { id: thread.id, organizationId: ctx.organizationId, hasUnread: true },
        data: { hasUnread: false },
      });
    }

    return NextResponse.json({ thread });
  } catch (err) {
    apiLogger.error({
      msg: "crm/inbox:thread-failed",
      threadId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load the thread" }, { status: 500 });
  }
}
