import { NextResponse } from "next/server";
import { z } from "zod";
import { AbstractStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

const abstractStatusSchema = z.nativeEnum(AbstractStatus);

const createAbstractSchema = z.object({
  speakerId: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  trackId: z.string().optional(),
  status: abstractStatusSchema.default("SUBMITTED"),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    // Parallelize params and auth for faster response
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const statusParam = searchParams.get("status");
    const parsedStatus = statusParam ? abstractStatusSchema.safeParse(statusParam) : null;
    const status = parsedStatus?.success ? parsedStatus.data : undefined;
    const trackId = searchParams.get("trackId");
    const speakerId = searchParams.get("speakerId");

    // Parallelize event validation and abstracts fetch
    const [event, abstracts] = await Promise.all([
      db.event.findFirst({
        where: {
          id: eventId,
          organizationId: session.user.organizationId,
        },
        select: { id: true },
      }),
      db.abstract.findMany({
        where: {
          eventId,
          ...(status && { status }),
          ...(trackId && { trackId }),
          ...(speakerId && { speakerId }),
        },
        include: {
          speaker: true,
          track: true,
          eventSession: true,
        },
        orderBy: { submittedAt: "desc" },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Add cache headers for better performance
    const response = NextResponse.json(abstracts);
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching abstracts" });
    return NextResponse.json(
      { error: "Failed to fetch abstracts" },
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

    const validated = createAbstractSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { speakerId, title, content, trackId, status } = validated.data;

    // Parallelize event, speaker, and track validation
    const [event, speaker, track] = await Promise.all([
      db.event.findFirst({
        where: {
          id: eventId,
          organizationId: session.user.organizationId,
        },
        select: { id: true },
      }),
      db.speaker.findFirst({
        where: {
          id: speakerId,
          eventId,
        },
        select: { id: true },
      }),
      trackId
        ? db.track.findFirst({
            where: { id: trackId, eventId },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!speaker) {
      return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
    }

    if (trackId && !track) {
      return NextResponse.json({ error: "Track not found" }, { status: 404 });
    }

    const abstract = await db.abstract.create({
      data: {
        eventId,
        speakerId,
        title,
        content,
        trackId: trackId || null,
        status,
        submittedAt: status === "SUBMITTED" ? new Date() : undefined,
      },
      include: {
        speaker: true,
        track: true,
      },
    });

    // Log the action (non-blocking for better response time)
    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "CREATE",
        entityType: "Abstract",
        entityId: abstract.id,
        changes: JSON.parse(JSON.stringify({ abstract })),
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to create audit log" }));

    return NextResponse.json(abstract, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating abstract" });
    return NextResponse.json(
      { error: "Failed to create abstract" },
      { status: 500 }
    );
  }
}
