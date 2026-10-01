import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { buildEventAccessWhere } from "@/lib/event-access";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, WEBINAR_STAFF_ALLOW } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { readWebinarSettings } from "@/lib/webinar";
import { controlWebinarLiveStream, rtmpIngestUrl } from "@/lib/webinar/livestream";
import { canViewZoomHostCredentials } from "@/lib/zoom-visibility";

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
 * address than the one Zoom received. Host-credential roles only.
 */
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!canViewZoomHostCredentials(session.user.role, false)) {
      apiLogger.warn({ eventId, role: session.user.role }, "webinar-livestream:ingest-url-denied");
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/webinar/livestream:GET" });
    if ("error" in orgGuard) return orgGuard.error;
    return await runWithTenant(orgGuard.orgId, async () => {
      const event = await db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        select: { id: true },
      });
      if (!event) {
        apiLogger.warn({ eventId, userId: session.user.id }, "webinar-livestream:ingest-url-event-not-found");
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      return NextResponse.json({ rtmpIngestUrl: rtmpIngestUrl() });
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

    const denied = denyReviewer(session, {
      allow: WEBINAR_STAFF_ALLOW,
      route: "events/[eventId]/webinar/livestream:POST",
    });
    if (denied) return denied;

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
        where: buildEventAccessWhere(session.user, eventId),
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
      return NextResponse.json({ ok: true, action: result.action });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-livestream:failed");
    return NextResponse.json({ error: "Failed to control the live stream" }, { status: 500 });
  }
}
