import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { publicEventWhere } from "@/lib/public-event";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { isEventOrgStaff } from "@/lib/permissions/org-staff";
import { can, principalFromUser } from "@/lib/permissions/can";
import { isStreamArriving } from "@/lib/webinar/stream-probe";

type RouteParams = { params: Promise<{ slug: string; sessionId: string }> };

// M3 (program/agenda review): the HLS playback URL embeds the streamKey, which
// doubles as the RTMP PUBLISH credential on MediaMTX — so handing the URL to
// anyone both bypassed the registration gate zoom-join enforces AND leaked a
// credential an attacker could hijack the stream with. The URL fields are now
// gated on auth + (org staff | non-cancelled registration); unauthorized
// callers get the bare liveness flag. The registration check is micro-cached
// per (userId, eventId) so a 5k recovery-poll storm doesn't hammer the pool.
const viewerAuthCache = new Map<string, number>(); // key → cache expiry (ms epoch)
const VIEWER_AUTH_TTL_MS = 60_000;
const VIEWER_AUTH_CACHE_MAX = 20_000;

async function isAuthorizedViewer(
  user: { id: string; role?: string | null; organizationId?: string | null } | undefined,
  event: { id: string; organizationId: string; eventType: string | null },
): Promise<boolean> {
  if (!user) return false;
  const sameOrg = user.organizationId === event.organizationId;
  if (isEventOrgStaff(user, event.organizationId)) return true;
  // The Zoom host roles that are not general writers (WEBINARS, the producer
  // role) get the URLs for the console's stream preview, but only on WEBINAR
  // events: that role's host control stops at webinars, and the URL carries
  // the stream key (code review, Oct 2, 2026).
  if (can(principalFromUser(user), "zoomHost.view") && sameOrg && event.eventType === "WEBINAR") return true;
  const cacheKey = `${user.id}:${event.id}`;
  const cachedUntil = viewerAuthCache.get(cacheKey);
  if (cachedUntil && cachedUntil > Date.now()) return true;

  const registration = await db.registration.findFirst({
    where: { eventId: event.id, userId: user.id, status: { not: "CANCELLED" } },
    select: { id: true },
  });
  if (!registration) return false;

  // Positive results only — a just-registered attendee must not be blocked by
  // a cached negative. Bounded so an auth'd crawler can't grow it unbounded.
  if (viewerAuthCache.size >= VIEWER_AUTH_CACHE_MAX) viewerAuthCache.clear();
  viewerAuthCache.set(cacheKey, Date.now() + VIEWER_AUTH_TTL_MS);
  return true;
}

function nextStreamStatus<T extends string>(isLive: boolean, current: T): T | "ACTIVE" | "ENDED" {
  if (isLive) return "ACTIVE";
  return current === "ACTIVE" ? "ENDED" : current;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ slug, sessionId }, authSession] = await Promise.all([params, auth()]);

    const ip = getClientIp(req);
    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `stream-status:${ip}`,
      limit: 360, // 1 req per 10s for 1 hour
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ msg: "public/stream-status:rate-limited", retryAfterSeconds, ip });
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    // DRAFT stays reachable for the organizer test flow — with the URL fields
    // now viewer-gated, an anonymous caller on a DRAFT event learns only a
    // liveness boolean (M5 residual, accepted).
    const event = await db.event.findFirst({
      where: await publicEventWhere(req, slug, { statuses: ["DRAFT", "PUBLISHED", "LIVE"] }),
      select: { id: true, organizationId: true, eventType: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return await runWithTenant(event.organizationId, async () => {
    const zoomMeeting = await db.zoomMeeting.findFirst({
      where: {
        sessionId,
        session: { eventId: event.id },
        liveStreamEnabled: true,
      },
      select: { streamKey: true, streamStatus: true },
    });

    if (!zoomMeeting || !zoomMeeting.streamKey) {
      return NextResponse.json({ status: "unavailable" });
    }

    // Check if MediaMTX is actually serving the stream (cached probe — shared
    // across all pollers for this streamKey, see src/lib/webinar/stream-probe.ts).
    const isLive = await isStreamArriving(zoomMeeting.streamKey);

    // Reflect the probed reality into ZoomMeeting.streamStatus. A write on a
    // GET is deliberate here (M3-reviewed): it only fires on a REAL state
    // transition of the stream (probe-cached, so at most ~1 write per actual
    // ACTIVE↔ENDED flip), not per request — an attacker polling harder cannot
    // amplify it.
    const newStatus = nextStreamStatus(isLive, zoomMeeting.streamStatus);
    if (newStatus !== zoomMeeting.streamStatus) {
      // The event binding in the where is load-bearing: this is a PUBLIC route,
      // and without it a crafted sessionId flips streamStatus on another org's
      // row. organizationId in the data self-heals blue-green-window NULLs.
      await db.zoomMeeting.updateMany({
        where: { sessionId, eventId: event.id, liveStreamEnabled: true },
        data: { streamStatus: newStatus, organizationId: event.organizationId },
      });
      apiLogger.info({ sessionId, streamStatus: newStatus }, "zoom:stream-status-changed");
    }

    const status = isLive ? "active" : newStatus.toLowerCase();

    // URL fields only for authorized viewers (see the M3 note above). The
    // LivePlayer fetches same-origin with cookies, so real attendees — who
    // authenticated to get their initial URLs from zoom-join — pass this
    // transparently. streamKey itself is never returned (a publish credential
    // the client has no use for).
    const authorized = await isAuthorizedViewer(authSession?.user, event);
    if (!authorized) {
      if (authSession?.user) {
        apiLogger.warn(
          { userId: authSession.user.id, eventId: event.id, sessionId },
          "public/stream-status:urls-denied-not-registered",
        );
      }
      return NextResponse.json({ status });
    }

    // Build HLS URLs for the client. At 5k viewers HLS is served from a CDN
    // (CloudFront) fronting the box — `HLS_CDN_BASE` points at the distribution.
    // We return BOTH so the player can fail over CDN → origin if the edge
    // misbehaves. Unset HLS_CDN_BASE ⇒ both fall back to the app origin
    // (single-box dev / small events).
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const cdnBase = process.env.HLS_CDN_BASE || appUrl;
    const path = `/stream/live/${zoomMeeting.streamKey}/index.m3u8`;

    return NextResponse.json({
      status,
      hlsUrl: isLive ? `${cdnBase}${path}` : null,
      // Direct-origin URL for player fallback when the CDN edge fails.
      hlsOriginUrl: isLive ? `${appUrl}${path}` : null,
    });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "zoom:stream-status-failed");
    return NextResponse.json({ error: "Failed to check stream status" }, { status: 500 });
  }
}
