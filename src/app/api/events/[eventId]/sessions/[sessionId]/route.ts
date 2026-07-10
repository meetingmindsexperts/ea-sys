import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import {
  updateSession,
  type SessionServiceErrorCode,
} from "@/services/session-service";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";
import { refreshEventStats } from "@/lib/event-stats";
import { optimisticLockField } from "@/lib/optimistic-lock";

const topicSchema = z.object({
  id: z.string().max(100).optional(), // existing topic ID (for updates)
  title: z.string().min(1).max(255),
  abstractId: z.string().max(100).nullable().optional(),
  duration: z.number().min(1).nullable().optional(),
  sortOrder: z.number().int().optional(),
  speakerIds: z.array(z.string().max(100)).optional(),
});

const sessionSpeakerSchema = z.object({
  speakerId: z.string().max(100),
  role: z.enum(["SPEAKER", "MODERATOR", "CHAIRPERSON", "PANELIST"]),
});

const updateSessionSchema = z.object({
  ...optimisticLockField,
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  trackId: z.string().max(100).nullable().optional(),
  abstractId: z.string().max(100).nullable().optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  location: z.string().max(255).optional(),
  capacity: z.number().min(1).nullable().optional(),
  status: z.enum(["DRAFT", "SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"]).optional(),
  // Legacy: flat speaker list (all assigned as SPEAKER role)
  speakerIds: z.array(z.string().max(100)).optional(),
  // New: session-level roles
  sessionRoles: z.array(sessionSpeakerSchema).optional(),
  // New: topics with per-topic speakers
  topics: z.array(topicSchema).optional(),
});

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

const sessionSelect = {
  id: true,
  name: true,
  description: true,
  startTime: true,
  endTime: true,
  location: true,
  capacity: true,
  status: true,
  updatedAt: true,
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
    orderBy: { sortOrder: "asc" as const },
  },
};

interface RouteParams {
  params: Promise<{ eventId: string; sessionId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { eventId, sessionId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const eventSession = await db.eventSession.findFirst({
      where: { id: sessionId, eventId },
      select: sessionSelect,
    });

    if (!eventSession) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    return NextResponse.json(eventSession);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching session" });
    return NextResponse.json(
      { error: "Failed to fetch session" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const { eventId, sessionId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const [event, existingSession] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true, startDate: true, endDate: true, timezone: true },
      }),
      db.eventSession.findFirst({
        where: { id: sessionId, eventId },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!existingSession) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const body = await req.json();
    const validated = updateSessionSchema.safeParse(body);

    if (!validated.success) {
        apiLogger.warn({ msg: "events/sessions:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const data = validated.data;

    // All validation, the lock-first transaction, the atomic child replaces,
    // the audit row and the stats refresh live in the service (H1 + H4) so the
    // REST route and the MCP `update_session` tool can't drift again.
    const result = await updateSession({
      eventId,
      sessionId,
      userId: session.user.id,
      source: "rest",
      requestIp: getClientIp(req),
      ...(data.name !== undefined && { name: data.name }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.trackId !== undefined && { trackId: data.trackId }),
      ...(data.abstractId !== undefined && { abstractId: data.abstractId }),
      ...(data.startTime !== undefined && { startTime: new Date(data.startTime) }),
      ...(data.endTime !== undefined && { endTime: new Date(data.endTime) }),
      ...(data.location !== undefined && { location: data.location }),
      ...(data.capacity !== undefined && { capacity: data.capacity }),
      ...(data.status !== undefined && { status: data.status }),
      ...(data.speakerIds !== undefined && { speakerIds: data.speakerIds }),
      ...(data.sessionRoles !== undefined && { sessionRoles: data.sessionRoles }),
      ...(data.topics !== undefined && { topics: data.topics }),
      expectedUpdatedAt: data.expectedUpdatedAt ? new Date(data.expectedUpdatedAt) : null,
    });

    if (!result.ok) {
      const status = HTTP_STATUS_FOR_SESSION_ERROR[result.code] ?? 500;
      // The service already logged the rejection with its code; the boundary
      // just maps it to HTTP.
      return NextResponse.json(
        { error: result.message, code: result.code, ...(result.meta ?? {}) },
        { status },
      );
    }

    return NextResponse.json(result.session);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating session" });    apiLogger.error({ err: error, msg: "Error updating session" });
    return NextResponse.json(
      { error: "Failed to update session" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const { eventId, sessionId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const eventSession = await db.eventSession.findFirst({
      where: { id: sessionId, eventId },
    });

    if (!eventSession) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    await db.eventSession.delete({ where: { id: sessionId } });

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(eventId);

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "DELETE",
        entityType: "EventSession",
        entityId: sessionId,
        changes: { deleted: eventSession, ip: getClientIp(req) },
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting session" });
    return NextResponse.json(
      { error: "Failed to delete session" },
      { status: 500 }
    );
  }
}
