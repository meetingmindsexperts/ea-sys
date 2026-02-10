import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";

const updateSessionSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  trackId: z.string().nullable().optional(),
  abstractId: z.string().nullable().optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  location: z.string().optional(),
  capacity: z.number().min(1).nullable().optional(),
  status: z.enum(["DRAFT", "SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"]).optional(),
  speakerIds: z.array(z.string()).optional(),
});

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
      where: {
        id: eventId,
        organizationId: session.user.organizationId,
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const eventSession = await db.eventSession.findFirst({
      where: {
        id: sessionId,
        eventId,
      },
      include: {
        track: true,
        abstract: {
          include: {
            speaker: true,
          },
        },
        speakers: {
          include: {
            speaker: true,
          },
        },
      },
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

    const event = await db.event.findFirst({
      where: {
        id: eventId,
        organizationId: session.user.organizationId,
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const existingSession = await db.eventSession.findFirst({
      where: {
        id: sessionId,
        eventId,
      },
    });

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

    // Validate track if provided
    if (data.trackId) {
      const track = await db.track.findFirst({
        where: { id: data.trackId, eventId },
      });
      if (!track) {
        return NextResponse.json({ error: "Track not found" }, { status: 404 });
      }
    }

    // Validate abstract if provided
    if (data.abstractId) {
      const abstract = await db.abstract.findFirst({
        where: { id: data.abstractId, eventId },
      });
      if (!abstract) {
        return NextResponse.json({ error: "Abstract not found" }, { status: 404 });
      }

      // Check if abstract is already assigned to another session
      const existingAbstractSession = await db.eventSession.findFirst({
        where: {
          abstractId: data.abstractId,
          id: { not: sessionId },
        },
      });
      if (existingAbstractSession) {
        return NextResponse.json(
          { error: "Abstract is already assigned to another session" },
          { status: 400 }
        );
      }
    }

    // Handle speaker updates
    if (data.speakerIds !== undefined) {
      // Validate all speakers exist
      if (data.speakerIds.length > 0) {
        const speakers = await db.speaker.findMany({
          where: {
            id: { in: data.speakerIds },
            eventId,
          },
        });
        if (speakers.length !== data.speakerIds.length) {
          return NextResponse.json({ error: "One or more speakers not found" }, { status: 404 });
        }
      }

      // Delete existing speaker associations
      await db.sessionSpeaker.deleteMany({
        where: { sessionId },
      });

      // Create new speaker associations
      if (data.speakerIds.length > 0) {
        await db.sessionSpeaker.createMany({
          data: data.speakerIds.map((speakerId) => ({
            sessionId,
            speakerId,
            role: "speaker",
          })),
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
        action: "UPDATE",
        entityType: "EventSession",
        entityId: eventSession.id,
        changes: {
          before: existingSession,
          after: eventSession,
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
      where: {
        id: eventId,
        organizationId: session.user.organizationId,
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const eventSession = await db.eventSession.findFirst({
      where: {
        id: sessionId,
        eventId,
      },
    });

    if (!eventSession) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    await db.eventSession.delete({
      where: { id: sessionId },
    });

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "DELETE",
        entityType: "EventSession",
        entityId: sessionId,
        changes: { deleted: eventSession },
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
