import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { publicEventWhere } from "@/lib/public-event";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { generateZoomSignatureForOrg } from "@/lib/zoom";
import { hlsPlaybackUrls, pickSessionStream, SESSION_STREAM_SELECT } from "@/lib/webinar/session-stream";
import { isEventOrgStaff } from "@/lib/permissions/org-staff";
import {
  isViewerRoomOpen,
  viewerRefusal,
  viewerRegistrationWhere,
  VIEWER_REFUSAL_MESSAGE,
} from "@/lib/webinar/viewer-entitlement";

type RouteParams = { params: Promise<{ slug: string; sessionId: string }> };

const JOINABLE_BEFORE_START_MS = 15 * 60 * 1000; // 15 minutes before start

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ slug, sessionId }, authSession] = await Promise.all([params, auth()]);

    // Rate limit by IP
    const ip = getClientIp(req);
    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `zoom-join:${ip}`,
      limit: 60,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ ip }, "zoom:join-rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    // Require a logged-in user — we gate attendees on our side rather than
    // through Zoom's registrant flow, so the SDK signature endpoint is the
    // single chokepoint.
    if (!authSession?.user) {
      apiLogger.warn({ ip, sessionId }, "zoom:join-denied:unauthenticated");
      return NextResponse.json(
        { error: "Sign in required to join this webinar", code: "UNAUTHENTICATED" },
        { status: 401 },
      );
    }

    // Find event by slug (tenant-scoped) — include organizationId for SDK credentials
    const event = await db.event.findFirst({
      where: await publicEventWhere(req, slug, { statuses: ["DRAFT", "PUBLISHED", "LIVE"] }),
      select: { id: true, organizationId: true, status: true, eventType: true, settings: true },
    });

    if (!event) {
      apiLogger.warn({ slug, sessionId, ip }, "zoom:join-event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return await runWithTenant(event.organizationId, async () => {
    // Authorization: either the user is org staff (for QA / host testing)
    // or they hold a registration that may watch (viewer-entitlement.ts: on a
    // webinar, confirmed and paid or free; not pending approval).
    const isOrgStaff = isEventOrgStaff(authSession.user, event.organizationId);

    let attendeeName = "";
    let attendeeEmail = "";
    if (isOrgStaff) {
      attendeeName = `${authSession.user.firstName ?? ""} ${authSession.user.lastName ?? ""}`.trim();
      attendeeEmail = authSession.user.email ?? "";
    } else {
      const registration = await db.registration.findFirst({
        where: viewerRegistrationWhere(event.id, authSession.user.id, event.eventType),
        select: {
          id: true,
          attendee: { select: { firstName: true, lastName: true, email: true } },
        },
      });
      if (!registration?.attendee) {
        const refusal = await viewerRefusal(event.id, authSession.user.id);
        if (refusal) {
          apiLogger.warn(
            { userId: authSession.user.id, eventId: event.id, sessionId, refusal },
            "zoom:join-denied:registration-not-active",
          );
          return NextResponse.json({ error: VIEWER_REFUSAL_MESSAGE[refusal], code: refusal }, { status: 403 });
        }
        apiLogger.warn(
          { userId: authSession.user.id, eventId: event.id, sessionId },
          "zoom:join-denied:not-registered",
        );
        return NextResponse.json(
          {
            error: "You must be registered for this event to join the webinar",
            code: "NOT_REGISTERED",
          },
          { status: 403 },
        );
      }
      attendeeName =
        `${registration.attendee.firstName} ${registration.attendee.lastName}`.trim();
      attendeeEmail = registration.attendee.email;
    }

    // Find session with its Zoom meeting
    const session = await db.eventSession.findFirst({
      where: { id: sessionId, eventId: event.id },
      select: {
        id: true,
        name: true,
        startTime: true,
        endTime: true,
        status: true,
        zoomMeeting: {
          select: {
            zoomMeetingId: true,
            meetingType: true,
            joinUrl: true,
            passcode: true,
            status: true,
            isRecurring: true,
            occurrences: true,
            liveStreamEnabled: true,
            streamKey: true,
            streamStatus: true,
          },
        },
        externalStream: SESSION_STREAM_SELECT.externalStream,
      },
    });

    if (!session) {
      apiLogger.warn({ sessionId, eventId: event.id, userId: authSession.user.id }, "zoom:join-session-not-found");
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Our Zoom's stream or a partner's (session-stream.ts): what the player is given below.
    const stream = pickSessionStream(session);

    // A partner-produced webinar has no Zoom meeting of ours and is watched as
    // the stream alone (external streams step 4). Anything else without a Zoom
    // meeting has nothing to join.
    const zoomMeeting = session.zoomMeeting;
    if (!zoomMeeting && stream?.source !== "external") {
      apiLogger.warn({ sessionId, eventId: event.id, userId: authSession.user.id }, "zoom:join-no-meeting");
      return NextResponse.json({ error: "No Zoom meeting for this session" }, { status: 404 });
    }
    const meetingType = zoomMeeting?.meetingType ?? "WEBINAR";

    // Check timing: allow join if session is LIVE, starts within 15 minutes,
    // or event is in DRAFT mode (for testing)
    const now = Date.now();
    const startTime = session.startTime.getTime();
    const endTime = session.endTime.getTime();
    const isLive = session.status === "LIVE" || (now >= startTime && now <= endTime);
    const isUpcoming = startTime - now <= JOINABLE_BEFORE_START_MS && startTime > now;
    const isDraftEvent = event.status === "DRAFT";

    // Org staff bypass the window (Aug 10, 2026). `isOrgStaff` is computed
    // above and its comment already says it exists "for QA / host testing" —
    // but the clock below then blocked exactly that, so rehearsing a webinar
    // meant keeping the event in DRAFT, and publishing it silently removed the
    // producer's ability to open their own attendee view. Five prod refusals in
    // one morning, one of them against a session starting the NEXT DAY.
    // The public detail route already exempts staff in this same area; this
    // route computed the flag and then didn't use it here.
    if (isOrgStaff && !isLive && !isUpcoming && !isDraftEvent) {
      apiLogger.info(
        { sessionId, eventId: event.id, userId: authSession.user.id, startsAt: session.startTime.toISOString() },
        "zoom:join-staff-preview-outside-window",
      );
    }

    if (!isOrgStaff && !isLive && !isUpcoming && !isDraftEvent) {
      apiLogger.warn(
        { sessionId, eventId: event.id, userId: authSession.user.id, startsAt: session.startTime.toISOString() },
        "zoom:join-denied:not-joinable-yet",
      );
      return NextResponse.json(
        {
          error: "Session is not currently joinable",
          startsAt: session.startTime.toISOString(),
          joinableAt: new Date(startTime - JOINABLE_BEFORE_START_MS).toISOString(),
        },
        { status: 403 },
      );
    }

    // The producer's waiting room, enforced here (security review W-02): until
    // the anchor session is LIVE an attendee gets the page's waiting state and
    // nothing that admits them, no Zoom signature, join link, passcode or
    // stream URL. The page fetches again when lobby-status says the room
    // opened. Org staff keep their preview.
    if (!isOrgStaff && !(await isViewerRoomOpen(event, sessionId))) {
      apiLogger.info({ sessionId, eventId: event.id, userId: authSession.user.id }, "zoom:join-waiting-room-closed");
      return NextResponse.json({
        mode: "waiting",
        joinUrl: "",
        meetingType,
        sessionName: session.name,
        userName: attendeeName,
        userEmail: attendeeEmail,
        liveStreamEnabled: Boolean(stream),
      });
    }

    // Build streaming info if live stream is enabled. HLS is CDN-served at
    // scale (HLS_CDN_BASE → CloudFront); falls back to the app origin when unset.
    const urls = stream ? hlsPlaybackUrls(stream.streamKey) : null;
    const streamingFields = stream && urls
      ? {
          liveStreamEnabled: true,
          hlsPlaybackUrl: urls.hlsUrl,
          hlsOriginUrl: urls.hlsOriginUrl,
          streamStatus: stream.streamStatus,
        }
      : { liveStreamEnabled: false };

    // A partner's stream: the player and nothing else. No Zoom signature, join
    // link or passcode exists to send.
    if (!zoomMeeting) {
      apiLogger.info({ sessionId, eventId: event.id, userId: authSession.user.id }, "zoom:join-partner-stream");
      return NextResponse.json({
        mode: "stream",
        joinUrl: "",
        meetingType,
        sessionName: session.name,
        userName: attendeeName,
        userEmail: attendeeEmail,
        ...streamingFields,
      });
    }

    // Generate SDK signature using org-level credentials
    const sdkResult = await generateZoomSignatureForOrg(
      event.organizationId,
      zoomMeeting.zoomMeetingId,
      0, // role = attendee
    );

    if (!sdkResult) {
      // SDK not configured — fall back to join URL (opens in Zoom app)
      apiLogger.info({ sessionId, meetingType: zoomMeeting.meetingType }, "zoom:join-via-url");
      return NextResponse.json({
        mode: "url",
        joinUrl: zoomMeeting.joinUrl,
        passcode: zoomMeeting.passcode,
        meetingType: zoomMeeting.meetingType,
        sessionName: session.name,
        userName: attendeeName,
        userEmail: attendeeEmail,
        ...streamingFields,
      });
    }

    apiLogger.info(
      { sessionId, meetingType: zoomMeeting.meetingType, userId: authSession.user.id },
      "zoom:join-via-sdk",
    );

    return NextResponse.json({
      mode: "sdk",
      sdkKey: sdkResult.sdkKey,
      signature: sdkResult.signature,
      meetingNumber: zoomMeeting.zoomMeetingId,
      passcode: zoomMeeting.passcode || "",
      meetingType: zoomMeeting.meetingType,
      sessionName: session.name,
      joinUrl: zoomMeeting.joinUrl,
      userName: attendeeName,
      userEmail: attendeeEmail,
      ...streamingFields,
    });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "zoom:join-failed");
    return NextResponse.json({ error: "Failed to get join info" }, { status: 500 });
  }
}
