import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { buildEventAccessWhere } from "@/lib/event-access";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, WEBINAR_STAFF_ALLOW } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { WEBINAR_EMAIL_TYPES } from "@/lib/bulk-email";
import { rescheduleWebinarSequenceForEvent } from "@/lib/webinar-email-sequence";

type RouteParams = { params: Promise<{ eventId: string }> };

// ── GET — List webinar sequence rows for an event ─────────────────

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/webinar/sequence:GET" });
    if ("error" in orgGuard) return orgGuard.error;

    return await runWithTenant(orgGuard.orgId, async () => {
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
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
    });
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
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/webinar/sequence:POST" });
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session, { allow: WEBINAR_STAFF_ALLOW, route: "events/[eventId]/webinar/sequence:POST" });
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

    return await runWithTenant(orgGuard.orgId, async () => {
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Shared reschedule helper (clear + force re-enqueue under a per-event
    // lock): unlike the old clear-then-plain-enqueue pair, a phase that
    // already SENT no longer blocks re-creating the REMAINING phases.
    // resurrectCancelled: this button is an explicit operator action — unlike
    // the automatic retime hooks, it MAY re-create phases an operator had
    // cancelled (the pre-Aug-4 semantics of this button).
    const result = await rescheduleWebinarSequenceForEvent(eventId, session.user.id, {
      resurrectCancelled: true,
    });
    const deleted = result.cleared;

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
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-sequence:reenqueue-failed");
    return NextResponse.json(
      { error: "Failed to re-enqueue webinar sequence" },
      { status: 500 },
    );
  }
}
