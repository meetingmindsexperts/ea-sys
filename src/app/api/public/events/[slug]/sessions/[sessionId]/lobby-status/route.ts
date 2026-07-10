import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { readWebinarSettings } from "@/lib/webinar";

type RouteParams = { params: Promise<{ slug: string; sessionId: string }> };

interface LobbyBody {
  roomOpen: boolean;
  ended: boolean;
  viewingMode: "zoom" | "hls";
  lobbyVideoUrl: string | null;
  lobbyMessage: string | null;
  startsAt: string;
  endsAt: string;
}

// Per-container micro-cache of the computed body, keyed by `${slug}:${sessionId}`.
const lobbyCache = new Map<string, { body: LobbyBody; at: number }>();
const LOBBY_TTL_MS = 3000;

/** Single-query lobby state; returns "not-found" if the event/session is invalid. */
async function computeLobbyBody(
  slug: string,
  sessionId: string,
): Promise<LobbyBody | "not-found"> {
  // One query (session joined to its event) instead of two sequential ones.
  const session = await db.eventSession.findFirst({
    where: { id: sessionId, event: { slug, status: { in: ["DRAFT", "PUBLISHED", "LIVE"] } } },
    select: {
      status: true,
      startTime: true,
      endTime: true,
      event: { select: { status: true, settings: true } },
    },
  });
  if (!session) return "not-found";

  const webinar = readWebinarSettings(session.event.settings);
  const now = Date.now();
  const endMs = session.endTime.getTime();
  // Room is "open" when the producer flips the anchor session LIVE. DRAFT events
  // auto-open so organizers can test the flow end-to-end.
  const roomOpen = session.status === "LIVE" || session.event.status === "DRAFT";
  const ended = session.status === "COMPLETED" || (endMs > 0 && now > endMs);

  return {
    roomOpen,
    ended,
    viewingMode: webinar?.viewingMode ?? "zoom",
    lobbyVideoUrl: webinar?.lobbyVideoUrl ?? null,
    lobbyMessage: webinar?.lobbyMessage ?? null,
    startsAt: session.startTime.toISOString(),
    endsAt: session.endTime.toISOString(),
  };
}

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
      apiLogger.warn({ slug, sessionId }, "lobby-status:rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    // In-process micro-cache: at 5k attendees all polling ~every 15-20s this
    // route would otherwise hit Postgres on every request (~hundreds/s on the
    // shared pool). A 3s cache per (slug, sessionId) collapses that to ~1 query
    // per 3s per container — and is invisible to the user (producer "open"
    // propagates within ~3s + the client poll). The Cache-Control also lets a
    // future CDN cache it at the edge.
    const cacheKey = `${slug}:${sessionId}`;
    const cached = lobbyCache.get(cacheKey);
    const cachedBody = cached && Date.now() - cached.at < LOBBY_TTL_MS ? cached.body : null;

    const body = cachedBody ?? (await computeLobbyBody(slug, sessionId));
    if (body === "not-found") {
      apiLogger.warn({ slug, sessionId }, "lobby-status:session-not-found");
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!cachedBody) {
      lobbyCache.set(cacheKey, { body, at: Date.now() });
    }

    return NextResponse.json(body, {
      headers: { "Cache-Control": "public, max-age=3, s-maxage=3" },
    });
  } catch (error) {
    apiLogger.error({ err: error }, "public/lobby-status:failed");
    return NextResponse.json({ error: "Failed to load lobby status" }, { status: 500 });
  }
}
