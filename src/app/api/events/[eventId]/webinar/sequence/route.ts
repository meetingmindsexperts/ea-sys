import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import { WEBINAR_EMAIL_TYPES } from "@/lib/bulk-email";
import {
  enqueueWebinarSequenceForEvent,
  clearPendingWebinarSequence,
} from "@/lib/webinar-email-sequence";

type RouteParams = { params: Promise<{ eventId: string }> };

// ── GET — List webinar sequence rows for an event ─────────────────

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const rows = await db.scheduledEmail.findMany({
      where: {
        eventId,
        emailType: { in: [...WEBINAR_EMAIL_TYPES] },
      },
      orderBy: { scheduledFor: "asc" },
      select: {
        id: true,
        emailType: true,
        status: true,
        scheduledFor: true,
        sentAt: true,
        totalCount: true,
        successCount: true,
        failureCount: true,
        lastError: true,
        retryCount: true,
      },
    });

    return NextResponse.json({ rows });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-sequence:list-failed");
    return NextResponse.json(
      { error: "Failed to list webinar sequence" },
      { status: 500 },
    );
  }
}

// ── POST — Clear pending rows and re-enqueue the sequence ─────────

export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `webinar-sequence-reenqueue:${eventId}`,
      limit: 5,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn(
        { eventId, userId: session.user.id },
        "webinar-sequence:rate-limited",
      );
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const deleted = await clearPendingWebinarSequence(eventId);
    const result = await enqueueWebinarSequenceForEvent(eventId, session.user.id);

    apiLogger.info(
      { eventId, userId: session.user.id, deleted, created: result.created, skipped: result.skipped },
      "webinar-sequence:reenqueued",
    );

    return NextResponse.json({
      ok: result.ok,
      deleted,
      created: result.created,
      skipped: result.skipped,
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-sequence:reenqueue-failed");
    return NextResponse.json(
      { error: "Failed to re-enqueue webinar sequence" },
      { status: 500 },
    );
  }
}
