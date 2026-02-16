import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { validateEventAccess, withPrivateCache } from "@/lib/api-route-helpers";

const createSessionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  trackId: z.string().optional(),
  abstractId: z.string().optional(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  location: z.string().optional(),
  capacity: z.number().min(1).optional(),
  status: z.enum(["DRAFT", "SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"]).default("SCHEDULED"),
  speakerIds: z.array(z.string()).optional(),
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

    const [eventError, sessions] = await Promise.all([
      validateEventAccess(eventId, session.user.organizationId!),
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
        include: {
          track: true,
          abstract: true,
          speakers: {
            include: {
              speaker: true,
            },
          },
        },
        orderBy: { startTime: "asc" },
      }),
    ]);

    if (eventError) {
      return eventError;
    }

    // Add cache headers for better performance
    return withPrivateCache(NextResponse.json(sessions));
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
    } = validated.data;

    // Parallelize all validation queries
    const [eventError, track, abstract, existingAbstractSession, speakers] = await Promise.all([
      validateEventAccess(eventId, session.user.organizationId!),
      trackId
        ? db.track.findFirst({ where: { id: trackId, eventId } })
        : Promise.resolve(null),
      abstractId
        ? db.abstract.findFirst({ where: { id: abstractId, eventId } })
        : Promise.resolve(null),
      abstractId
        ? db.eventSession.findFirst({ where: { abstractId } })
        : Promise.resolve(null),
      speakerIds && speakerIds.length > 0
        ? db.speaker.findMany({ where: { id: { in: speakerIds }, eventId } })
        : Promise.resolve([]),
    ]);

    if (eventError) {
      return eventError;
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

    if (speakerIds && speakerIds.length > 0 && speakers.length !== speakerIds.length) {
      return NextResponse.json({ error: "One or more speakers not found" }, { status: 404 });
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
        speakers: speakerIds && speakerIds.length > 0
          ? {
              create: speakerIds.map((speakerId) => ({
                speakerId,
                role: "speaker",
              })),
            }
          : undefined,
      },
      include: {
        track: true,
        abstract: true,
        speakers: {
          include: {
            speaker: true,
          },
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
        changes: JSON.parse(JSON.stringify({ session: eventSession })),
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to create audit log" }));

    return NextResponse.json(eventSession, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating session" });
    return NextResponse.json(
      { error: "Failed to create session" },
      { status: 500 }
    );
  }
}
