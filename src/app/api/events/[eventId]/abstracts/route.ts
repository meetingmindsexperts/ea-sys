import { NextResponse } from "next/server";
import { z } from "zod";
import { AbstractStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";

const abstractStatusSchema = z.nativeEnum(AbstractStatus);

const createAbstractSchema = z.object({
  speakerId: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  specialty: z.string().optional(),
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

    // For SUBMITTER, restrict to their own abstracts via speaker.userId
    const submitterFilter = session.user.role === "SUBMITTER"
      ? { speaker: { userId: session.user.id } }
      : {};

    // Parallelize event validation and abstracts fetch
    const [event, abstracts] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        select: { id: true },
      }),
      db.abstract.findMany({
        where: {
          eventId,
          ...(status && { status }),
          ...(trackId && { trackId }),
          ...(speakerId && { speakerId }),
          ...submitterFilter,
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

    if (session.user.role === "REVIEWER") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const validated = createAbstractSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { speakerId, title, content, specialty, trackId, status } = validated.data;

    // SUBMITTER can only submit for their own speaker record
    const speakerWhere = session.user.role === "SUBMITTER"
      ? { id: speakerId, eventId, userId: session.user.id }
      : { id: speakerId, eventId };

    // Parallelize event, speaker, and track validation
    const [event, speaker, track] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        select: { id: true },
      }),
      db.speaker.findFirst({
        where: speakerWhere,
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
      return NextResponse.json(
        { error: session.user.role === "SUBMITTER" ? "Forbidden" : "Speaker not found" },
        { status: session.user.role === "SUBMITTER" ? 403 : 404 }
      );
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
        specialty: specialty || null,
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
