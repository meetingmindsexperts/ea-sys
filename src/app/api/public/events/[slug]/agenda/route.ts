import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { publicEventWhere } from "@/lib/public-event";
import { runWithTenant } from "@/lib/tenant-context";
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
      apiLogger.warn({ msg: "public/agenda:rate-limited", retryAfterSeconds: ipRateLimit.retryAfterSeconds, ip: clientIp });
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(ipRateLimit.retryAfterSeconds) } }
      );
    }

    const { slug } = await params;

    // Resolve the tenant BEFORE reading anything policied.
    //
    // Event carries no RLS policy, so this slim lookup works with no lane —
    // and it is the only thing here that can run without one. Everything below
    // reads tables that ARE policied (TicketType, PricingTier, EventSession,
    // PromoCode), and under RLS a query outside a tenant lane returns zero
    // rows rather than an error. This route previously did the event lookup
    // and those policied includes in ONE query, so on the platform the event
    // resolved fine and its registration types came back EMPTY — every public
    // event page would have read "Registration Closed" with nothing in the
    // logs. Found in the two-tenant sandbox, Aug 21 2026.
    const scope = await db.event.findFirst({
      where: await publicEventWhere(req, slug, {
        allowIdFallback: true,
        statuses: ["PUBLISHED", "LIVE"],
      }),
      select: { id: true, organizationId: true },
    });

    if (!scope) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return await runWithTenant(scope.organizationId, async () => {
    const event = await db.event.findFirst({
      where: { id: scope.id },
      select: {
        id: true,
        name: true,
        slug: true,
        startDate: true,
        endDate: true,
        timezone: true,
        supportEmail: true,
        bannerImage: true,
        bannerImageMobile: true,
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
            type: true,
            track: { select: { id: true, name: true, color: true } },
            speakers: {
              select: {
                role: true,
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
            topics: {
              select: {
                id: true,
                title: true,
                duration: true,
                sortOrder: true,
                speakers: {
                  select: {
                    speaker: {
                      select: { id: true, title: true, firstName: true, lastName: true },
                    },
                  },
                },
              },
              orderBy: { sortOrder: "asc" },
            },
          },
          orderBy: { startTime: "asc" },
        },
      },
    });

    if (!event) {
      apiLogger.warn({ slug }, "public-agenda:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Check if the agenda has been published by the organizer
    const settings = (event.settings ?? {}) as Record<string, unknown>;
    if (!settings.agendaPublished && !settings.programmePublished) {
      apiLogger.warn({ slug, eventId: event.id }, "public-agenda:not-published");
      return NextResponse.json({ error: "Agenda not published yet" }, { status: 404 });
    }

    const response = NextResponse.json({
      id: event.id,
      name: event.name,
      slug: event.slug,
      startDate: event.startDate,
      endDate: event.endDate,
      timezone: event.timezone,
      supportEmail: event.supportEmail,
      bannerImage: event.bannerImage,
      bannerImageMobile: event.bannerImageMobile,
      organization: event.organization,
      tracks: event.tracks,
      sessions: event.eventSessions,
    });

    response.headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return response;
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching public agenda" });
    return NextResponse.json({ error: "Failed to fetch agenda" }, { status: 500 });
  }
}
