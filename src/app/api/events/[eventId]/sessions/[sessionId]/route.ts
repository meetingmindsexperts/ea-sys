import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";

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

const sessionSelect = {
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
        select: { id: true, firstName: true, lastName: true, status: true },
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
            select: { id: true, firstName: true, lastName: true, status: true },
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
        select: { id: true, startDate: true, endDate: true },
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
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const data = validated.data;

    // Validate session times fall within event dates (if times are being updated)
    if (data.startTime || data.endTime) {
      const sessionStart = new Date(data.startTime || existingSession.startTime);
      const sessionEnd = new Date(data.endTime || existingSession.endTime);
      const eventStart = new Date(event.startDate);
      const eventEnd = new Date(event.endDate);
      eventStart.setHours(0, 0, 0, 0);
      eventEnd.setHours(23, 59, 59, 999);
      if (sessionStart < eventStart || sessionEnd > eventEnd) {
        return NextResponse.json(
          { error: `Session must fall within event dates (${eventStart.toLocaleDateString()} – ${eventEnd.toLocaleDateString()})` },
          { status: 400 }
        );
      }
    }

    // Validate track if provided
    if (data.trackId) {
      const track = await db.track.findFirst({ where: { id: data.trackId, eventId } });
      if (!track) {
        return NextResponse.json({ error: "Track not found" }, { status: 404 });
      }
    }

    // Validate abstract if provided
    if (data.abstractId) {
      const abstract = await db.abstract.findFirst({ where: { id: data.abstractId, eventId } });
      if (!abstract) {
        return NextResponse.json({ error: "Abstract not found" }, { status: 404 });
      }
      const existingAbstractSession = await db.eventSession.findFirst({
        where: { abstractId: data.abstractId, id: { not: sessionId } },
      });
      if (existingAbstractSession) {
        return NextResponse.json(
          { error: "Abstract is already assigned to another session" },
          { status: 400 }
        );
      }
    }

    // Collect all speaker IDs for validation
    const allSpeakerIds = new Set<string>();
    if (data.speakerIds) data.speakerIds.forEach((id) => allSpeakerIds.add(id));
    if (data.sessionRoles) data.sessionRoles.forEach((r) => allSpeakerIds.add(r.speakerId));
    if (data.topics) data.topics.forEach((t) => t.speakerIds?.forEach((id) => allSpeakerIds.add(id)));

    if (allSpeakerIds.size > 0) {
      const speakers = await db.speaker.findMany({
        where: { id: { in: [...allSpeakerIds] }, eventId },
      });
      if (speakers.length !== allSpeakerIds.size) {
        return NextResponse.json({ error: "One or more speakers not found" }, { status: 404 });
      }
    }

    // Handle session-level speaker updates
    if (data.sessionRoles !== undefined || data.speakerIds !== undefined) {
      // Delete existing session speakers
      await db.sessionSpeaker.deleteMany({ where: { sessionId } });

      const sessionSpeakerData: { sessionId: string; speakerId: string; role: "SPEAKER" | "MODERATOR" | "CHAIRPERSON" | "PANELIST" }[] = [];
      if (data.sessionRoles && data.sessionRoles.length > 0) {
        data.sessionRoles.forEach((r) => sessionSpeakerData.push({ sessionId, speakerId: r.speakerId, role: r.role }));
      } else if (data.speakerIds && data.speakerIds.length > 0) {
        data.speakerIds.forEach((id) => sessionSpeakerData.push({ sessionId, speakerId: id, role: "SPEAKER" }));
      }

      if (sessionSpeakerData.length > 0) {
        await db.sessionSpeaker.createMany({ data: sessionSpeakerData });
      }
    }

    // Handle topics updates
    if (data.topics !== undefined) {
      // Delete existing topics (cascades to TopicSpeaker)
      await db.sessionTopic.deleteMany({ where: { sessionId } });

      // Create new topics with speakers
      for (let i = 0; i < data.topics.length; i++) {
        const t = data.topics[i];
        await db.sessionTopic.create({
          data: {
            sessionId,
            title: t.title,
            abstractId: t.abstractId || null,
            duration: t.duration || null,
            sortOrder: t.sortOrder ?? i,
            speakers: t.speakerIds && t.speakerIds.length > 0
              ? { create: t.speakerIds.map((speakerId) => ({ speakerId })) }
              : undefined,
          },
        });
      }
    }

    const eventSession = await db.eventSession.update({
      where: { id: sessionId },
      data: {
        ...(data.name && { name: data.name }),
        ...(data.description !== undefined && { description: data.description || null }),
        ...(data.trackId !== undefined && { trackId: data.trackId }),
        ...(data.abstractId !== undefined && { abstractId: data.abstractId }),
        ...(data.startTime && { startTime: new Date(data.startTime) }),
        ...(data.endTime && { endTime: new Date(data.endTime) }),
        ...(data.location !== undefined && { location: data.location || null }),
        ...(data.capacity !== undefined && { capacity: data.capacity }),
        ...(data.status && { status: data.status }),
      },
      select: sessionSelect,
    });

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "UPDATE",
        entityType: "EventSession",
        entityId: eventSession.id,
        changes: {
          before: existingSession,
          after: eventSession,
          ip: getClientIp(req),
        },
      },
    });

    return NextResponse.json(eventSession);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating session" });
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
