import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { generateZoomSignatureForOrg } from "@/lib/zoom";

type RouteParams = { params: Promise<{ slug: string; sessionId: string }> };

const JOINABLE_BEFORE_START_MS = 15 * 60 * 1000; // 15 minutes before start

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug, sessionId } = await params;

    // Rate limit by IP
    const ip = getClientIp(req);
    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `zoom-join:${ip}`,
      limit: 60,
      windowMs: 3600_000,
    });
    if (!allowed) {
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    // Find event by slug — include organizationId for SDK credentials
    const event = await db.event.findFirst({
      where: {
        slug,
        status: { in: ["PUBLISHED", "LIVE"] },
      },
      select: { id: true, organizationId: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
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
          },
        },
      },
    });

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (!session.zoomMeeting) {
      return NextResponse.json({ error: "No Zoom meeting for this session" }, { status: 404 });
    }

    // Check timing: allow join if session is LIVE, or starts within 15 minutes
    const now = Date.now();
    const startTime = session.startTime.getTime();
    const endTime = session.endTime.getTime();
    const isLive = session.status === "LIVE" || (now >= startTime && now <= endTime);
    const isUpcoming = startTime - now <= JOINABLE_BEFORE_START_MS && startTime > now;

    if (!isLive && !isUpcoming) {
      return NextResponse.json(
        {
          error: "Session is not currently joinable",
          startsAt: session.startTime.toISOString(),
          joinableAt: new Date(startTime - JOINABLE_BEFORE_START_MS).toISOString(),
        },
        { status: 403 },
      );
    }

    // Generate SDK signature using org-level credentials
    const sdkResult = await generateZoomSignatureForOrg(
      event.organizationId,
      session.zoomMeeting.zoomMeetingId,
      0, // role = attendee
    );

    if (!sdkResult) {
      // SDK not configured — fall back to join URL (opens in Zoom app)
      apiLogger.info({ sessionId, meetingType: session.zoomMeeting.meetingType }, "zoom:join-via-url");
      return NextResponse.json({
        mode: "url",
        joinUrl: session.zoomMeeting.joinUrl,
        passcode: session.zoomMeeting.passcode,
        meetingType: session.zoomMeeting.meetingType,
        sessionName: session.name,
      });
    }

    apiLogger.info({ sessionId, meetingType: session.zoomMeeting.meetingType }, "zoom:join-via-sdk");

    return NextResponse.json({
      mode: "sdk",
      sdkKey: sdkResult.sdkKey,
      signature: sdkResult.signature,
      meetingNumber: session.zoomMeeting.zoomMeetingId,
      passcode: session.zoomMeeting.passcode || "",
      meetingType: session.zoomMeeting.meetingType,
      sessionName: session.name,
      joinUrl: session.zoomMeeting.joinUrl, // fallback
    });
  } catch (error) {
    apiLogger.error({ err: error }, "zoom:join-failed");
    return NextResponse.json({ error: "Failed to get join info" }, { status: 500 });
  }
}
