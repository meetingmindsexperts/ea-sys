import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";
import { notifyEventAdmins } from "@/lib/notifications";

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
    // Fetch params and auth in parallel for faster response
    const [{ eventId }, session] = await Promise.all([
      params,
      auth(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const trackId = searchParams.get("trackId");
    const status = searchParams.get("status");
    const date = searchParams.get("date");

    // Fetch event validation and sessions in parallel
    const [event, sessions] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
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
            orderBy: { sortOrder: "asc" },
          },
        },
        orderBy: { startTime: "asc" },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Add cache headers for better performance
    const response = NextResponse.json(sessions);
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
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const {
      name,
      description,
      trackId,
      abstractId,
      startTime,
      endTime,
      location,
      capacity,
      status,
      speakerIds,
      sessionRoles,
      topics,
    } = validated.data;

    // Collect all speaker IDs for validation
    const allSpeakerIds = new Set<string>();
    if (speakerIds) speakerIds.forEach((id) => allSpeakerIds.add(id));
    if (sessionRoles) sessionRoles.forEach((r) => allSpeakerIds.add(r.speakerId));
    if (topics) topics.forEach((t) => t.speakerIds?.forEach((id) => allSpeakerIds.add(id)));

    // Parallelize all validation queries
    const [event, track, abstract, existingAbstractSession, speakers] = await Promise.all([
      db.event.findFirst({
        where: {
          id: eventId,
          organizationId: session.user.organizationId!,
        },
        select: { id: true, startDate: true, endDate: true },
      }),
      trackId
        ? db.track.findFirst({ where: { id: trackId, eventId } })
        : Promise.resolve(null),
      abstractId
        ? db.abstract.findFirst({ where: { id: abstractId, eventId } })
        : Promise.resolve(null),
      abstractId
        ? db.eventSession.findFirst({ where: { abstractId } })
        : Promise.resolve(null),
      allSpeakerIds.size > 0
        ? db.speaker.findMany({ where: { id: { in: [...allSpeakerIds] }, eventId } })
        : Promise.resolve([]),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Validate session times fall within event dates
    const sessionStart = new Date(startTime);
    const sessionEnd = new Date(endTime);
    const eventStart = new Date(event.startDate);
    const eventEnd = new Date(event.endDate);
    // Compare dates only (ignore time component) — allow sessions on any event day
    eventStart.setHours(0, 0, 0, 0);
    eventEnd.setHours(23, 59, 59, 999);
    if (sessionStart < eventStart || sessionEnd > eventEnd) {
      return NextResponse.json(
        { error: `Session must fall within event dates (${eventStart.toLocaleDateString()} – ${eventEnd.toLocaleDateString()})` },
        { status: 400 }
      );
    }

    if (trackId && !track) {
      return NextResponse.json({ error: "Track not found" }, { status: 404 });
    }

    if (abstractId && !abstract) {
      return NextResponse.json({ error: "Abstract not found" }, { status: 404 });
    }

    if (abstractId && existingAbstractSession) {
      return NextResponse.json(
        { error: "Abstract is already assigned to another session" },
        { status: 400 }
      );
    }

    if (allSpeakerIds.size > 0 && speakers.length !== allSpeakerIds.size) {
      return NextResponse.json({ error: "One or more speakers not found" }, { status: 404 });
    }

    // Build session-level speaker records
    const sessionSpeakerData: { speakerId: string; role: "SPEAKER" | "MODERATOR" | "CHAIRPERSON" | "PANELIST" }[] = [];
    if (sessionRoles && sessionRoles.length > 0) {
      sessionRoles.forEach((r) => sessionSpeakerData.push({ speakerId: r.speakerId, role: r.role }));
    } else if (speakerIds && speakerIds.length > 0) {
      // Legacy: flat speakerIds → all SPEAKER role
      speakerIds.forEach((id) => sessionSpeakerData.push({ speakerId: id, role: "SPEAKER" }));
    }

    const eventSession = await db.eventSession.create({
      data: {
        eventId,
        name,
        description: description || null,
        trackId: trackId || null,
        abstractId: abstractId || null,
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        location: location || null,
        capacity: capacity || null,
        status,
        speakers: sessionSpeakerData.length > 0
          ? { create: sessionSpeakerData }
          : undefined,
        topics: topics && topics.length > 0
          ? {
              create: topics.map((t, i) => ({
                title: t.title,
                abstractId: t.abstractId || null,
                duration: t.duration || null,
                sortOrder: t.sortOrder ?? i,
                speakers: t.speakerIds && t.speakerIds.length > 0
                  ? { create: t.speakerIds.map((speakerId) => ({ speakerId })) }
                  : undefined,
              })),
            }
          : undefined,
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
          orderBy: { sortOrder: "asc" },
        },
      },
    });

    // Log the action (non-blocking for better response time)
    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "CREATE",
        entityType: "EventSession",
        entityId: eventSession.id,
        changes: { ...JSON.parse(JSON.stringify({ session: eventSession })), ip: getClientIp(req) },
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to create audit log" }));

    // Notify admins of new session
    notifyEventAdmins(eventId, {
      type: "REGISTRATION",
      title: "Session Created",
      message: `New session: "${name}"`,
      link: `/events/${eventId}/schedule`,
    }).catch((err) => apiLogger.error({ err, msg: "Failed to send session notification" }));

    return NextResponse.json(eventSession, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating session" });
    return NextResponse.json(
      { error: "Failed to create session" },
      { status: 500 }
    );
  }
}
