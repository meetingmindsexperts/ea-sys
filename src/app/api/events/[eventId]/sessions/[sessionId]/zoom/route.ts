import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, WEBINAR_STAFF_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { webinarSecondRoomViolation, readWebinarSettings } from "@/lib/webinar";
import {
  isZoomConfigured,
  createZoomMeeting,
  createZoomWebinar,
  createWebinarSeries,
  getZoomMeeting,
  getZoomWebinar,
  updateZoomMeeting,
  updateZoomWebinar,
  enableZoomLiveStreaming,
  enableWebinarLiveStreaming,
} from "@/lib/zoom";
import crypto from "crypto";
import { deleteRemoteZoomMeeting } from "@/lib/zoom/cleanup";
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
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/sessions/[sessionId]/zoom:GET" });
    if ("error" in orgGuard) return orgGuard.error;

    return await runWithTenant(orgGuard.orgId, async () => {
    const [event, zoomMeeting] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        select: { id: true },
      }),
      // eventId in the where binds the session to THIS event — without it a
      // caller who owns the URL's event could read another org's ZoomMeeting
      // (incl. startUrl, the host credential) by passing a foreign sessionId.
      db.zoomMeeting.findFirst({
        where: { sessionId, eventId },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!zoomMeeting) {
      return NextResponse.json({ error: "No Zoom meeting linked to this session" }, { status: 404 });
    }

    return NextResponse.json(zoomMeeting);
    });
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
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/sessions/[sessionId]/zoom:POST" });
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session, { allow: WEBINAR_STAFF_ALLOW });
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

    return await runWithTenant(orgGuard.orgId, async () => {
    // Verify event access and get session details
    const [event, eventSession, existingZoom] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        select: { id: true, organizationId: true, timezone: true, slug: true, eventType: true, settings: true },
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

    // Shared second-room guard (see webinarSecondRoomViolation): a Zoom
    // meeting on any session but the anchor splits attendees from the
    // producer. Creation on the anchor itself stays allowed (that's the
    // delete-and-recreate path, e.g. to enable live streaming).
    const meetingTypeRequested = validated.data.meetingType;
    const anchorSessionId = webinarSecondRoomViolation(event.eventType, event.settings, sessionId);
    if (anchorSessionId) {
      apiLogger.warn(
        { eventId, sessionId, anchorSessionId, userId: session.user.id },
        "zoom:webinar-non-anchor-create-refused",
      );
      return NextResponse.json(
        {
          error:
            "This is a Webinar event — it runs in a single Zoom webinar on its main session. Creating a second Zoom meeting here would split attendees from the broadcast. Manage the webinar from the Webinar Console; to change its Zoom setup, delete and recreate the Zoom webinar on the main session.",
          code: "WEBINAR_ANCHOR_ONLY",
          anchorSessionId,
        },
        { status: 409 },
      );
    }

    // The anchor session of a WEBINAR event must carry a Zoom WEBINAR, never a
    // plain meeting.
    //
    // This is reachable through the ordinary UI: the only way to enable live
    // streaming on an existing session is to delete the Zoom meeting and create
    // it again (the PUT is a refresh and does not persist streaming), and the
    // create form's type defaults to whatever `Event.settings.zoom.defaultMeetingType`
    // says — which is "MEETING" on events that never set it, INCLUDING
    // WEBINAR-type events. So the documented recovery procedure silently
    // downgrades a webinar to a meeting unless the operator notices a dropdown.
    //
    // A downgrade is not a cosmetic difference. Panelists stop working (the
    // panelists route refuses meetingType MEETING), attendance/polls/Q&A break
    // (they call /report/webinars/... which does not exist for meetings), and
    // attendees gain the ability to unmute. Refuse it rather than document it.
    if (event.eventType === "WEBINAR" && meetingTypeRequested === "MEETING") {
      const webinar = readWebinarSettings(event.settings);
      if (webinar?.sessionId === sessionId) {
        apiLogger.warn(
          { eventId, sessionId, userId: session.user.id },
          "zoom:webinar-anchor-meeting-type-refused",
        );
        return NextResponse.json(
          {
            error:
              "This is the main session of a Webinar event, so it must host a Zoom Webinar rather than a Meeting. Set Meeting Type to \"Webinar\" and try again.",
            code: "WEBINAR_ANCHOR_REQUIRES_WEBINAR",
          },
          { status: 400 },
        );
      }
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

    // Store in database.
    //
    // H2 (program/agenda review): the `existingZoom` check above is check-then-act.
    // Two concurrent POSTs both pass it and both call Zoom's create API — the
    // `ZoomMeeting.sessionId @unique` constraint then rejects only the second
    // ROW, leaving the second REMOTE meeting orphaned on Zoom: still billable,
    // still joinable via its joinUrl, with no local record to find it by.
    // The loser now tears down the meeting it just created and reports the 409
    // the pre-flight check intended.
    let zoomMeeting;
    try {
      zoomMeeting = await db.zoomMeeting.create({
        data: {
          sessionId,
          eventId,
          organizationId: event.organizationId,
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
    } catch (err) {
      const isUniqueViolation =
        typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
      if (!isUniqueViolation) throw err;

      apiLogger.warn(
        { eventId, sessionId, zoomMeetingId: String(zoomResponse.id) },
        "zoom:create-lost-race-rolling-back-remote-meeting",
      );
      const cleaned = await deleteRemoteZoomMeeting({
        organizationId: event.organizationId,
        meetingType,
        zoomMeetingId: String(zoomResponse.id),
        reason: "create-conflict-rollback",
      });
      if (!cleaned) {
        // Loud: an orphaned meeting is now consuming the org's Zoom capacity
        // and nothing in the app points at it.
        apiLogger.error(
          { eventId, sessionId, zoomMeetingId: String(zoomResponse.id), meetingType },
          "zoom:orphaned-remote-meeting-needs-manual-cleanup",
        );
      }
      return NextResponse.json(
        { error: "Session already has a Zoom meeting", code: "ZOOM_MEETING_EXISTS" },
        { status: 409 },
      );
    }

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
    });
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
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/sessions/[sessionId]/zoom:PUT" });
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session, { allow: WEBINAR_STAFF_ALLOW });
    if (denied) return denied;

    const validated = updateZoomSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ errors: validated.error.flatten() }, "zoom:update-validation-failed");
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    return await runWithTenant(orgGuard.orgId, async () => {
    const [event, zoomMeeting] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        select: { id: true, organizationId: true },
      }),
      // eventId binds the session to THIS event — without it a caller who owns
      // the URL's event could update another org's ZoomMeeting via a foreign
      // sessionId (cross-tenant IDOR; the POST above always did this correctly).
      db.zoomMeeting.findFirst({ where: { sessionId, eventId } }),
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

    // Compound-where: the event binding is atomic with the write (defence #1);
    // organizationId also self-heals any blue-green-window NULL.
    const updated = await db.zoomMeeting.update({
      where: { id: zoomMeeting.id, eventId },
      data: {
        organizationId: event.organizationId,
        passcode: fresh.password || validated.data.passcode,
        joinUrl: fresh.join_url,
        startUrl: fresh.start_url,
        zoomResponse: JSON.parse(JSON.stringify(fresh)),
      },
    });

    apiLogger.info({ zoomMeetingId: zoomMeeting.zoomMeetingId, sessionId }, "zoom:meeting-updated");
    return NextResponse.json(updated);
    });
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
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/sessions/[sessionId]/zoom:DELETE" });
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session, { allow: WEBINAR_STAFF_ALLOW });
    if (denied) return denied;

    return await runWithTenant(orgGuard.orgId, async () => {
    const [event, zoomMeeting] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        select: { id: true, organizationId: true },
      }),
      // eventId binds the session to THIS event — without it a caller who owns
      // the URL's event could delete another org's ZoomMeeting (DB row AND the
      // remote billable Zoom meeting) via a foreign sessionId.
      db.zoomMeeting.findFirst({ where: { sessionId, eventId } }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!zoomMeeting) {
      return NextResponse.json({ error: "No Zoom meeting linked to this session" }, { status: 404 });
    }

    // Delete on Zoom (shared helper — never throws; meeting may already be gone).
    await deleteRemoteZoomMeeting({
      organizationId: event.organizationId,
      meetingType: zoomMeeting.meetingType,
      zoomMeetingId: zoomMeeting.zoomMeetingId,
      reason: "zoom-route-delete",
    });

    // Delete from DB (compound-where: event binding atomic with the delete)
    await db.zoomMeeting.delete({ where: { id: zoomMeeting.id, eventId } });

    apiLogger.info({ zoomMeetingId: zoomMeeting.zoomMeetingId, sessionId }, "zoom:meeting-deleted");
    return NextResponse.json({ success: true });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "zoom:meeting-delete-failed");
    return NextResponse.json({ error: "Failed to delete Zoom meeting" }, { status: 500 });
  }
}
