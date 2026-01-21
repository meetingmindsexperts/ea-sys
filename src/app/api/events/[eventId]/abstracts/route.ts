import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

const createAbstractSchema = z.object({
  speakerId: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  trackId: z.string().optional(),
  status: z.enum(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"]).default("SUBMITTED"),
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
    const status = searchParams.get("status");
    const trackId = searchParams.get("trackId");
    const speakerId = searchParams.get("speakerId");

    const abstracts = await db.abstract.findMany({
      where: {
        eventId,
        ...(status && { status: status as any }),
        ...(trackId && { trackId }),
        ...(speakerId && { speakerId }),
      },
      include: {
        speaker: true,
        track: true,
        eventSession: true,
      },
      orderBy: { submittedAt: "desc" },
    });

    return NextResponse.json(abstracts);
  } catch (error) {
    console.error("Error fetching abstracts:", error);
    return NextResponse.json(
      { error: "Failed to fetch abstracts" },
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
    const validated = createAbstractSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { speakerId, title, content, trackId, status } = validated.data;

    // Verify speaker exists
    const speaker = await db.speaker.findFirst({
      where: {
        id: speakerId,
        eventId,
      },
    });

    if (!speaker) {
      return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
    }

    // Verify track exists if provided
    if (trackId) {
      const track = await db.track.findFirst({
        where: { id: trackId, eventId },
      });
      if (!track) {
        return NextResponse.json({ error: "Track not found" }, { status: 404 });
      }
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

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "CREATE",
        entityType: "Abstract",
        entityId: abstract.id,
        changes: { abstract },
      },
    });

    return NextResponse.json(abstract, { status: 201 });
  } catch (error) {
    console.error("Error creating abstract:", error);
    return NextResponse.json(
      { error: "Failed to create abstract" },
      { status: 500 }
    );
  }
}
