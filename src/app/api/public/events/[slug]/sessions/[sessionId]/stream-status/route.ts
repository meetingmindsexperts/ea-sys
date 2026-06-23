import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";

type RouteParams = { params: Promise<{ slug: string; sessionId: string }> };

// In-process cache of the MediaMTX liveness probe, keyed by streamKey. At 5k
// viewers all LivePlayers poll this ~every 10s; without the cache each request
// fires an outbound probe at the single MediaMTX container (a self-DoS). A 3s
// TTL collapses the fan-out to ~1 probe / 3s per box. Per-container (resets on
// deploy) — fine for a liveness flag.
const probeCache = new Map<string, { isLive: boolean; at: number }>();
const PROBE_TTL_MS = 3000;

async function probeStreamLive(mediamtxUrl: string, streamKey: string): Promise<boolean> {
  const cached = probeCache.get(streamKey);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.isLive;
  let isLive = false;
  try {
    const res = await fetch(`${mediamtxUrl}/live/${streamKey}/index.m3u8`, {
      signal: AbortSignal.timeout(3000),
    });
    isLive = res.ok;
  } catch {
    // MediaMTX unreachable or stream not active → treat as not live.
  }
  probeCache.set(streamKey, { isLive, at: Date.now() });
  return isLive;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug, sessionId } = await params;

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

    const event = await db.event.findFirst({
      where: { slug, status: { in: ["DRAFT", "PUBLISHED", "LIVE"] } },
      select: { id: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

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
    // across all pollers for this streamKey, see probeStreamLive above).
    const mediamtxUrl = process.env.MEDIAMTX_HLS_URL || "http://localhost:8888";
    const isLive = await probeStreamLive(mediamtxUrl, zoomMeeting.streamKey);

    // Update DB status if it changed
    const newStatus = isLive ? "ACTIVE" : (zoomMeeting.streamStatus === "ACTIVE" ? "ENDED" : zoomMeeting.streamStatus);
    if (newStatus !== zoomMeeting.streamStatus) {
      await db.zoomMeeting.updateMany({
        where: { sessionId, liveStreamEnabled: true },
        data: { streamStatus: newStatus },
      });
      apiLogger.info({ sessionId, streamStatus: newStatus }, "zoom:stream-status-changed");
    }

    // Build HLS URLs for the client. At 5k viewers HLS is served from a CDN
    // (CloudFront) fronting the box — `HLS_CDN_BASE` points at the distribution.
    // We return BOTH so the player can fail over CDN → origin if the edge
    // misbehaves. Unset HLS_CDN_BASE ⇒ both fall back to the app origin
    // (single-box dev / small events).
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const cdnBase = process.env.HLS_CDN_BASE || appUrl;
    const path = `/stream/live/${zoomMeeting.streamKey}/index.m3u8`;
    const hlsPlaybackUrl = `${cdnBase}${path}`;
    const hlsOriginUrl = `${appUrl}${path}`;

    return NextResponse.json({
      status: isLive ? "active" : newStatus.toLowerCase(),
      hlsUrl: isLive ? hlsPlaybackUrl : null,
      // Direct-origin URL for player fallback when the CDN edge fails.
      hlsOriginUrl: isLive ? hlsOriginUrl : null,
      streamKey: zoomMeeting.streamKey,
    });
  } catch (error) {
    apiLogger.error({ err: error }, "zoom:stream-status-failed");
    return NextResponse.json({ error: "Failed to check stream status" }, { status: 500 });
  }
}
