import { NextResponse } from "next/server";
import { z } from "zod";
import { runWithTenant } from "@/lib/tenant-context";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmRead, requireCrmWrite, crmCan } from "@/crm/lib/crm-route";

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
  // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
  return await runWithTenant(ctx.organizationId, async () => {
  if (!crmCan(ctx, "crm.inbox.read")) {
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
        archivedAt: true,
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
  });
}

const patchSchema = z
  .object({
    archived: z.boolean().optional(),
    unread: z.boolean().optional(),
  })
  .refine((d) => d.archived !== undefined || d.unread !== undefined, { message: "Nothing to change" });

/**
 * PATCH /api/crm/inbox/[threadId] — archive / unarchive, mark unread / read
 * (Oct 27, 2026). Shared state, like the unread flag: archiving files it away
 * for the whole team. Write-gated (MEMBER never reaches the inbox anyway) and
 * still behind crm.inbox.read.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const [{ error, ctx }, { threadId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
  if (!crmCan(ctx, "crm.inbox.read")) {
    apiLogger.warn({ msg: "crm/inbox:patch-forbidden", role: ctx.role, userId: ctx.userId });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/inbox/[threadId]:PATCH", organizationId: ctx.organizationId });
  }
  const { archived, unread } = parsed.data;

  try {
    const res = await db.crmEmailThread.updateMany({
      where: { id: threadId, organizationId: ctx.organizationId },
      data: {
        ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }),
        ...(unread === undefined ? {} : { hasUnread: unread }),
      },
    });
    if (res.count === 0) {
      apiLogger.warn({ msg: "crm/inbox:patch-not-found", threadId, organizationId: ctx.organizationId });
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    apiLogger.info({ msg: "crm/inbox:thread-updated", threadId, userId: ctx.userId, archived, unread });
    return NextResponse.json({ ok: true });
  } catch (err) {
    apiLogger.error({
      msg: "crm/inbox:patch-failed",
      threadId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not update the conversation" }, { status: 500 });
  }
  });
}
