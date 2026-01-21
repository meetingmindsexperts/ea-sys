import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

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
    const { eventId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = await db.event.findFirst({
      where: {
        id: eventId,
        organizationId: session.user.organizationId,
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const { searchParams } = new URL(req.url);
    const trackId = searchParams.get("trackId");
    const status = searchParams.get("status");
    const date = searchParams.get("date");

    const sessions = await db.eventSession.findMany({
      where: {
        eventId,
        ...(trackId && { trackId }),
        ...(status && { status: status as any }),
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
    });

    return NextResponse.json(sessions);
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
    const { eventId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = await db.event.findFirst({
      where: {
        id: eventId,
        organizationId: session.user.organizationId,
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const body = await req.json();
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

    // Validate track exists if provided
    if (trackId) {
      const track = await db.track.findFirst({
        where: { id: trackId, eventId },
      });
      if (!track) {
        return NextResponse.json({ error: "Track not found" }, { status: 404 });
      }
    }

    // Validate abstract exists if provided
    if (abstractId) {
      const abstract = await db.abstract.findFirst({
        where: { id: abstractId, eventId },
      });
      if (!abstract) {
        return NextResponse.json({ error: "Abstract not found" }, { status: 404 });
      }

      // Check if abstract is already assigned to a session
      const existingSession = await db.eventSession.findFirst({
        where: { abstractId },
      });
      if (existingSession) {
        return NextResponse.json(
          { error: "Abstract is already assigned to another session" },
          { status: 400 }
        );
      }
    }

    // Validate speakers exist if provided
    if (speakerIds && speakerIds.length > 0) {
      const speakers = await db.speaker.findMany({
        where: {
          id: { in: speakerIds },
          eventId,
        },
      });
      if (speakers.length !== speakerIds.length) {
        return NextResponse.json({ error: "One or more speakers not found" }, { status: 404 });
      }
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

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "CREATE",
        entityType: "EventSession",
        entityId: eventSession.id,
        changes: { session: eventSession },
      },
    });

    return NextResponse.json(eventSession, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating session" });
    return NextResponse.json(
      { error: "Failed to create session" },
      { status: 500 }
    );
  }
}
