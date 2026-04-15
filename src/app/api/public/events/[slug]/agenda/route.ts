import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";

interface RouteParams {
  params: Promise<{ slug: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const clientIp = getClientIp(req);
    const ipRateLimit = checkRateLimit({
      key: `public-agenda:ip:${clientIp}`,
      limit: 120,
      windowMs: 60 * 1000,
    });

    if (!ipRateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(ipRateLimit.retryAfterSeconds) } }
      );
    }

    const { slug } = await params;

    const event = await db.event.findFirst({
      where: {
        OR: [{ slug }, { id: slug }],
        status: { in: ["PUBLISHED", "LIVE"] },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        startDate: true,
        endDate: true,
        supportEmail: true,
        settings: true,
        organization: { select: { name: true, logo: true } },
        tracks: {
          select: { id: true, name: true, color: true },
          orderBy: { sortOrder: "asc" },
        },
        eventSessions: {
          where: {
            status: { in: ["SCHEDULED", "LIVE", "COMPLETED"] },
          },
          select: {
            id: true,
            name: true,
            description: true,
            startTime: true,
            endTime: true,
            location: true,
            capacity: true,
            status: true,
            track: { select: { id: true, name: true, color: true } },
            speakers: {
              select: {
                speaker: {
                  select: {
                    id: true,
                    title: true,
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
          orderBy: { startTime: "asc" },
        },
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Check if the agenda has been published by the organizer
    const settings = (event.settings ?? {}) as Record<string, unknown>;
    if (!settings.agendaPublished && !settings.programmePublished) {
      return NextResponse.json({ error: "Agenda not published yet" }, { status: 404 });
    }

    const response = NextResponse.json({
      id: event.id,
      name: event.name,
      slug: event.slug,
      startDate: event.startDate,
      endDate: event.endDate,
      supportEmail: event.supportEmail,
      organization: event.organization,
      tracks: event.tracks,
      sessions: event.eventSessions,
    });

    response.headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return response;
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching public agenda" });
    return NextResponse.json({ error: "Failed to fetch agenda" }, { status: 500 });
  }
}
