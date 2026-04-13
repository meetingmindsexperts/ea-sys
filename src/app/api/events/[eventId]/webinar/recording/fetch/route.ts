import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import { readWebinarSettings } from "@/lib/webinar";
import { syncRecordingForZoomMeeting } from "@/lib/webinar-recording-sync";

type RouteParams = { params: Promise<{ eventId: string }> };

// POST — manually refetch the recording for this event's anchor webinar.
// Admins use this when they don't want to wait for the cron.
export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `webinar-recording-fetch:${eventId}`,
      limit: 10,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn(
        { eventId, userId: session.user.id },
        "webinar-recording:rate-limited",
      );
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true, settings: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const webinar = readWebinarSettings(event.settings);
    const anchorSessionId = webinar?.sessionId;
    if (!anchorSessionId) {
      apiLogger.warn(
        { eventId, userId: session.user.id },
        "webinar-recording:manual-refetch-no-anchor-session",
      );
      return NextResponse.json(
        { error: "No anchor session. Run the webinar provisioner first." },
        { status: 400 },
      );
    }

    const zoomMeeting = await db.zoomMeeting.findUnique({
      where: { sessionId: anchorSessionId },
      select: { id: true },
    });
    if (!zoomMeeting) {
      apiLogger.warn(
        { eventId, anchorSessionId, userId: session.user.id },
        "webinar-recording:manual-refetch-no-zoom-meeting",
      );
      return NextResponse.json(
        { error: "No Zoom webinar attached to the anchor session." },
        { status: 400 },
      );
    }

    // If the user explicitly re-triggers a FAILED or EXPIRED row, reset it to
    // NOT_REQUESTED so the sync helper will attempt the fetch again.
    await db.zoomMeeting.updateMany({
      where: {
        id: zoomMeeting.id,
        recordingStatus: { in: ["FAILED", "EXPIRED"] },
      },
      data: { recordingStatus: "NOT_REQUESTED" },
    });

    const result = await syncRecordingForZoomMeeting(zoomMeeting.id);

    apiLogger.info(
      { eventId, zoomMeetingDbId: zoomMeeting.id, status: result.status, userId: session.user.id },
      "webinar-recording:manual-refetch",
    );

    return NextResponse.json(result);
  } catch (err) {
    apiLogger.error({ err }, "webinar-recording:manual-refetch-failed");
    return NextResponse.json(
      { error: "Failed to fetch recording" },
      { status: 500 },
    );
  }
}
