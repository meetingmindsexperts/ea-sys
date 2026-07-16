import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import {
  createSession,
  type SessionServiceErrorCode,
} from "@/services/session-service";
import { canViewZoomHostCredentials, redactZoomHostFieldsFromSessions } from "@/lib/zoom-visibility";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getOrgContext } from "@/lib/api-auth";
import { getClientIp } from "@/lib/security";

// Map the service's domain error codes to HTTP. Kept at the boundary — the
// service never knows about HTTP (see src/services/README.md).
const HTTP_STATUS_FOR_SESSION_ERROR: Record<SessionServiceErrorCode, number> = {
  EVENT_NOT_FOUND: 404,
  SESSION_NOT_FOUND: 404,
  INVALID_TIME_RANGE: 400,
  OUTSIDE_EVENT_DATES: 400,
  TRACK_NOT_FOUND: 404,
  ABSTRACT_NOT_FOUND: 404,
  ABSTRACT_ALREADY_ASSIGNED: 400,
  SPEAKERS_NOT_FOUND: 404,
  INVALID_CAPACITY: 400,
  STALE_WRITE: 409,
  UNKNOWN: 500,
};

const topicSchema = z.object({
  title: z.string().min(1).max(255),
  abstractId: z.string().max(100).optional(),
  duration: z.number().min(1).optional(),
  sortOrder: z.number().int().optional(),
  speakerIds: z.array(z.string().max(100)).optional(),
});

const sessionSpeakerSchema = z.object({
  speakerId: z.string().max(100),
  role: z.enum(["SPEAKER", "MODERATOR", "CHAIRPERSON", "PANELIST"]),
});

const createSessionSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  trackId: z.string().max(100).optional(),
  abstractId: z.string().max(100).optional(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  location: z.string().max(255).optional(),
  capacity: z.number().min(1).optional(),
  status: z.enum(["DRAFT", "SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"]).default("SCHEDULED"),
  // Legacy: flat speaker list (all assigned as SPEAKER role)
  speakerIds: z.array(z.string().max(100)).optional(),
  // New: session-level roles (moderator, chairperson, panelist, speaker)
  sessionRoles: z.array(sessionSpeakerSchema).optional(),
  // New: topics with per-topic speakers
  topics: z.array(topicSchema).optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    // Fetch params and auth in parallel for faster response. Supports BOTH
    // API-key auth (orgCtx — for programmatic "build the program from the API"
    // use, same trust level as the speakers/registrations GETs) and session
    // auth (dashboard).
    const [{ eventId }, orgCtx, session] = await Promise.all([
      params,
      getOrgContext(req),
      auth(),
    ]);

    if (!orgCtx && !session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const trackId = searchParams.get("trackId");
    const status = searchParams.get("status");
    const date = searchParams.get("date");

    // API key → scope to the key's org; session → role-scoped event access.
    const eventWhere = orgCtx
      ? { id: eventId, organizationId: orgCtx.organizationId }
      : buildEventAccessWhere(session!.user, eventId);

    // Fetch event validation and sessions in parallel
    const [event, sessions] = await Promise.all([
      db.event.findFirst({
        where: eventWhere,
        select: { id: true },
      }),
      db.eventSession.findMany({
        where: {
          eventId,
          ...(trackId && { trackId }),
          ...(status && { status: status as "DRAFT" | "SCHEDULED" | "LIVE" | "COMPLETED" | "CANCELLED" }),
          ...(date && {
            startTime: {
              gte: new Date(date),
              lt: new Date(new Date(date).getTime() + 24 * 60 * 60 * 1000),
            },
          }),
        },
        select: {
          id: true,
          name: true,
          description: true,
          startTime: true,
          endTime: true,
          location: true,
          capacity: true,
          status: true,
          track: { select: { id: true, name: true, color: true } },
          abstract: { select: { id: true, title: true } },
          speakers: {
            select: {
              role: true,
              speaker: {
                select: { id: true, title: true, firstName: true, lastName: true, status: true },
              },
            },
          },
          topics: {
            select: {
              id: true,
              title: true,
              sortOrder: true,
              duration: true,
              abstract: { select: { id: true, title: true } },
              speakers: {
                select: {
                  speaker: {
                    select: { id: true, title: true, firstName: true, lastName: true, status: true },
                  },
                },
              },
            },
            orderBy: { sortOrder: "asc" },
          },
          zoomMeeting: {
            select: {
              id: true,
              zoomMeetingId: true,
              meetingType: true,
              status: true,
              joinUrl: true,
              startUrl: true,
              passcode: true,
              liveStreamEnabled: true,
              streamKey: true,
              streamStatus: true,
            },
          },
        },
        orderBy: { startTime: "asc" },
      }),
    ]);

    if (!event) {
      apiLogger.warn({
        msg: "events/sessions:event-not-found",
        eventId,
        userId: session?.user?.id ?? null,
        role: session?.user?.role ?? null,
        viaApiKey: !!orgCtx,
      });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // BLOCKER B1 (program/agenda review): this GET has no `denyReviewer`, and
    // `buildEventAccessWhere` grants event access to the org-null attendee
    // roles by linkage (a REGISTRANT reaches their own event via
    // `registrations.some.userId`). The Zoom payload carries `startUrl` — the
    // HOST start link — plus `streamKey` and `passcode`. Strip them for anyone
    // who isn't actually running the event, otherwise a paying attendee can
    // take host control of the webinar or hijack the RTMP stream.
    const showHostCredentials = canViewZoomHostCredentials(
      session?.user?.role,
      !!orgCtx, // API keys are admin-equivalent + org-scoped
    );
    const payload = showHostCredentials
      ? sessions
      : redactZoomHostFieldsFromSessions(sessions);

    // Add cache headers for better performance. `private` matters here: the
    // payload now varies by role, so it must never land in a shared cache.
    const response = NextResponse.json(payload);
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching sessions" });
    return NextResponse.json(
      { error: "Failed to fetch sessions" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    // Parallelize params, auth, and body parsing
    const [{ eventId }, session, body] = await Promise.all([
      params,
      auth(),
      req.json(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const validated = createSessionSchema.safeParse(body);

    if (!validated.success) {
        apiLogger.warn({ msg: "events/sessions:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const data = validated.data;

    // Authorization stays at the boundary: the service validates that the event
    // EXISTS, not that this org owns it. 404 (not 403) to avoid enumeration.
    // L4: buildEventAccessWhere instead of a hand-rolled organizationId filter
    // (denyReviewer already blocked restricted roles; the hand-rolled filter
    // 404'd an org-null SUPER_ADMIN).
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({
        msg: "events/sessions:event-not-found-on-create",
        eventId,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Validation, the write, the audit row, the admin notification and the
    // stats refresh all live in the service (H4) so this route and the MCP
    // `create_session` tool can't drift again.
    const result = await createSession({
      eventId,
      userId: session.user.id,
      source: "rest",
      requestIp: getClientIp(req),
      name: data.name,
      startTime: new Date(data.startTime),
      endTime: new Date(data.endTime),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.trackId !== undefined && { trackId: data.trackId }),
      ...(data.abstractId !== undefined && { abstractId: data.abstractId }),
      ...(data.location !== undefined && { location: data.location }),
      ...(data.capacity !== undefined && { capacity: data.capacity }),
      ...(data.status !== undefined && { status: data.status }),
      ...(data.speakerIds !== undefined && { speakerIds: data.speakerIds }),
      ...(data.sessionRoles !== undefined && { sessionRoles: data.sessionRoles }),
      ...(data.topics !== undefined && { topics: data.topics }),
    });

    if (!result.ok) {
      const status = HTTP_STATUS_FOR_SESSION_ERROR[result.code] ?? 500;
      return NextResponse.json(
        { error: result.message, code: result.code, ...(result.meta ?? {}) },
        { status },
      );
    }

    return NextResponse.json(result.session, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating session" });
    return NextResponse.json(
      { error: "Failed to create session" },
      { status: 500 }
    );
  }
}
