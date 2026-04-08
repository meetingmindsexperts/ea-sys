import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import {
  isZoomConfigured,
  createZoomMeeting,
  createZoomWebinar,
  createWebinarSeries,
  getZoomMeeting,
  getZoomWebinar,
  updateZoomMeeting,
  updateZoomWebinar,
  deleteZoomMeeting,
  deleteZoomWebinar,
  enableZoomLiveStreaming,
  enableWebinarLiveStreaming,
} from "@/lib/zoom";
import crypto from "crypto";
import type { ZoomRecurrence } from "@/lib/zoom";
import { z } from "zod";

type RouteParams = { params: Promise<{ eventId: string; sessionId: string }> };

const recurrenceSchema = z.object({
  type: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  repeat_interval: z.number().int().min(1).max(90),
  end_date_time: z.string().optional(),
  end_times: z.number().int().min(1).max(60).optional(),
  weekly_days: z.string().optional(),
  monthly_day: z.number().int().min(1).max(31).optional(),
});

const createZoomSchema = z.object({
  meetingType: z.enum(["MEETING", "WEBINAR", "WEBINAR_SERIES"]).default("MEETING"),
  passcode: z.string().max(10).optional(),
  waitingRoom: z.boolean().default(true),
  autoRecording: z.enum(["none", "local", "cloud"]).default("none"),
  syncPanelists: z.boolean().default(true),
  recurrence: recurrenceSchema.optional(),
  liveStreamEnabled: z.boolean().default(false),
});

const updateZoomSchema = z.object({
  passcode: z.string().max(10).optional(),
  waitingRoom: z.boolean().optional(),
  autoRecording: z.enum(["none", "local", "cloud"]).optional(),
});

// ── GET — Fetch Zoom meeting details for a session ─────────────────

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, sessionId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [event, zoomMeeting] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true },
      }),
      db.zoomMeeting.findUnique({
        where: { sessionId },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!zoomMeeting) {
      return NextResponse.json({ error: "No Zoom meeting linked to this session" }, { status: 404 });
    }

    return NextResponse.json(zoomMeeting);
  } catch (error) {
    apiLogger.error({ err: error }, "zoom:meeting-fetch-failed");
    return NextResponse.json({ error: "Failed to fetch Zoom meeting" }, { status: 500 });
  }
}

// ── POST — Create a Zoom meeting/webinar for a session ─────────────

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, sessionId }, body] = await Promise.all([auth(), params, req.json()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `zoom-create:${eventId}`,
      limit: 30,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ eventId, userId: session.user.id }, "zoom:create-rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const validated = createZoomSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ errors: validated.error.flatten() }, "zoom:create-validation-failed");
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    // Verify event access and get session details
    const [event, eventSession, existingZoom] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true, organizationId: true, timezone: true, slug: true },
      }),
      db.eventSession.findFirst({
        where: { id: sessionId, eventId },
        select: { id: true, name: true, startTime: true, endTime: true, description: true },
      }),
      db.zoomMeeting.findUnique({ where: { sessionId } }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!eventSession) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    if (existingZoom) {
      return NextResponse.json({ error: "Session already has a Zoom meeting" }, { status: 409 });
    }

    // Check org has Zoom configured
    const configured = await isZoomConfigured(event.organizationId);
    if (!configured) {
      return NextResponse.json({ error: "Zoom not configured for this organization" }, { status: 400 });
    }

    const duration = Math.ceil(
      (eventSession.endTime.getTime() - eventSession.startTime.getTime()) / 60000
    );

    const meetingParams = {
      topic: eventSession.name,
      startTime: eventSession.startTime.toISOString(),
      duration,
      timezone: event.timezone,
      passcode: validated.data.passcode,
      waitingRoom: validated.data.waitingRoom,
      autoRecording: validated.data.autoRecording,
      agenda: eventSession.description || undefined,
    };

    apiLogger.info(
      { eventId, sessionId, meetingType: validated.data.meetingType, userId: session.user.id },
      "zoom:create-meeting",
    );

    let zoomResponse;
    const { meetingType } = validated.data;

    if (meetingType === "MEETING") {
      zoomResponse = await createZoomMeeting(event.organizationId, meetingParams);
    } else if (meetingType === "WEBINAR") {
      zoomResponse = await createZoomWebinar(event.organizationId, meetingParams);
    } else {
      // WEBINAR_SERIES
      if (!validated.data.recurrence) {
        return NextResponse.json({ error: "Recurrence required for webinar series" }, { status: 400 });
      }
      zoomResponse = await createWebinarSeries(event.organizationId, {
        ...meetingParams,
        recurrence: validated.data.recurrence as ZoomRecurrence,
      });
    }

    // Generate stream key if live streaming enabled
    const liveStreamEnabled = validated.data.liveStreamEnabled;
    const streamKey = liveStreamEnabled ? crypto.randomUUID().replace(/-/g, "") : undefined;

    // Store in database
    const zoomMeeting = await db.zoomMeeting.create({
      data: {
        sessionId,
        eventId,
        zoomMeetingId: String(zoomResponse.id),
        meetingType,
        joinUrl: zoomResponse.join_url,
        startUrl: zoomResponse.start_url,
        passcode: zoomResponse.password || validated.data.passcode,
        duration,
        isRecurring: meetingType === "WEBINAR_SERIES",
        recurrenceType: validated.data.recurrence?.type,
        occurrences: "occurrences" in zoomResponse ? (zoomResponse.occurrences as Parameters<typeof db.zoomMeeting.create>[0]["data"]["occurrences"]) : undefined,
        zoomResponse: JSON.parse(JSON.stringify(zoomResponse)),
        liveStreamEnabled,
        streamKey,
      },
    });

    // Configure Zoom to push RTMP to MediaMTX
    if (liveStreamEnabled && streamKey) {
      const rtmpBaseUrl = process.env.RTMP_INGEST_URL || `rtmp://${new URL(process.env.NEXT_PUBLIC_APP_URL || "http://localhost").hostname}:1935/live/`;
      const pageUrl = `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/e/${event.slug}/session/${sessionId}`;

      try {
        if (meetingType === "MEETING") {
          await enableZoomLiveStreaming(event.organizationId, String(zoomResponse.id), rtmpBaseUrl, streamKey, pageUrl);
        } else {
          await enableWebinarLiveStreaming(event.organizationId, String(zoomResponse.id), rtmpBaseUrl, streamKey, pageUrl);
        }
        apiLogger.info({ zoomMeetingId: zoomMeeting.zoomMeetingId, streamKey }, "zoom:live-stream-configured");
      } catch (streamErr) {
        apiLogger.error({ err: streamErr, zoomMeetingId: zoomMeeting.zoomMeetingId }, "zoom:live-stream-config-failed");
        // Meeting was created, streaming config failed — don't fail the whole request
      }
    }

    apiLogger.info(
      { zoomMeetingId: zoomMeeting.zoomMeetingId, sessionId, meetingType, liveStreamEnabled },
      "zoom:meeting-created",
    );

    return NextResponse.json(zoomMeeting, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error }, "zoom:meeting-create-failed");
    const message = error instanceof Error ? error.message : "Failed to create Zoom meeting";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ── PUT — Update a Zoom meeting ────────────────────────────────────

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, sessionId }, body] = await Promise.all([auth(), params, req.json()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const validated = updateZoomSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ errors: validated.error.flatten() }, "zoom:update-validation-failed");
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
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

    // Update on Zoom
    if (zoomMeeting.meetingType === "MEETING") {
      await updateZoomMeeting(event.organizationId, zoomMeeting.zoomMeetingId, validated.data);
    } else {
      await updateZoomWebinar(event.organizationId, zoomMeeting.zoomMeetingId, validated.data);
    }

    // Refresh from Zoom
    const fresh = zoomMeeting.meetingType === "MEETING"
      ? await getZoomMeeting(event.organizationId, zoomMeeting.zoomMeetingId)
      : await getZoomWebinar(event.organizationId, zoomMeeting.zoomMeetingId);

    const updated = await db.zoomMeeting.update({
      where: { id: zoomMeeting.id },
      data: {
        passcode: fresh.password || validated.data.passcode,
        joinUrl: fresh.join_url,
        startUrl: fresh.start_url,
        zoomResponse: JSON.parse(JSON.stringify(fresh)),
      },
    });

    apiLogger.info({ zoomMeetingId: zoomMeeting.zoomMeetingId, sessionId }, "zoom:meeting-updated");
    return NextResponse.json(updated);
  } catch (error) {
    apiLogger.error({ err: error }, "zoom:meeting-update-failed");
    const message = error instanceof Error ? error.message : "Failed to update Zoom meeting";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ── DELETE — Remove a Zoom meeting ─────────────────────────────────

export async function DELETE(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, sessionId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

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

    // Delete on Zoom (ignore errors — meeting may already be deleted)
    try {
      if (zoomMeeting.meetingType === "MEETING") {
        await deleteZoomMeeting(event.organizationId, zoomMeeting.zoomMeetingId);
      } else {
        await deleteZoomWebinar(event.organizationId, zoomMeeting.zoomMeetingId);
      }
    } catch (err) {
      apiLogger.warn({ err, zoomMeetingId: zoomMeeting.zoomMeetingId }, "zoom:delete-from-zoom-failed");
    }

    // Delete from DB
    await db.zoomMeeting.delete({ where: { id: zoomMeeting.id } });

    apiLogger.info({ zoomMeetingId: zoomMeeting.zoomMeetingId, sessionId }, "zoom:meeting-deleted");
    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error }, "zoom:meeting-delete-failed");
    return NextResponse.json({ error: "Failed to delete Zoom meeting" }, { status: 500 });
  }
}
