import { NextResponse } from "next/server";
import { can } from "@/lib/permissions/can";
import { controlWebinarLiveStream } from "@/lib/webinar/livestream";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { updateEventSettings } from "@/lib/event-settings";
import { isUploadOrHttpsUrl, readWebinarSettings, type WebinarSettings } from "@/lib/webinar";
import { redactZoomHostFields } from "@/lib/zoom-visibility";
import { isValidLobbyVideoUrl } from "@/lib/webinar/lobby-video";
import { provisionWebinar } from "@/lib/webinar-provisioner";
import { enableWebinarQA } from "@/lib/zoom";

type RouteParams = { params: Promise<{ eventId: string }> };

// Empty string clears the field; otherwise a local upload path or https URL
// (the console uploads via the photo and event media routes, which return /uploads/…).
const imageUrlField = (label: string) =>
  z
    .string()
    .max(500)
    .optional()
    .refine((v) => !v || isUploadOrHttpsUrl(v), {
      message: `${label} must be an uploaded image or an https URL`,
    });

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
  lobbyImageUrl: imageUrlField("Waiting-room image"),
  pageLogoUrl: imageUrlField("Page logo"),
  pageBackgroundUrl: imageUrlField("Page background"),
  pageFooterImageUrl: imageUrlField("Footer image"),
  // The survey that pops up when the webinar ends (step 4 of several surveys,
  // Oct 6, 2026). Empty string clears it.
  endSurveyId: z.string().max(64).optional(),
  // Whether the thank-you email carries that survey's link (step 5).
  thankYouSurveyLink: z.boolean().optional(),
  // Attendees may upvote public questions (unset means yes).
  qaUpvote: z.boolean().optional(),
});

// ── GET — Return webinar settings + anchor session + zoom meeting ───

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/webinar:GET" });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.analytics.read", { route: "events/[eventId]/webinar:GET", eventId, onMissing: "hide" });
    if (!gate.ok) return gate.response;

    return await runWithTenant(orgGuard.orgId, async () => {
    const event = await db.event.findFirst({
      where: gate.eventWhere,
      select: { id: true, name: true, eventType: true, status: true, slug: true, settings: true, organizationId: true, timezone: true },
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

    // Zoom HOST credentials (startUrl/streamKey/passcode) grant CONTROL of the
    // webinar, not just attendance. Only the roles that run the event may see
    // them — this GET is session-only (no API-key path), so isApiKey is false.
    // A MEMBER reads this event (webinar.analytics.read, org-wide), so
    // without this a read-only MEMBER would receive the host start link and
    // could hijack the webinar. Mirrors the sessions-LIST redaction (B1).
    const payload = {
      event: {
        id: event.id,
        name: event.name,
        slug: event.slug,
        eventType: event.eventType,
        // Drives the LobbyCard's DRAFT-auto-open hint: DRAFT events auto-open
        // the public room for testing; PUBLISHED requires the manual click.
        status: event.status,
        // Every time on the console is shown in the event's timezone.
        timezone: event.timezone,
      },
      webinar,
      anchorSession,
      zoomMeeting,
    };
    return NextResponse.json(
      can(gate.principal, "zoomHost.view")
        ? payload
        : redactZoomHostFields(payload),
    );
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
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/webinar:PUT" });
    if ("error" in orgGuard) return orgGuard.error;

    const gate = requirePermission(session, "webinar.manage", { route: "events/[eventId]/webinar:PUT", eventId });
    if (!gate.ok) return gate.response;

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

    return await runWithTenant(orgGuard.orgId, async () => {
    const event = await db.event.findFirst({
      where: gate.eventWhere,
      select: { id: true, slug: true, settings: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const existingWebinar = readWebinarSettings(event.settings) ?? {};
    const nextWebinar: WebinarSettings = { ...existingWebinar, ...validated.data };

    // The end-of-webinar survey must be one of this event's surveys.
    if (validated.data.endSurveyId) {
      const survey = await db.survey.findFirst({
        where: { id: validated.data.endSurveyId, eventId: event.id },
        select: { id: true, gatesCertificates: true, isActive: true },
      });
      if (!survey) {
        apiLogger.warn({ eventId: event.id, surveyId: validated.data.endSurveyId }, "webinar:end-survey-not-this-event");
        return NextResponse.json({ error: "That survey does not belong to this event." }, { status: 400 });
      }
      // The CME survey is reached only through the personal link the
      // organiser sends (L1): in the popup any registrant, attended or not,
      // could complete it and be issued a certificate.
      if (survey.gatesCertificates) {
        apiLogger.warn({ eventId: event.id, surveyId: survey.id }, "webinar:end-survey-cme-refused");
        return NextResponse.json(
          { error: "The certificate (CME) survey cannot pop up after the webinar. Send it with its personal link instead." },
          { status: 400 },
        );
      }
      if (!survey.isActive) {
        apiLogger.warn({ eventId: event.id, surveyId: survey.id }, "webinar:end-survey-closed");
        return NextResponse.json({ error: "That survey is closed. Open it first." }, { status: 400 });
      }
    }

    // Save-time HLS validation (waiting-room review #5 follow-up): switching
    // the viewing mode to "hls" requires the anchor session's live stream to
    // actually be configured — otherwise attendees would be admitted into a
    // permanent "getting the stream ready" screen at go-live. Enforced when
    // the REQUEST sets hls (an already-hls event saving its lobby message
    // isn't retro-blocked; the room-open POST is the final gate).
    // Switching to custom stream needs the anchor session's live stream set
    // up, or attendees would be admitted into a permanent "getting the
    // stream ready" screen. It used to REFUSE and point at a Zoom form; the
    // console's Re-send button that fixes it only appeared after the mode
    // was saved, so the producer was stuck (owner, Oct 1, 2026). Now the save
    // sets the stream up itself (the same sync as Re-send) and refuses only
    // if Zoom does, with Zoom's reason. Enforced when the REQUEST sets hls;
    // the room-open POST stays the final gate.
    if (validated.data.viewingMode === "hls") {
      const streamConfig = nextWebinar.sessionId
        ? await db.zoomMeeting.findFirst({
            where: { sessionId: nextWebinar.sessionId, eventId },
            select: { liveStreamEnabled: true, streamKey: true },
          })
        : null;
      if (!streamConfig?.liveStreamEnabled || !streamConfig.streamKey) {
        if (!nextWebinar.sessionId || !streamConfig) {
          apiLogger.warn({ eventId, userId: session.user.id }, "webinar:hls-mode-no-zoom-webinar");
          return NextResponse.json(
            {
              error:
                "Custom stream needs the event's Zoom webinar. Run the provisioner first, or keep the Zoom embed.",
              code: "HLS_STREAM_NOT_CONFIGURED",
            },
            { status: 400 },
          );
        }
        const anchor = await db.eventSession.findFirst({
          where: { id: nextWebinar.sessionId, eventId },
          select: { name: true },
        });
        const synced = await controlWebinarLiveStream({
          organizationId: orgGuard.orgId,
          eventId,
          eventSlug: event.slug,
          sessionId: nextWebinar.sessionId,
          sessionName: anchor?.name ?? "Webinar",
          action: "sync",
          userId: session.user.id,
        });
        if (!synced.ok) {
          apiLogger.warn(
            { eventId, userId: session.user.id, code: synced.code },
            "webinar:hls-mode-stream-setup-failed",
          );
          return NextResponse.json(
            {
              error: `Could not set up the custom stream in Zoom: ${synced.message}`,
              code: "HLS_STREAM_NOT_CONFIGURED",
            },
            { status: 400 },
          );
        }
        apiLogger.info({ eventId, userId: session.user.id }, "webinar:hls-mode-stream-set-up-on-save");
      }
    }

    // Merge ONLY the fields this request changed into the CURRENT webinar
    // settings, read under the lock. It wrote the whole object from a copy
    // taken before the Zoom sync above, which could undo a room toggle's
    // roomOpenedAt (or a provisioner write) landing meanwhile (final review,
    // Oct 2, 2026). The JSON round-trip strips undefined values, which
    // Prisma's Json type rejects and which must not overwrite stored ones.
    const patch = JSON.parse(JSON.stringify(validated.data)) as Record<string, unknown>;
    await updateEventSettings(eventId, (current) => {
      const currentWebinar =
        current.webinar && typeof current.webinar === "object" ? (current.webinar as Record<string, unknown>) : {};
      return { ...current, webinar: { ...currentWebinar, ...patch } };
    });

    apiLogger.info(
      { eventId, userId: session.user.id, webinar: nextWebinar },
      "webinar:settings-updated",
    );

    return NextResponse.json({ webinar: nextWebinar });
    });
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
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/webinar:POST" });
    if ("error" in orgGuard) return orgGuard.error;

    const gate = requirePermission(session, "webinar.manage", { route: "events/[eventId]/webinar:POST", eventId });
    if (!gate.ok) return gate.response;

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

    return await runWithTenant(orgGuard.orgId, async () => {
    const event = await db.event.findFirst({
      where: gate.eventWhere,
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
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar:manual-provision-failed");
    return NextResponse.json({ error: "Failed to provision webinar" }, { status: 500 });
  }
}
