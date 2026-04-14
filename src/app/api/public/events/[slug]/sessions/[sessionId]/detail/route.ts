import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { readSponsors } from "@/lib/webinar";

type RouteParams = { params: Promise<{ slug: string; sessionId: string }> };

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const { slug, sessionId } = await params;

    // Event + session fetched in parallel. Event settings are included
    // so we can surface the sponsor list on the public page.
    const event = await db.event.findFirst({
      where: {
        slug,
        status: { in: ["DRAFT", "PUBLISHED", "LIVE"] },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        eventType: true,
        bannerImage: true,
        settings: true,
        organization: { select: { name: true } },
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Topics + session metadata + speakers fetched together. Each topic
    // carries its own speakers (TopicSpeaker join), so we walk the
    // speaker→speaker relation in one round-trip instead of N+1.
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
            role: true,
            speaker: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                jobTitle: true,
                organization: true,
                photo: true,
                bio: true,
              },
            },
          },
        },
        topics: {
          orderBy: { sortOrder: "asc" },
          select: {
            id: true,
            title: true,
            sortOrder: true,
            duration: true,
            speakers: {
              select: {
                speaker: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    photo: true,
                    jobTitle: true,
                    organization: true,
                  },
                },
              },
            },
          },
        },
        zoomMeeting: {
          select: {
            recordingUrl: true,
            recordingPassword: true,
            recordingStatus: true,
          },
        },
      },
    });

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Read sponsors from the Event.settings JSON escape hatch. The helper
    // filters malformed rows + sorts by sortOrder.
    const sponsors = readSponsors(event.settings);

    return NextResponse.json({
      event: {
        name: event.name,
        slug: event.slug,
        eventType: event.eventType,
        bannerImage: event.bannerImage,
        organization: event.organization,
      },
      session: {
        id: session.id,
        name: session.name,
        description: session.description,
        startTime: session.startTime,
        endTime: session.endTime,
        location: session.location,
        capacity: session.capacity,
        status: session.status,
        track: session.track,
        zoomMeeting: session.zoomMeeting,
        speakers: session.speakers.map((s) => ({
          ...s.speaker,
          role: s.role,
        })),
        topics: session.topics.map((t) => ({
          id: t.id,
          title: t.title,
          sortOrder: t.sortOrder,
          duration: t.duration,
          speakers: t.speakers.map((ts) => ts.speaker),
        })),
      },
      sponsors,
    });
  } catch (error) {
    apiLogger.error({ err: error }, "zoom:session-detail-failed");
    return NextResponse.json({ error: "Failed to load session" }, { status: 500 });
  }
}
