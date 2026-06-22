import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { readWebinarSettings } from "@/lib/webinar";

type RouteParams = { params: Promise<{ slug: string; sessionId: string }> };

/**
 * Public, lightweight waiting-room state for the webinar lobby. The lobby polls
 * this to learn (a) whether the producer has opened the room (anchor session is
 * LIVE), (b) which viewing mode to render, and (c) the holding-video/message +
 * timing for the countdown.
 *
 * Deliberately NON-sensitive (no per-user data) and cacheable so 5k attendees
 * polling it is cheap and CDN-frontable. Actual admission (embed creds / stream)
 * still goes through the auth + registration-gated zoom-join route.
 */
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug, sessionId } = await params;

    const ip = getClientIp(req);
    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `lobby-status:${ip}`,
      limit: 600, // generous — responses are cached, this is just a safety valve
      windowMs: 3600_000,
    });
    if (!allowed) {
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const event = await db.event.findFirst({
      where: { slug, status: { in: ["DRAFT", "PUBLISHED", "LIVE"] } },
      select: { id: true, status: true, settings: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const session = await db.eventSession.findFirst({
      where: { id: sessionId, eventId: event.id },
      select: { id: true, status: true, startTime: true, endTime: true },
    });
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const webinar = readWebinarSettings(event.settings);
    const now = Date.now();
    const endMs = session.endTime.getTime();
    // Room is "open" when the producer flips the anchor session LIVE. DRAFT
    // events auto-open so organizers can test the flow end-to-end.
    const roomOpen = session.status === "LIVE" || event.status === "DRAFT";
    const ended = session.status === "COMPLETED" || (endMs > 0 && now > endMs);

    const body = {
      roomOpen,
      ended,
      viewingMode: webinar?.viewingMode ?? "zoom",
      lobbyVideoUrl: webinar?.lobbyVideoUrl ?? null,
      lobbyMessage: webinar?.lobbyMessage ?? null,
      startsAt: session.startTime.toISOString(),
      endsAt: session.endTime.toISOString(),
    };

    return NextResponse.json(body, {
      // Short cache so a wave of 5k pollers collapses to ~1 origin hit / 5s
      // (and is CDN-frontable). The producer "open" propagates within ~5s.
      headers: { "Cache-Control": "public, max-age=5, s-maxage=5" },
    });
  } catch (error) {
    apiLogger.error({ err: error }, "public/lobby-status:failed");
    return NextResponse.json({ error: "Failed to load lobby status" }, { status: 500 });
  }
}
