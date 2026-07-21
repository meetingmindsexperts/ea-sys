import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { isBreakSessionType } from "@/lib/session-enums";
import { readSponsors } from "@/lib/webinar";

type RouteParams = { params: Promise<{ slug: string; sessionId: string }> };

const ORG_STAFF_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "ORGANIZER"]);

/**
 * Public session detail — the program page's data source.
 *
 * BLOCKER B2 (program/agenda review, July 10 2026) hardened three things here:
 *   1. It returned `recordingUrl` + `recordingPassword` — the credential that
 *      gates the cloud recording of a paid/CME session — to ANY anonymous
 *      caller. Those now live behind the registration-gated `../recording`
 *      route. Only `recordingStatus` (a state, not a secret) stays public, so
 *      the page can still render the "Watch replay" / "Processing" states.
 *   2. It served DRAFT (unpublished, unannounced) events to the whole
 *      internet. DRAFT is now visible only to authenticated org staff, which
 *      preserves the organizer end-to-end testing this allowance existed for.
 *   3. It was the only public session route with NO rate limit (M4), which is
 *      what made the credential above freely enumerable across every session.
 */
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ slug, sessionId }, authSession] = await Promise.all([params, auth()]);

    const ip = getClientIp(req);
    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `session-detail:${ip}`,
      limit: 240,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ ip, sessionId }, "session-detail:rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    // Event + session fetched in parallel. Event settings are included
    // so we can surface the sponsor list on the public page.
    const event = await db.event.findFirst({
      where: {
        slug,
        // DRAFT is filtered out below unless the caller is org staff; keep it
        // in the query so we can distinguish "no such event" from "not yet
        // published" and log the difference.
        status: { in: ["DRAFT", "PUBLISHED", "LIVE"] },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        eventType: true,
        bannerImage: true,
        timezone: true,
        settings: true,
        organizationId: true,
        organization: { select: { name: true } },
      },
    });

    if (!event) {
      apiLogger.warn({ slug, sessionId, ip }, "session-detail:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // An unpublished event's program is not public. Org staff may preview it
    // (this is the organizer end-to-end testing path); everyone else gets the
    // same 404 as a nonexistent event — no existence leak.
    const isOrgStaff =
      !!authSession?.user &&
      ORG_STAFF_ROLES.has(authSession.user.role ?? "") &&
      authSession.user.organizationId === event.organizationId;

    if (event.status === "DRAFT" && !isOrgStaff) {
      apiLogger.warn(
        { slug, sessionId, ip, userId: authSession?.user?.id ?? null },
        "session-detail:draft-event-denied",
      );
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
        type: true,
        track: { select: { name: true, color: true } },
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
                    title: true,
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
          // NOTE: recordingUrl + recordingPassword are deliberately NOT selected
          // (B2). `recordingStatus` alone tells the page whether to show the
          // "Watch replay" button, which then fetches the credential from the
          // registration-gated `../recording` route.
          select: {
            recordingStatus: true,
          },
        },
      },
    });

    if (!session) {
      apiLogger.warn({ slug, sessionId, eventId: event.id, ip }, "session-detail:session-not-found");
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Break items (registration desk / coffee / lunch / networking) are agenda
    // time blocks — they have no public detail page. 404, same as a missing
    // session, so nothing can be inferred from the difference. The helper
    // treats an absent/unknown type as a real session, so we never hide a
    // legitimate session on bad data.
    if (isBreakSessionType(session.type)) {
      apiLogger.warn(
        { slug, sessionId, eventId: event.id, ip, type: session.type },
        "session-detail:break-item-denied",
      );
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
        timezone: event.timezone,
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
