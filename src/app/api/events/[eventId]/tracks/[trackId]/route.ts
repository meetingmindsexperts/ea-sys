import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";

const updateTrackSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  sortOrder: z.number().optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; trackId: string }>;
}

async function getAuthenticatedUser() {
  const session = await auth();

  if (!session?.user) {
    return {
      session: null,
      unauthorized: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  return { session, unauthorized: null };
}

// L4: org-scope via buildEventAccessWhere like the GET (denyReviewer has
// already blocked restricted roles) — the hand-rolled organizationId filter
// 404'd an org-null SUPER_ADMIN.
async function validateEventAccess(
  eventId: string,
  user: { id: string; role: string; organizationId?: string | null },
) {
  const event = await db.event.findFirst({
    where: buildEventAccessWhere(user, eventId),
    select: { id: true },
  });

  if (!event) {
    apiLogger.warn({ msg: "track:event-not-found", eventId });
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }

  return null;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { eventId, trackId } = await params;
    const { session, unauthorized } = await getAuthenticatedUser();

    if (unauthorized || !session) {
      return unauthorized;
    }

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "track:event-not-found", eventId });
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
      apiLogger.warn({ msg: "track:not-found", eventId, trackId });
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
    const { session, unauthorized } = await getAuthenticatedUser();

    if (unauthorized || !session) {
      return unauthorized;
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const eventError = await validateEventAccess(eventId, session.user);
    if (eventError) {
      return eventError;
    }

    const existingTrack = await db.track.findFirst({
      where: {
        id: trackId,
        eventId,
      },
    });

    if (!existingTrack) {
      apiLogger.warn({ msg: "track:not-found-on-update", eventId, trackId });
      return NextResponse.json({ error: "Track not found" }, { status: 404 });
    }

    const body = await req.json();
    const validated = updateTrackSchema.safeParse(body);

    if (!validated.success) {
        apiLogger.warn({ msg: "events/tracks:zod-validation-failed", errors: validated.error.flatten() });
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
          ip: getClientIp(req),
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
    const { session, unauthorized } = await getAuthenticatedUser();

    if (unauthorized || !session) {
      return unauthorized;
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const eventError = await validateEventAccess(eventId, session.user);
    if (eventError) {
      return eventError;
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
      apiLogger.warn({ msg: "track:not-found", eventId, trackId });
      return NextResponse.json({ error: "Track not found" }, { status: 404 });
    }

    // Don't allow deletion if there are sessions
    if (track._count.eventSessions > 0) {
      apiLogger.warn({ msg: "track:delete-blocked-has-sessions", eventId, trackId });
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
        changes: { deleted: track, ip: getClientIp(req) },
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
