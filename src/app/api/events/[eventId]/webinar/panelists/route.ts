import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import { readWebinarSettings } from "@/lib/webinar";
import {
  addWebinarPanelists,
  listWebinarPanelists,
  removeWebinarPanelist,
} from "@/lib/zoom";

type RouteParams = { params: Promise<{ eventId: string }> };

const addPanelistSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255),
});

/**
 * Resolve the webinar's anchor Zoom meeting for an event.
 * Returns { error: NextResponse } when any step fails so callers can early-return.
 */
async function resolveAnchorZoomMeeting(
  eventId: string,
  organizationId: string,
): Promise<
  | {
      ok: true;
      event: { id: string; organizationId: string };
      zoomMeetingId: string;
    }
  | { ok: false; status: number; error: string }
> {
  const event = await db.event.findFirst({
    where: { id: eventId, organizationId },
    select: { id: true, organizationId: true, settings: true },
  });
  if (!event) {
    return { ok: false, status: 404, error: "Event not found" };
  }

  const webinar = readWebinarSettings(event.settings);
  const anchorSessionId = webinar?.sessionId;
  if (!anchorSessionId) {
    return {
      ok: false,
      status: 400,
      error: "No anchor session. Run the webinar provisioner first.",
    };
  }

  const zoomMeeting = await db.zoomMeeting.findUnique({
    where: { sessionId: anchorSessionId },
    select: { zoomMeetingId: true, meetingType: true },
  });
  if (!zoomMeeting) {
    return {
      ok: false,
      status: 400,
      error: "No Zoom webinar attached to the anchor session.",
    };
  }
  if (zoomMeeting.meetingType === "MEETING") {
    return {
      ok: false,
      status: 400,
      error: "Panelists are only available for webinars.",
    };
  }

  return {
    ok: true,
    event: { id: event.id, organizationId: event.organizationId },
    zoomMeetingId: zoomMeeting.zoomMeetingId,
  };
}

// ── GET — list current panelists from Zoom ────────────────────────

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const resolved = await resolveAnchorZoomMeeting(
      eventId,
      session.user.organizationId!,
    );
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }

    const panelists = await listWebinarPanelists(
      resolved.event.organizationId,
      resolved.zoomMeetingId,
    );
    return NextResponse.json({ panelists });
  } catch (err) {
    apiLogger.error({ err }, "webinar-panelists:list-failed");
    const message = err instanceof Error ? err.message : "Failed to list panelists";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ── POST — add a single panelist by name+email ────────────────────

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([
      auth(),
      params,
      req.json().catch(() => null),
    ]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `webinar-panelists-add:${eventId}`,
      limit: 30,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn(
        { eventId, userId: session.user.id },
        "webinar-panelists:rate-limited",
      );
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const validated = addPanelistSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn(
        { errors: validated.error.flatten(), eventId },
        "webinar-panelists:add-validation-failed",
      );
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 },
      );
    }

    const resolved = await resolveAnchorZoomMeeting(
      eventId,
      session.user.organizationId!,
    );
    if (!resolved.ok) {
      apiLogger.warn(
        { eventId, reason: resolved.error },
        "webinar-panelists:add-precondition-failed",
      );
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }

    await addWebinarPanelists(resolved.event.organizationId, resolved.zoomMeetingId, [
      validated.data,
    ]);

    apiLogger.info(
      {
        eventId,
        userId: session.user.id,
        zoomMeetingId: resolved.zoomMeetingId,
        panelistEmail: validated.data.email,
      },
      "webinar-panelists:added",
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    apiLogger.error({ err }, "webinar-panelists:add-failed");
    const message = err instanceof Error ? err.message : "Failed to add panelist";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ── DELETE — remove a panelist by Zoom panelist id ────────────────

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const url = new URL(req.url);
    const panelistId = url.searchParams.get("panelistId");
    if (!panelistId) {
      return NextResponse.json(
        { error: "panelistId query param required" },
        { status: 400 },
      );
    }

    const resolved = await resolveAnchorZoomMeeting(
      eventId,
      session.user.organizationId!,
    );
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }

    await removeWebinarPanelist(
      resolved.event.organizationId,
      resolved.zoomMeetingId,
      panelistId,
    );

    apiLogger.info(
      {
        eventId,
        userId: session.user.id,
        zoomMeetingId: resolved.zoomMeetingId,
        panelistId,
      },
      "webinar-panelists:removed",
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    apiLogger.error({ err }, "webinar-panelists:remove-failed");
    const message = err instanceof Error ? err.message : "Failed to remove panelist";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
