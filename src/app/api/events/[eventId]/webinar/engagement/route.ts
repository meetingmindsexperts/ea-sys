import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import { readWebinarSettings } from "@/lib/webinar";
import { syncWebinarEngagement } from "@/lib/webinar-engagement";

type RouteParams = { params: Promise<{ eventId: string }> };

// ── GET — return polls + Q&A for the webinar's anchor session ─────

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
      return NextResponse.json(
        { error: "No anchor session. Run the webinar provisioner first." },
        { status: 400 },
      );
    }

    const zoomMeeting = await db.zoomMeeting.findUnique({
      where: { sessionId: anchorSessionId },
      select: { id: true, lastEngagementSyncAt: true },
    });
    if (!zoomMeeting) {
      return NextResponse.json({ polls: [], questions: [], lastSyncedAt: null });
    }

    const [polls, questions] = await Promise.all([
      db.webinarPoll.findMany({
        where: { zoomMeetingId: zoomMeeting.id },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          title: true,
          questions: true,
          createdAt: true,
          responses: {
            orderBy: { submittedAt: "asc" },
            select: {
              id: true,
              participantName: true,
              participantEmail: true,
              answers: true,
              submittedAt: true,
            },
          },
        },
      }),
      db.webinarQuestion.findMany({
        where: { zoomMeetingId: zoomMeeting.id },
        orderBy: { askedAt: "asc" },
        select: {
          id: true,
          askerName: true,
          askerEmail: true,
          question: true,
          answer: true,
          answeredByName: true,
          askedAt: true,
        },
      }),
    ]);

    return NextResponse.json({
      polls,
      questions,
      lastSyncedAt: zoomMeeting.lastEngagementSyncAt?.toISOString() ?? null,
    });
  } catch (err) {
    apiLogger.error({ err }, "webinar-engagement:list-failed");
    return NextResponse.json({ error: "Failed to load engagement" }, { status: 500 });
  }
}

// ── POST — manual engagement re-sync ───────────────────────────────

export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `webinar-engagement-sync:${eventId}`,
      limit: 10,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn(
        { eventId, userId: session.user.id },
        "webinar-engagement:rate-limited",
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
        "webinar-engagement:manual-sync-no-anchor-session",
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
        "webinar-engagement:manual-sync-no-zoom-meeting",
      );
      return NextResponse.json(
        { error: "No Zoom webinar attached to the anchor session." },
        { status: 400 },
      );
    }

    const result = await syncWebinarEngagement(zoomMeeting.id);

    apiLogger.info(
      {
        eventId,
        zoomMeetingDbId: zoomMeeting.id,
        status: result.status,
        userId: session.user.id,
      },
      "webinar-engagement:manual-sync",
    );

    return NextResponse.json(result);
  } catch (err) {
    apiLogger.error({ err }, "webinar-engagement:manual-sync-failed");
    return NextResponse.json(
      { error: "Failed to sync engagement" },
      { status: 500 },
    );
  }
}
