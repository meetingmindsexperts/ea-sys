import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp } from "@/lib/security";

interface RouteParams {
  params: Promise<{ eventId: string; id: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, id }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    // Atomic retry — only succeeds if the row is still FAILED.
    const result = await db.scheduledEmail.updateMany({
      where: {
        id,
        eventId,
        organizationId: session.user.organizationId!,
        status: "FAILED",
      },
      data: {
        status: "PENDING",
        scheduledFor: new Date(Date.now() + 60 * 1000),
        retryCount: { increment: 1 },
        lastError: null,
        sentAt: null,
      },
    });

    if (result.count === 0) {
      const existing = await db.scheduledEmail.findFirst({
        where: { id, eventId, organizationId: session.user.organizationId! },
        select: { status: true },
      });
      if (!existing) {
        return NextResponse.json({ error: "Scheduled email not found" }, { status: 404 });
      }
      apiLogger.warn({
        msg: "scheduled-email:retry-rejected",
        id,
        status: existing.status,
      });
      return NextResponse.json(
        { error: `Can only retry FAILED scheduled emails (current: ${existing.status})` },
        { status: 409 }
      );
    }

    const updated = await db.scheduledEmail.findUnique({ where: { id } });

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "SCHEDULED_EMAIL_RETRIED",
          entityType: "ScheduledEmail",
          entityId: id,
          changes: { retryCount: updated?.retryCount ?? 0, ip: getClientIp(req) },
        },
      })
      .catch((err) =>
        apiLogger.error({ err, msg: "Failed to write SCHEDULED_EMAIL_RETRIED audit log", id })
      );

    return NextResponse.json({ success: true, scheduledEmail: updated });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error retrying scheduled email" });
    return NextResponse.json({ error: "Failed to retry scheduled email" }, { status: 500 });
  }
}
