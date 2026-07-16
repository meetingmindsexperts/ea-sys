import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";

const createTrackSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
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
        where: buildEventAccessWhere(session.user, eventId),
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
      apiLogger.warn({ msg: "tracks-get:event-not-found", eventId, userId: session.user.id });
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

    const validated = createTrackSchema.safeParse(body);

    if (!validated.success) {
        apiLogger.warn({ msg: "events/tracks:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { name, description, color, sortOrder } = validated.data;

    // L4: org-scope via buildEventAccessWhere like the GET (denyReviewer has
    // already blocked restricted roles) — the hand-rolled organizationId
    // filter 404'd a SUPER_ADMIN with no org.
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
    });

    if (!event) {
      apiLogger.warn({ msg: "tracks-post:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // sortOrder defaults to max+1, computed INSIDE the same transaction as
    // the create so two concurrent track creates can't read the same max and
    // tie (M10, program/agenda review — same shape as the certificate
    // templates fix). Ties aren't fatal (no unique constraint) but make the
    // agenda's track ordering non-deterministic.
    const track = await db.$transaction(async (tx) => {
      const finalSortOrder =
        sortOrder ??
        ((
          await tx.track.aggregate({
            where: { eventId },
            _max: { sortOrder: true },
          })
        )._max.sortOrder ?? -1) + 1;

      return tx.track.create({
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
    });

    // Log the action (non-blocking for better response time)
    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "CREATE",
        entityType: "Track",
        entityId: track.id,
        changes: { ...JSON.parse(JSON.stringify({ track })), ip: getClientIp(req) },
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to create audit log" }));

    return NextResponse.json(track, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating track" });
    return NextResponse.json(
      { error: "Failed to create track" },
      { status: 500 }
    );
  }
}
