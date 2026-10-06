import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { readWebinarSettings } from "@/lib/webinar";
import { controlWebinarLiveStream, rtmpIngestUrl } from "@/lib/webinar/livestream";

type RouteParams = { params: Promise<{ eventId: string }> };

const schema = z.object({ action: z.enum(["sync", "start", "stop"]) });

const STATUS_BY_CODE = {
  NO_ZOOM_MEETING: 404,
  STREAM_NOT_CONFIGURED: 400,
  ZOOM_API_FAILED: 502,
} as const;

/**
 * The RTMP address Zoom is told to push to, for the session card. Read from
 * the same function the sync uses, so the card can never show a different
 * address than the one Zoom received. Also the HLS address for the console's
 * stream preview. Webinar hosts only (the HLS path is the stream key).
 */
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/webinar/livestream:GET" });
    if ("error" in orgGuard) return orgGuard.error;
    // The ingest and HLS addresses carry the stream key, a host credential, so
    // this read needs the key that runs the webinar, refused (not hidden).
    const gate = requirePermission(session, "webinar.manage", { route: "events/[eventId]/webinar/livestream:GET", eventId });
    if (!gate.ok) return gate.response;
    return await runWithTenant(orgGuard.orgId, async () => {
      const event = await db.event.findFirst({
        where: gate.eventWhere,
        select: { id: true, settings: true },
      });
      if (!event) {
        apiLogger.warn({ eventId, userId: session.user.id }, "webinar-livestream:ingest-url-event-not-found");
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      // The console's stream preview (Oct 2, 2026) plays the same HLS address
      // attendees get, so the producer can see the stream arrive before
      // opening the room. Null while the anchor session has no stream set up.
      const anchorId = readWebinarSettings(event.settings)?.sessionId;
      const meeting = anchorId
        ? await db.zoomMeeting.findFirst({
            where: { sessionId: anchorId, eventId, liveStreamEnabled: true },
            select: { streamKey: true },
          })
        : null;
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
      const cdnBase = process.env.HLS_CDN_BASE || appUrl;
      return NextResponse.json({
        rtmpIngestUrl: rtmpIngestUrl(),
        hlsPreviewUrl: meeting?.streamKey ? `${cdnBase}/stream/live/${meeting.streamKey}/index.m3u8` : null,
      });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-livestream:ingest-url-failed");
    return NextResponse.json({ error: "Failed to read the stream address" }, { status: 500 });
  }
}

/**
 * Producer controls for the custom stream (RTMP to HLS) on the webinar's
 * anchor session: `sync` sends the stream address and key to Zoom (and turns
 * streaming on for a session created without it), `start` and `stop` tell
 * Zoom to begin or end pushing. Same guards as the room toggle.
 */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([auth(), params, req.json()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/webinar/livestream:POST" });
    if ("error" in orgGuard) return orgGuard.error;

    const gate = requirePermission(session, "webinar.manage", { route: "events/[eventId]/webinar/livestream:POST", eventId });
    if (!gate.ok) return gate.response;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `webinar-livestream:${eventId}`,
      limit: 60,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ eventId, userId: session.user.id }, "webinar-livestream:rate-limited");
      return NextResponse.json(
        { error: "Too many requests", retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const validated = schema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ errors: validated.error.flatten() }, "webinar-livestream:validation-failed");
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 },
      );
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const event = await db.event.findFirst({
        where: gate.eventWhere,
        select: { id: true, slug: true, settings: true },
      });
      if (!event) {
        apiLogger.warn({ eventId, userId: session.user.id }, "webinar-livestream:event-not-found");
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      const webinar = readWebinarSettings(event.settings);
      if (!webinar?.sessionId) {
        apiLogger.warn({ eventId }, "webinar-livestream:no-anchor-session");
        return NextResponse.json(
          { error: "This event has no webinar session. Re-run the provisioner first." },
          { status: 400 },
        );
      }
      const anchor = await db.eventSession.findFirst({
        where: { id: webinar.sessionId, eventId },
        select: { name: true },
      });

      const result = await controlWebinarLiveStream({
        organizationId: orgGuard.orgId,
        eventId,
        eventSlug: event.slug,
        sessionId: webinar.sessionId,
        sessionName: anchor?.name ?? "Webinar",
        action: validated.data.action,
        userId: session.user.id,
      });
      if (!result.ok) {
        apiLogger.warn({ eventId, code: result.code, action: validated.data.action }, "webinar-livestream:refused");
        return NextResponse.json(
          { error: result.message, code: result.code },
          { status: STATUS_BY_CODE[result.code] },
        );
      }
      return NextResponse.json({ ok: true, action: result.action, notRunning: result.notRunning === true });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-livestream:failed");
    return NextResponse.json({ error: "Failed to control the live stream" }, { status: 500 });
  }
}
