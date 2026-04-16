import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import { listWebinarPanelists } from "@/lib/zoom";
import { resolveAnchorZoomMeeting } from "../../route";
import { sendPanelistInvite } from "@/lib/webinar-panelist-email";

type RouteParams = {
  params: Promise<{ eventId: string; panelistId: string }>;
};

// POST — resend the panelist invitation email for one existing panelist.
// Separate bucket from add (60/hr vs 30/hr) — resends are low-risk and
// organizers may click multiple times while chasing down unresponsive
// panelists during setup.
export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, panelistId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `webinar-panelists-resend:${eventId}`,
      limit: 60,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn(
        { eventId, userId: session.user.id },
        "webinar-panelists:resend-rate-limited",
      );
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const resolved = await resolveAnchorZoomMeeting(
      eventId,
      session.user.organizationId!,
    );
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }

    // Fetch the canonical list to pick up each panelist's privileged
    // join_url (Zoom's POST response doesn't reliably include it, so the
    // list endpoint is the only source of truth for this field).
    const panelists = await listWebinarPanelists(
      resolved.event.organizationId,
      resolved.zoomMeetingId,
    );
    const panelist = panelists.find((p) => p.id === panelistId);
    if (!panelist) {
      return NextResponse.json(
        { error: "Panelist not found" },
        { status: 404 },
      );
    }
    if (!panelist.join_url) {
      apiLogger.warn(
        { eventId, panelistId },
        "webinar-panelists:resend-missing-join-url",
      );
      return NextResponse.json(
        { error: "Panelist has no join link yet. Try again in a moment." },
        { status: 400 },
      );
    }

    try {
      await sendPanelistInvite({
        eventId,
        panelistName: panelist.name,
        panelistEmail: panelist.email,
        joinUrl: panelist.join_url,
        actorUserId: session.user.id,
      });
    } catch {
      return NextResponse.json(
        { error: "Failed to send invite" },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    apiLogger.error({ err }, "webinar-panelists:resend-failed");
    const message = err instanceof Error ? err.message : "Failed to resend invite";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
