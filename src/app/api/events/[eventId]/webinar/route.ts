import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import { updateEventSettings } from "@/lib/event-settings";
import { readWebinarSettings, type WebinarSettings } from "@/lib/webinar";
import { isValidLobbyVideoUrl } from "@/lib/webinar/lobby-video";
import { provisionWebinar } from "@/lib/webinar-provisioner";
import { enableWebinarQA } from "@/lib/zoom";

type RouteParams = { params: Promise<{ eventId: string }> };

const updateWebinarSchema = z.object({
  autoProvisionZoom: z.boolean().optional(),
  defaultPasscode: z.string().max(10).optional(),
  waitingRoom: z.boolean().optional(),
  autoRecording: z.enum(["none", "local", "cloud"]).optional(),
  automationEnabled: z.boolean().optional(),
  // Waiting room / lobby config
  viewingMode: z.enum(["zoom", "hls"]).optional(),
  // Empty string clears the field; otherwise must be a YouTube/Vimeo URL.
  lobbyVideoUrl: z
    .string()
    .max(500)
    .optional()
    .refine((v) => !v || isValidLobbyVideoUrl(v), {
      message: "Holding video must be a YouTube or Vimeo URL",
    }),
  lobbyMessage: z.string().max(280).optional(),
});

// ── GET — Return webinar settings + anchor session + zoom meeting ───

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: orgGuard.orgId },
      select: { id: true, name: true, eventType: true, status: true, slug: true, settings: true, organizationId: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const webinar = readWebinarSettings(event.settings) ?? {};

    // Parallelize anchor session + zoom meeting lookup
    const [anchorSession, zoomMeeting] = await Promise.all([
      webinar.sessionId
        ? db.eventSession.findFirst({
            where: { id: webinar.sessionId, eventId },
            select: {
              id: true,
              name: true,
              startTime: true,
              endTime: true,
              description: true,
              status: true,
            },
          })
        : Promise.resolve(null),
      webinar.sessionId
        ? db.zoomMeeting.findFirst({
            where: { sessionId: webinar.sessionId, eventId },
            select: {
              id: true,
              zoomMeetingId: true,
              meetingType: true,
              joinUrl: true,
              startUrl: true,
              passcode: true,
              duration: true,
              recordingUrl: true,
              recordingPassword: true,
              recordingDuration: true,
              recordingFetchedAt: true,
              recordingStatus: true,
            },
          })
        : Promise.resolve(null),
    ]);

    return NextResponse.json({
      event: {
        id: event.id,
        name: event.name,
        slug: event.slug,
        eventType: event.eventType,
        // Drives the LobbyCard's DRAFT-auto-open hint: DRAFT events auto-open
        // the public room for testing; PUBLISHED requires the manual click.
        status: event.status,
      },
      webinar,
      anchorSession,
      zoomMeeting,
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar:settings-fetch-failed");
    return NextResponse.json({ error: "Failed to fetch webinar settings" }, { status: 500 });
  }
}

// ── PUT — Update webinar settings JSON ─────────────────────────────

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([auth(), params, req.json()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session);
    if (denied) return denied;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `webinar-settings:${eventId}`,
      limit: 20,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ eventId, userId: session.user.id }, "webinar:settings-rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const validated = updateWebinarSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ errors: validated.error.flatten() }, "webinar:settings-validation-failed");
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 },
      );
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: orgGuard.orgId },
      select: { id: true, settings: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const existingWebinar = readWebinarSettings(event.settings) ?? {};
    const nextWebinar: WebinarSettings = { ...existingWebinar, ...validated.data };

    // Save-time HLS validation (waiting-room review #5 follow-up): switching
    // the viewing mode to "hls" requires the anchor session's live stream to
    // actually be configured — otherwise attendees would be admitted into a
    // permanent "getting the stream ready" screen at go-live. Enforced when
    // the REQUEST sets hls (an already-hls event saving its lobby message
    // isn't retro-blocked; the room-open POST is the final gate).
    if (validated.data.viewingMode === "hls") {
      const streamConfig = nextWebinar.sessionId
        ? await db.zoomMeeting.findFirst({
            where: { sessionId: nextWebinar.sessionId, eventId },
            select: { liveStreamEnabled: true, streamKey: true },
          })
        : null;
      if (!streamConfig?.liveStreamEnabled || !streamConfig.streamKey) {
        apiLogger.warn(
          { eventId, userId: session.user.id },
          "webinar:hls-mode-without-stream-rejected",
        );
        return NextResponse.json(
          {
            error:
              "Custom stream mode needs the live stream enabled on the webinar session first (Session → Zoom → Live Streaming), or switch back to the Zoom embed.",
            code: "HLS_STREAM_NOT_CONFIGURED",
          },
          { status: 400 },
        );
      }
    }

    // JSON round-trip strips undefined values (Prisma's Json type rejects
    // them) before the atomic merge.
    const cleanWebinar = JSON.parse(JSON.stringify(nextWebinar));
    await updateEventSettings(eventId, { webinar: cleanWebinar });

    apiLogger.info(
      { eventId, userId: session.user.id, webinar: nextWebinar },
      "webinar:settings-updated",
    );

    return NextResponse.json({ webinar: nextWebinar });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar:settings-update-failed");
    return NextResponse.json({ error: "Failed to update webinar settings" }, { status: 500 });
  }
}

// ── POST — Manually re-run the provisioner (idempotent) ────────────

export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session);
    if (denied) return denied;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `webinar-provision:${eventId}`,
      limit: 10,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ eventId, userId: session.user.id }, "webinar:provision-rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: orgGuard.orgId },
      select: { id: true, organizationId: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const result = await provisionWebinar(eventId, { actorUserId: session.user.id });
    if (!result.ok) {
      // Another invocation (event-create fire-and-forget, or a double-click)
      // holds the provisioning claim — a benign race, not a server error.
      if (result.reason === "provision-already-in-progress") {
        return NextResponse.json(
          { error: "Provisioning is already running for this event — try again in a moment." },
          { status: 409 },
        );
      }
      return NextResponse.json({ error: result.reason }, { status: 500 });
    }

    // Backfill Q&A on a pre-existing webinar that was created before we
    // explicitly enabled it. Newly-created webinars already get Q&A via
    // createZoomWebinar's settings payload, so skip them.
    if (result.zoomStatus === "already-attached" && result.zoomMeetingId) {
      try {
        await enableWebinarQA(event.organizationId, result.zoomMeetingId);
        apiLogger.info(
          { eventId, zoomMeetingId: result.zoomMeetingId },
          "webinar:qa-backfilled",
        );
      } catch (err) {
        apiLogger.warn(
          { err, eventId, zoomMeetingId: result.zoomMeetingId },
          "webinar:qa-backfill-failed",
        );
      }
    }

    return NextResponse.json(result);
  } catch (error) {
    apiLogger.error({ err: error }, "webinar:manual-provision-failed");
    return NextResponse.json({ error: "Failed to provision webinar" }, { status: 500 });
  }
}
