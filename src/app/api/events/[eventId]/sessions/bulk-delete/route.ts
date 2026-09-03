/**
 * POST /api/events/[eventId]/sessions/bulk-delete
 *
 * Delete several sessions in one call (organiser request, Sep 2 2026: clearing
 * an agenda one card at a time). Every guard the single DELETE applies, applied
 * per row:
 *   - the WEBINAR anchor session is refused and REPORTED, never silently
 *     skipped (deleting it strands settings.webinar.sessionId, see the single
 *     route's H3 comment);
 *   - each linked Zoom meeting is torn down BEFORE the local rows go, through
 *     the helper that never throws, so a Zoom outage cannot block the delete;
 *   - everything is event-bound, so an id from another event is "not found",
 *     not deleted.
 * The local delete is ONE `deleteMany`, so it is atomic: either every
 * deletable row goes or none does. Partial outcomes (refused anchor, unknown
 * ids) come back per row rather than as a failed request.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, WEBINAR_STAFF_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { refreshEventStats } from "@/lib/event-stats";
import { readWebinarSettings } from "@/lib/webinar";
import { deleteRemoteZoomMeeting } from "@/lib/zoom/cleanup";

export const MAX_BULK_DELETE = 200;

const bodySchema = z.object({
  sessionIds: z.array(z.string().min(1).max(100)).min(1).max(MAX_BULK_DELETE),
});

type RouteParams = { params: Promise<{ eventId: string }> };

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([
      auth(),
      params,
      req.json().catch(() => null),
    ]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session, {
      allow: WEBINAR_STAFF_ALLOW,
      route: "events/[eventId]/sessions/bulk-delete:POST",
    });
    if (denied) return denied;

    // A destructive endpoint that can reach Zoom up to 200 times per call gets
    // its own budget (review, Sep 2 2026). Per user, since the audit row and
    // the Zoom teardown reason both name the person.
    const rl = checkRateLimit({
      key: `sessions-bulk-delete:${session.user.id}`,
      limit: 30,
      windowMs: 3600_000,
    });
    if (!rl.allowed) {
      return rateLimited(rl, {
        route: "events/[eventId]/sessions/bulk-delete:POST",
        eventId,
        userId: session.user.id,
        limit: 30,
        windowSeconds: 3600,
      });
    }

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({
        msg: "sessions-bulk-delete:validation-failed",
        eventId,
        userId: session.user.id,
        errors: parsed.error.flatten(),
      });
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    // Dedupe so a repeated id cannot inflate the count or double-tear-down.
    const requested = Array.from(new Set(parsed.data.sessionIds));

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true, settings: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "sessions-bulk-delete:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return await runWithTenant(event.organizationId, async () => {
      const rows = await db.eventSession.findMany({
        where: { id: { in: requested }, eventId },
        select: {
          id: true,
          name: true,
          zoomMeeting: { select: { zoomMeetingId: true, meetingType: true } },
        },
      });
      const found = new Set(rows.map((r) => r.id));
      const notFound = requested.filter((id) => !found.has(id));

      const anchorId = readWebinarSettings(event.settings)?.sessionId ?? null;
      const skipped: Array<{ id: string; name: string; code: "WEBINAR_ANCHOR_SESSION" }> = [];
      const deletable = rows.filter((r) => {
        if (anchorId && r.id === anchorId) {
          skipped.push({ id: r.id, name: r.name, code: "WEBINAR_ANCHOR_SESSION" });
          return false;
        }
        return true;
      });
      if (skipped.length > 0) {
        apiLogger.warn({
          msg: "sessions-bulk-delete:webinar-anchor-refused",
          eventId,
          userId: session.user.id,
          sessionId: skipped[0].id,
        });
      }

      // Remote teardown first, per row, never throws (see lib/zoom/cleanup).
      for (const r of deletable) {
        if (!r.zoomMeeting) continue;
        await deleteRemoteZoomMeeting({
          organizationId: event.organizationId,
          meetingType: r.zoomMeeting.meetingType,
          zoomMeetingId: r.zoomMeeting.zoomMeetingId,
          reason: "session-bulk-delete",
        });
      }

      const deletedIds = deletable.map((r) => r.id);
      let deletedCount = 0;
      if (deletedIds.length > 0) {
        const result = await db.eventSession.deleteMany({
          where: { id: { in: deletedIds }, eventId },
        });
        deletedCount = result.count;
        refreshEventStats(eventId);
      }

      // One audit row for the batch; the per-row detail is in the response.
      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "DELETE",
            entityType: "EventSession",
            entityId: `bulk:${deletedCount}`,
            changes: {
              bulk: true,
              deletedIds,
              deleted: deletable.map((r) => ({ id: r.id, name: r.name })),
              skipped,
              notFound,
              ip: getClientIp(req),
            },
          },
        })
        .catch((err: unknown) =>
          apiLogger.error({ err, msg: "sessions-bulk-delete:audit-failed", eventId }),
        );

      apiLogger.info({
        msg: "sessions-bulk-delete:done",
        eventId,
        userId: session.user.id,
        requested: requested.length,
        deletedCount,
        skipped: skipped.length,
        notFound: notFound.length,
      });

      return NextResponse.json({ deletedCount, deletedIds, skipped, notFound });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "sessions-bulk-delete:failed" });
    return NextResponse.json({ error: "Failed to delete sessions" }, { status: 500 });
  }
}
