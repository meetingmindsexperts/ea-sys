import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { addWebinarPanelists, listWebinarPanelists, removeWebinarPanelist } from "@/lib/zoom";

type RouteParams = { params: Promise<{ eventId: string; sessionId: string }> };

// ── POST — Sync session speakers to Zoom webinar panelists ─────────

export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, sessionId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const [event, zoomMeeting, sessionSpeakers] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true, organizationId: true },
      }),
      db.zoomMeeting.findUnique({ where: { sessionId } }),
      db.sessionSpeaker.findMany({
        where: { sessionId },
        select: {
          speaker: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!zoomMeeting) {
      return NextResponse.json({ error: "No Zoom meeting linked to this session" }, { status: 404 });
    }
    if (zoomMeeting.meetingType === "MEETING") {
      return NextResponse.json({ error: "Panelists are only available for webinars" }, { status: 400 });
    }

    const panelists = sessionSpeakers
      .filter((ss) => ss.speaker.email)
      .map((ss) => ({
        name: `${ss.speaker.firstName} ${ss.speaker.lastName}`.trim(),
        email: ss.speaker.email,
      }));

    if (panelists.length === 0) {
      return NextResponse.json({ error: "No speakers with email addresses found" }, { status: 400 });
    }

    await addWebinarPanelists(event.organizationId, zoomMeeting.zoomMeetingId, panelists);

    apiLogger.info(
      { sessionId, panelistCount: panelists.length, zoomMeetingId: zoomMeeting.zoomMeetingId },
      "zoom:panelists-synced",
    );

    return NextResponse.json({ success: true, count: panelists.length });
  } catch (error) {
    apiLogger.error({ err: error }, "zoom:panelists-sync-failed");
    const message = error instanceof Error ? error.message : "Failed to sync panelists";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ── GET — List current webinar panelists ───────────────────────────

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, sessionId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [event, zoomMeeting] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true, organizationId: true },
      }),
      db.zoomMeeting.findUnique({ where: { sessionId } }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!zoomMeeting) {
      return NextResponse.json({ error: "No Zoom meeting linked to this session" }, { status: 404 });
    }
    if (zoomMeeting.meetingType === "MEETING") {
      return NextResponse.json({ error: "Panelists are only available for webinars" }, { status: 400 });
    }

    const panelists = await listWebinarPanelists(event.organizationId, zoomMeeting.zoomMeetingId);
    return NextResponse.json({ panelists });
  } catch (error) {
    apiLogger.error({ err: error }, "zoom:panelists-list-failed");
    return NextResponse.json({ error: "Failed to list panelists" }, { status: 500 });
  }
}

// ── DELETE — Remove a panelist ─────────────────────────────────────

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, sessionId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const url = new URL(req.url);
    const panelistId = url.searchParams.get("panelistId");
    if (!panelistId) {
      return NextResponse.json({ error: "panelistId query param required" }, { status: 400 });
    }

    const [event, zoomMeeting] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true, organizationId: true },
      }),
      db.zoomMeeting.findUnique({ where: { sessionId } }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!zoomMeeting) {
      return NextResponse.json({ error: "No Zoom meeting linked to this session" }, { status: 404 });
    }

    await removeWebinarPanelist(event.organizationId, zoomMeeting.zoomMeetingId, panelistId);

    apiLogger.info({ sessionId, panelistId }, "zoom:panelist-removed");
    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error }, "zoom:panelist-remove-failed");
    return NextResponse.json({ error: "Failed to remove panelist" }, { status: 500 });
  }
}
