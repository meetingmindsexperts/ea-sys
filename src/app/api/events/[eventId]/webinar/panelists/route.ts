import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, WEBINAR_STAFF_ALLOW } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { buildEventAccessWhere } from "@/lib/event-access";
import { readWebinarSettings } from "@/lib/webinar";
import {
  addWebinarPanelists,
  listWebinarPanelists,
  removeWebinarPanelist,
} from "@/lib/zoom";
import { sendPanelistInvite } from "@/lib/webinar-panelist-email";

type RouteParams = { params: Promise<{ eventId: string }> };

const addPanelistSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255),
});

/**
 * Resolve the webinar's anchor Zoom meeting for an event.
 * Returns a tagged union — callers can early-return the error branch into a
 * NextResponse. Exported so sibling routes (sync-speakers) can reuse the same
 * 4-step lookup (event access → anchor session → zoom meeting → meeting type
 * is WEBINAR) without duplicating it.
 */
export type ResolvedAnchor =
  | {
      ok: true;
      event: { id: string; organizationId: string };
      anchorSessionId: string;
      zoomMeetingId: string;
    }
  | { ok: false; status: number; error: string };

export async function resolveAnchorZoomMeeting(
  eventId: string,
  // Was `organizationId: string` with a hand-rolled { id, organizationId }
  // lookup. WEBINAR_STAFF_ALLOW routes MUST resolve through buildEventAccessWhere
  // (its invariant): for WEBINARS that matches ONLY webinar events, and for a
  // future assignment-gated role it honours the gate — a hand-rolled org-scoped
  // lookup next to this allow-list is the exact anti-pattern the invariant bans.
  user: Parameters<typeof buildEventAccessWhere>[0],
): Promise<ResolvedAnchor> {
  const event = await db.event.findFirst({
    where: buildEventAccessWhere(user, eventId),
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

  const zoomMeeting = await db.zoomMeeting.findFirst({
    where: { sessionId: anchorSessionId, eventId },
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
    anchorSessionId,
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
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/webinar/panelists:GET" });
    if ("error" in orgGuard) return orgGuard.error;

    // Panelist rows carry each panelist's join_url — a Zoom bearer link granting
    // present / share-screen / unmute. Host-adjacent data: gate the read like the
    // POST/DELETE below, so a read-only MEMBER / unassigned ONSITE / CRM_USER
    // cannot enumerate it. (The write variants were already gated; the GET was
    // the gap.)
    const denied = denyReviewer(session, { allow: WEBINAR_STAFF_ALLOW, route: "events/[eventId]/webinar/panelists:GET" });
    if (denied) return denied;

    return await runWithTenant(orgGuard.orgId, async () => {
    const resolved = await resolveAnchorZoomMeeting(
      eventId,
      session.user,
    );
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }

    const panelists = await listWebinarPanelists(
      resolved.event.organizationId,
      resolved.zoomMeetingId,
    );
    return NextResponse.json({ panelists });
    });
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
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/webinar/panelists:POST" });
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session, { allow: WEBINAR_STAFF_ALLOW, route: "events/[eventId]/webinar/panelists:POST" });
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

    return await runWithTenant(orgGuard.orgId, async () => {
    const resolved = await resolveAnchorZoomMeeting(
      eventId,
      session.user,
    );
    if (!resolved.ok) {
      apiLogger.warn(
        { eventId, reason: resolved.error },
        "webinar-panelists:add-precondition-failed",
      );
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }

    await addWebinarPanelists(
      resolved.event.organizationId,
      resolved.zoomMeetingId,
      [validated.data],
    );

    apiLogger.info(
      {
        eventId,
        userId: session.user.id,
        zoomMeetingId: resolved.zoomMeetingId,
        panelistEmail: validated.data.email,
      },
      "webinar-panelists:added",
    );

    // Zoom's POST /panelists does NOT reliably return join_url in the
    // response body (known API quirk — Zoom staff's documented workaround
    // is to GET the list after adding). Fetch the canonical list to pick
    // up the newly-created row's privileged join_url.
    let invitesQueued = 0;
    try {
      const currentPanelists = await listWebinarPanelists(
        resolved.event.organizationId,
        resolved.zoomMeetingId,
      );
      const created = currentPanelists.find(
        (p) => p.email?.toLowerCase() === validated.data.email.toLowerCase(),
      );
      if (created?.join_url) {
        invitesQueued = 1;
        sendPanelistInvite({
          eventId,
          panelistName: created.name || validated.data.name,
          panelistEmail: created.email || validated.data.email,
          joinUrl: created.join_url,
          actorUserId: session.user.id,
        }).catch(() => {
          // Already logged inside the helper; route still returns success.
          // User can click Resend to retry.
        });
      } else {
        apiLogger.warn(
          { eventId, panelistEmail: validated.data.email },
          "webinar-panelists:added-but-no-join-url",
        );
      }
    } catch (listErr) {
      apiLogger.warn(
        { err: listErr, eventId, panelistEmail: validated.data.email },
        "webinar-panelists:post-add-list-failed",
      );
    }

    return NextResponse.json({ ok: true, invitesQueued });
    });
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
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/webinar/panelists:DELETE" });
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session, { allow: WEBINAR_STAFF_ALLOW, route: "events/[eventId]/webinar/panelists:DELETE" });
    if (denied) return denied;

    const url = new URL(req.url);
    const panelistId = url.searchParams.get("panelistId");
    if (!panelistId) {
      return NextResponse.json(
        { error: "panelistId query param required" },
        { status: 400 },
      );
    }

    return await runWithTenant(orgGuard.orgId, async () => {
    const resolved = await resolveAnchorZoomMeeting(
      eventId,
      session.user,
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
    });
  } catch (err) {
    apiLogger.error({ err }, "webinar-panelists:remove-failed");
    const message = err instanceof Error ? err.message : "Failed to remove panelist";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
