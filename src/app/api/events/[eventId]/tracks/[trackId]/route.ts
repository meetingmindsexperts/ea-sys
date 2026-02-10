import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";

const updateTrackSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  sortOrder: z.number().optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; trackId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { eventId, trackId } = await params;
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

    const track = await db.track.findFirst({
      where: {
        id: trackId,
        eventId,
      },
      include: {
        eventSessions: {
          include: {
            speakers: {
              include: {
                speaker: true,
              },
            },
          },
          orderBy: { startTime: "asc" },
        },
        abstracts: {
          include: {
            speaker: true,
          },
        },
        _count: {
          select: {
            eventSessions: true,
            abstracts: true,
          },
        },
      },
    });

    if (!track) {
      return NextResponse.json({ error: "Track not found" }, { status: 404 });
    }

    return NextResponse.json(track);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching track" });
    return NextResponse.json(
      { error: "Failed to fetch track" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const { eventId, trackId } = await params;
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

    const existingTrack = await db.track.findFirst({
      where: {
        id: trackId,
        eventId,
      },
    });

    if (!existingTrack) {
      return NextResponse.json({ error: "Track not found" }, { status: 404 });
    }

    const body = await req.json();
    const validated = updateTrackSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const data = validated.data;

    const track = await db.track.update({
      where: { id: trackId },
      data: {
        ...(data.name && { name: data.name }),
        ...(data.description !== undefined && { description: data.description || null }),
        ...(data.color && { color: data.color }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
      },
      include: {
        _count: {
          select: {
            eventSessions: true,
            abstracts: true,
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
        entityType: "Track",
        entityId: track.id,
        changes: {
          before: existingTrack,
          after: track,
        },
      },
    });

    return NextResponse.json(track);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating track" });
    return NextResponse.json(
      { error: "Failed to update track" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const { eventId, trackId } = await params;
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

    const track = await db.track.findFirst({
      where: {
        id: trackId,
        eventId,
      },
      include: {
        _count: {
          select: {
            eventSessions: true,
          },
        },
      },
    });

    if (!track) {
      return NextResponse.json({ error: "Track not found" }, { status: 404 });
    }

    // Don't allow deletion if there are sessions
    if (track._count.eventSessions > 0) {
      return NextResponse.json(
        { error: "Cannot delete track with existing sessions" },
        { status: 400 }
      );
    }

    await db.track.delete({
      where: { id: trackId },
    });

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "DELETE",
        entityType: "Track",
        entityId: trackId,
        changes: { deleted: track },
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting track" });
    return NextResponse.json(
      { error: "Failed to delete track" },
      { status: 500 }
    );
  }
}
