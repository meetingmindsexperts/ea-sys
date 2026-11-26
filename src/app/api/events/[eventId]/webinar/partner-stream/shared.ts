/**
 * What the partner-stream routes share (Nov 16, 2026; external streams step 5):
 * finding the webinar the key belongs to, and turning a service refusal into
 * an HTTP answer. Never imported outside these routes.
 */
import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { readWebinarSettings } from "@/lib/webinar";
import { webinarVideoSource } from "@/lib/webinar/video-source";
import type { ExternalStreamErrorCode, ExternalStreamResult } from "@/services/external-stream-service";
import { findGatedEvent, type EventGate } from "@/lib/tenant/event-tenant";

export const PARTNER_STREAM_STATUS: Record<ExternalStreamErrorCode, number> = {
  SESSION_NOT_FOUND: 404,
  NOT_ISSUED: 404,
  ZOOM_WEBINAR_EXISTS: 409,
  ALREADY_ISSUED: 409,
  INVALID_PERIOD: 400,
  // The server is not set up for partner streams: nothing the person pressing the button can fix.
  PUBLISH_SECRET_NOT_SET: 503,
  CONTROL_API_NOT_SET: 503,
};

export type PartnerWebinar =
  | { ok: true; sessionId: string; slug: string | null; settings: unknown }
  | { ok: false; response: NextResponse };

/**
 * The webinar's anchor session, when the webinar is streamed by a partner.
 * A key is issued only on a partner webinar: on one of ours the session gets a
 * Zoom webinar, and a key beside it would give the session two sources.
 */
export async function findPartnerWebinar(
  gate: EventGate,
  log: { eventId: string; userId: string; route: string },
): Promise<PartnerWebinar> {
  const event = await findGatedEvent(gate, { select: { id: true, eventType: true, settings: true, slug: true } });
  if (!event) {
    apiLogger.warn(log, "webinar-partner-stream:event-not-found");
    return { ok: false, response: NextResponse.json({ error: "Event not found" }, { status: 404 }) };
  }
  if (event.eventType !== "WEBINAR" || webinarVideoSource(event.settings) !== "external") {
    apiLogger.warn(log, "webinar-partner-stream:not-a-partner-webinar");
    return {
      ok: false,
      response: NextResponse.json(
        { error: "This webinar's video comes from our own Zoom, so it has no partner stream key.", code: "NOT_PARTNER_SOURCE" },
        // The request is fine; the webinar is the wrong kind for it.
        { status: 409 },
      ),
    };
  }
  const sessionId = readWebinarSettings(event.settings)?.sessionId;
  if (!sessionId) {
    apiLogger.warn(log, "webinar-partner-stream:no-anchor-session");
    return {
      ok: false,
      response: NextResponse.json(
        { error: "This webinar has no session yet. Press Re-run provisioner first.", code: "NO_ANCHOR_SESSION" },
        { status: 409 },
      ),
    };
  }
  return { ok: true, sessionId, slug: event.slug ?? null, settings: event.settings };
}

/** A service refusal as an HTTP answer. The service has already logged it. */
export function partnerStreamRefusal(result: Extract<ExternalStreamResult, { ok: false }>): NextResponse {
  return NextResponse.json({ error: result.message, code: result.code }, { status: PARTNER_STREAM_STATUS[result.code] });
}
