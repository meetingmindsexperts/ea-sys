import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

type RouteParams = { params: Promise<{ slug: string; sessionId: string }> };

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const { slug, sessionId } = await params;

    const event = await db.event.findFirst({
      where: {
        slug,
        status: { in: ["DRAFT", "PUBLISHED", "LIVE"] },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        bannerImage: true,
        organization: { select: { name: true } },
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const session = await db.eventSession.findFirst({
      where: { id: sessionId, eventId: event.id },
      select: {
        id: true,
        name: true,
        description: true,
        startTime: true,
        endTime: true,
        location: true,
        capacity: true,
        status: true,
        track: { select: { name: true, color: true } },
        speakers: {
          select: {
            speaker: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                jobTitle: true,
                organization: true,
                photo: true,
              },
            },
          },
        },
      },
    });

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    return NextResponse.json({
      event: {
        name: event.name,
        slug: event.slug,
        bannerImage: event.bannerImage,
        organization: event.organization,
      },
      session: {
        ...session,
        speakers: session.speakers.map((s) => s.speaker),
      },
    });
  } catch (error) {
    apiLogger.error({ err: error }, "zoom:session-detail-failed");
    return NextResponse.json({ error: "Failed to load session" }, { status: 500 });
  }
}
