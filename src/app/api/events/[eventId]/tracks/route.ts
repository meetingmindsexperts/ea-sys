import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

const createTrackSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#3B82F6"),
  sortOrder: z.number().optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    // Fetch params and auth in parallel
    const [{ eventId }, session] = await Promise.all([
      params,
      auth(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Fetch event validation and tracks in parallel
    const [event, tracks] = await Promise.all([
      db.event.findFirst({
        where: {
          id: eventId,
          organizationId: session.user.organizationId,
        },
        select: { id: true },
      }),
      db.track.findMany({
        where: { eventId },
        include: {
          _count: {
            select: {
              eventSessions: true,
              abstracts: true,
            },
          },
        },
        orderBy: { sortOrder: "asc" },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const response = NextResponse.json(tracks);
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching tracks" });
    return NextResponse.json(
      { error: "Failed to fetch tracks" },
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
    const validated = createTrackSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { name, description, color, sortOrder } = validated.data;

    // Get max sort order if not provided
    let finalSortOrder = sortOrder;
    if (finalSortOrder === undefined) {
      const maxTrack = await db.track.findFirst({
        where: { eventId },
        orderBy: { sortOrder: "desc" },
      });
      finalSortOrder = maxTrack ? maxTrack.sortOrder + 1 : 0;
    }

    const track = await db.track.create({
      data: {
        eventId,
        name,
        description: description || null,
        color,
        sortOrder: finalSortOrder,
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
        action: "CREATE",
        entityType: "Track",
        entityId: track.id,
        changes: { track },
      },
    });

    return NextResponse.json(track, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating track" });
    return NextResponse.json(
      { error: "Failed to create track" },
      { status: 500 }
    );
  }
}
