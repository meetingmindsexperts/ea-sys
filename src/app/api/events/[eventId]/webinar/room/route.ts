import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { buildEventAccessWhere } from "@/lib/event-access";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, WEBINAR_STAFF_ALLOW } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { readWebinarSettings } from "@/lib/webinar";
import { controlWebinarLiveStream } from "@/lib/webinar/livestream";
import { isStreamArriving } from "@/lib/webinar/stream-probe";
import { updateEventSettings } from "@/lib/event-settings";

type RouteParams = { params: Promise<{ eventId: string }> };

const roomSchema = z.object({ open: z.boolean() });

/**
 * Producer "Open the room / Go live" control. Sets the webinar's anchor
 * EventSession.status to LIVE (open) or COMPLETED (close). The anchor session's
 * status is the single source of truth the public waiting room polls
 * (`lobby-status`) and the join gate checks — opening the room is what admits
 * waiting attendees into the live view. Re-openable (sets LIVE again).
 */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([auth(), params, req.json()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/webinar/room:POST" });
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session, { allow: WEBINAR_STAFF_ALLOW, route: "events/[eventId]/webinar/room:POST" });
    if (denied) return denied;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `webinar-room:${eventId}`,
      limit: 60,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ eventId, userId: session.user.id }, "webinar:room-rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const validated = roomSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ errors: validated.error.flatten() }, "webinar:room-validation-failed");
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 },
      );
    }

    return await runWithTenant(orgGuard.orgId, async () => {
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, slug: true, settings: true },
    });
    if (!event) {
      apiLogger.warn({ eventId, userId: session.user.id }, "webinar:room-event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const webinar = readWebinarSettings(event.settings);
    if (!webinar?.sessionId) {
      apiLogger.warn({ eventId }, "webinar:room-no-anchor-session");
      return NextResponse.json(
        { error: "This event has no webinar session to open. Re-run the provisioner first." },
        { status: 400 },
      );
    }

    // Final misconfiguration gate: opening the room in HLS mode without a
    // configured live stream would admit every attendee into a permanent
    // "getting the stream ready" screen. One click fixes it (switch the
    // viewing mode to Zoom, or enable the session's live stream) — better a
    // clear refusal now than a broken go-live.
    if (validated.data.open && webinar.viewingMode === "hls") {
      const streamConfig = await db.zoomMeeting.findFirst({
        where: { sessionId: webinar.sessionId, eventId },
        select: { liveStreamEnabled: true, streamKey: true },
      });
      if (!streamConfig?.liveStreamEnabled || !streamConfig.streamKey) {
        apiLogger.warn(
          { eventId, userId: session.user.id },
          "webinar:room-open-hls-not-configured",
        );
        return NextResponse.json(
          {
            error:
              "Can't open the room: viewing mode is Custom stream but the stream isn't set up in Zoom yet. Press Re-send stream settings to Zoom in the Waiting Room card, or switch the viewing mode to Zoom embed.",
            code: "HLS_STREAM_NOT_CONFIGURED",
          },
          { status: 400 },
        );
      }
    }

    // Record when the room opened: the auto-close job trusts a Zoom "ended"
    // time only if it is later than this (see src/lib/webinar/room-autoclose.ts).
    // Written BEFORE the status flips to LIVE (final review, Oct 2, 2026): an
    // auto-close tick between the two would otherwise judge the re-opened
    // room against the previous open time and could close it at once.
    // Locked merge of just this key, so a concurrent lobby save or provisioner
    // write is never overwritten; failure-isolated, because a bookkeeping
    // write must never stop the room from opening.
    if (validated.data.open) {
      const openedAt = new Date().toISOString();
      try {
        await updateEventSettings(event.id, (current) => {
          const currentWebinar =
            current.webinar && typeof current.webinar === "object" ? (current.webinar as Record<string, unknown>) : {};
          return { ...current, webinar: { ...currentWebinar, roomOpenedAt: openedAt } };
        });
      } catch (err) {
        apiLogger.error({ err, eventId }, "webinar:room-opened-at-write-failed");
      }
    }

    const nextStatus = validated.data.open ? "LIVE" : "COMPLETED";

    // Scope the update by eventId too so it can't touch another event's session.
    const updated = await db.eventSession.updateMany({
      where: { id: webinar.sessionId, eventId },
      data: { status: nextStatus },
    });
    if (updated.count === 0) {
      apiLogger.warn({ eventId, sessionId: webinar.sessionId }, "webinar:room-session-not-found");
      return NextResponse.json({ error: "Webinar session not found" }, { status: 404 });
    }

    apiLogger.info(
      { eventId, sessionId: webinar.sessionId, userId: session.user.id, status: nextStatus },
      validated.data.open ? "webinar:room-opened" : "webinar:room-closed",
    );

    // Custom-stream mode: tell Zoom to start pushing when the room opens and
    // to stop when it closes. Failure-isolated: the room state is already
    // saved, and the usual failure (the host has not started the webinar in
    // Zoom yet) is fixed by the console's Start stream button.
    let stream: { ok: true; alreadyLive?: true } | { ok: false; error: string } | undefined;
    if (webinar.viewingMode === "hls") {
      const [anchor, meeting] = await Promise.all([
        db.eventSession.findFirst({
          where: { id: webinar.sessionId, eventId },
          select: { name: true },
        }),
        db.zoomMeeting.findFirst({
          where: { sessionId: webinar.sessionId, eventId },
          select: { streamKey: true },
        }),
      ]);
      // The producer may have started the stream and checked it in the
      // console preview before opening the room (Oct 2, 2026). Asking Zoom to
      // start it again would at best be refused, so skip it when MediaMTX is
      // already receiving the video.
      if (validated.data.open && meeting?.streamKey && (await isStreamArriving(meeting.streamKey, { fresh: true }))) {
        apiLogger.info({ eventId, sessionId: webinar.sessionId }, "webinar:room-stream-already-arriving");
        return NextResponse.json({
          open: true,
          sessionId: webinar.sessionId,
          status: nextStatus,
          stream: { ok: true, alreadyLive: true },
        });
      }
      const result = await controlWebinarLiveStream({
        organizationId: orgGuard.orgId,
        eventId,
        eventSlug: event.slug,
        sessionId: webinar.sessionId,
        sessionName: anchor?.name ?? "Webinar",
        action: validated.data.open ? "start" : "stop",
        userId: session.user.id,
      });
      stream = result.ok ? { ok: true } : { ok: false, error: result.message };
      if (!result.ok) {
        apiLogger.warn({ eventId, code: result.code, open: validated.data.open }, "webinar:room-stream-control-failed");
      }
    }

    return NextResponse.json({
      open: validated.data.open,
      sessionId: webinar.sessionId,
      status: nextStatus,
      ...(stream ? { stream } : {}),
    });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar:room-toggle-failed");
    return NextResponse.json({ error: "Failed to update the webinar room" }, { status: 500 });
  }
}
