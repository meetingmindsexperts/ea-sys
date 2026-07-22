import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { publicEventWhere } from "@/lib/public-event";
import { checkRateLimit, getClientIp } from "@/lib/security";

type RouteParams = { params: Promise<{ slug: string; sessionId: string }> };

const ORG_STAFF_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "ORGANIZER"]);

/**
 * Registration-gated access to a session's cloud recording.
 *
 * BLOCKER B2 (program/agenda review, July 10 2026): the public session-detail
 * route used to return `recordingUrl` + `recordingPassword` to ANY anonymous
 * caller, with no auth and no rate limit — the recording passcode for a paid,
 * CME-accredited session was readable by anyone on the internet. Meanwhile the
 * LIVE path (`zoom-join`) required a signed-in, non-cancelled registration.
 * The two paths now enforce the same gate: you may watch the replay if, and
 * only if, you could have attended live.
 *
 * `recordingStatus` stays on the public detail route — it's a state, not a
 * credential, so the page can render "Recording processing" / "Watch replay"
 * without holding the secret. The button calls this route to fetch it.
 */
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ slug, sessionId }, authSession] = await Promise.all([params, auth()]);

    const ip = getClientIp(req);
    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `session-recording:${ip}`,
      limit: 60,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ ip, sessionId }, "session-recording:rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    if (!authSession?.user) {
      apiLogger.warn({ ip, sessionId }, "session-recording:denied:unauthenticated");
      return NextResponse.json(
        { error: "Sign in required to watch this recording", code: "UNAUTHENTICATED" },
        { status: 401 },
      );
    }

    const event = await db.event.findFirst({
      where: await publicEventWhere(req, slug, { statuses: ["DRAFT", "PUBLISHED", "LIVE"] }),
      select: { id: true, organizationId: true },
    });
    if (!event) {
      apiLogger.warn({ slug, sessionId, userId: authSession.user.id }, "session-recording:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Same authorization as the live join: org staff (QA / host testing) OR a
    // non-cancelled registration for this event.
    const isOrgStaff =
      ORG_STAFF_ROLES.has(authSession.user.role ?? "") &&
      authSession.user.organizationId === event.organizationId;

    if (!isOrgStaff) {
      const registration = await db.registration.findFirst({
        where: { eventId: event.id, userId: authSession.user.id, status: { not: "CANCELLED" } },
        select: { id: true },
      });
      if (!registration) {
        apiLogger.warn(
          { userId: authSession.user.id, eventId: event.id, sessionId },
          "session-recording:denied:not-registered",
        );
        return NextResponse.json(
          {
            error: "You must be registered for this event to watch the recording",
            code: "NOT_REGISTERED",
          },
          { status: 403 },
        );
      }
    }

    // Session must belong to THIS event (never trust a bare sessionId).
    const session = await db.eventSession.findFirst({
      where: { id: sessionId, eventId: event.id },
      select: {
        zoomMeeting: {
          select: { recordingUrl: true, recordingPassword: true, recordingStatus: true },
        },
      },
    });
    if (!session) {
      apiLogger.warn({ sessionId, eventId: event.id, userId: authSession.user.id }, "session-recording:session-not-found");
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const zoom = session.zoomMeeting;
    if (!zoom || zoom.recordingStatus !== "AVAILABLE" || !zoom.recordingUrl) {
      apiLogger.warn(
        { sessionId, eventId: event.id, recordingStatus: zoom?.recordingStatus ?? null },
        "session-recording:not-available",
      );
      return NextResponse.json(
        { error: "No recording is available for this session", code: "RECORDING_NOT_AVAILABLE" },
        { status: 404 },
      );
    }

    apiLogger.info(
      { sessionId, eventId: event.id, userId: authSession.user.id, isOrgStaff },
      "session-recording:served",
    );

    const response = NextResponse.json({
      recordingUrl: zoom.recordingUrl,
      recordingPassword: zoom.recordingPassword,
      recordingStatus: zoom.recordingStatus,
    });
    // Credential-bearing + per-user authorized: never cache anywhere.
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    apiLogger.error({ err: error }, "session-recording:failed");
    return NextResponse.json({ error: "Failed to load recording" }, { status: 500 });
  }
}
