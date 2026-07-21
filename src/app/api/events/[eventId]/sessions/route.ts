import { NextResponse } from "next/server";
import { z } from "zod";
import { SessionRole, SessionStatus, SessionType } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { createSession, SESSION_SELECT } from "@/services/session-service";
import { HTTP_STATUS_FOR_SESSION_ERROR } from "@/lib/session-http";
import { canViewZoomHostCredentials, redactZoomHostFieldsFromSessions } from "@/lib/zoom-visibility";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getOrgContext } from "@/lib/api-auth";
import { getClientIp } from "@/lib/security";

const topicSchema = z.object({
  title: z.string().min(1).max(255),
  abstractId: z.string().max(100).optional(),
  duration: z.number().min(1).optional(),
  sortOrder: z.number().int().optional(),
  speakerIds: z.array(z.string().max(100)).optional(),
});

const sessionSpeakerSchema = z.object({
  speakerId: z.string().max(100),
  role: z.nativeEnum(SessionRole),
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
  status: z.nativeEnum(SessionStatus).default("SCHEDULED"),
  // SESSION (default) or a break item (REGISTRATION / BREAK / LUNCH /
  // NETWORKING). Break items may not carry speakers/topics/abstract — the
  // service rejects that with BREAK_ITEM_HAS_PROGRAM.
  type: z.nativeEnum(SessionType).optional(),
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
          // The canonical session shape (single source of truth in the
          // service) + the Zoom relation only this list endpoint returns.
          ...SESSION_SELECT,
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
      ...(data.type !== undefined && { type: data.type }),
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
