import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import { addWebinarPanelists, listWebinarPanelists } from "@/lib/zoom";
import { resolveAnchorZoomMeeting } from "../route";

type RouteParams = { params: Promise<{ eventId: string }> };

// POST — batch-sync all anchor-session speakers to Zoom as webinar panelists.
// Speakers without an email are skipped; the response reports the counts.
export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    // Share the existing panelist-add rate-limit bucket so a user can't
    // combine single-adds + bulk-syncs to exceed 30/hr.
    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `webinar-panelists-add:${eventId}`,
      limit: 30,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn(
        { eventId, userId: session.user.id },
        "webinar-panelists:sync-speakers-rate-limited",
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
      apiLogger.warn(
        { eventId, reason: resolved.error },
        "webinar-panelists:sync-speakers-precondition-failed",
      );
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }

    // Pull anchor-session speakers + existing Zoom panelists in parallel.
    // We'll filter out emails that are already on Zoom so the bulk add
    // doesn't fail with 409 Conflict on re-imports.
    const [sessionSpeakers, existingPanelists] = await Promise.all([
      db.sessionSpeaker.findMany({
        where: { sessionId: resolved.anchorSessionId },
        select: {
          speaker: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
      }),
      listWebinarPanelists(resolved.event.organizationId, resolved.zoomMeetingId),
    ]);

    const existingEmails = new Set(
      existingPanelists
        .map((p) => p.email?.toLowerCase())
        .filter((e): e is string => Boolean(e)),
    );

    const candidates = sessionSpeakers
      .filter((ss) => ss.speaker.email)
      .map((ss) => ({
        name: `${ss.speaker.firstName} ${ss.speaker.lastName}`.trim(),
        email: ss.speaker.email,
      }));

    const toAdd = candidates.filter(
      (c) => !existingEmails.has(c.email.toLowerCase()),
    );

    const totalSpeakers = sessionSpeakers.length;
    const skippedNoEmail = totalSpeakers - candidates.length;
    const skippedAlreadyPanelist = candidates.length - toAdd.length;

    if (toAdd.length === 0) {
      apiLogger.info(
        { eventId, totalSpeakers, skippedNoEmail, skippedAlreadyPanelist },
        "webinar-panelists:sync-speakers-nothing-to-add",
      );
      const reason =
        totalSpeakers === 0
          ? "No speakers assigned to the webinar session yet."
          : skippedAlreadyPanelist > 0
            ? "All speakers are already panelists."
            : "All speakers are missing an email address.";
      return NextResponse.json({
        ok: true,
        added: 0,
        totalSpeakers,
        skippedNoEmail,
        skippedAlreadyPanelist,
        reason,
      });
    }

    await addWebinarPanelists(
      resolved.event.organizationId,
      resolved.zoomMeetingId,
      toAdd,
    );

    apiLogger.info(
      {
        eventId,
        userId: session.user.id,
        zoomMeetingId: resolved.zoomMeetingId,
        added: toAdd.length,
        totalSpeakers,
        skippedNoEmail,
        skippedAlreadyPanelist,
      },
      "webinar-panelists:sync-speakers-succeeded",
    );

    return NextResponse.json({
      ok: true,
      added: toAdd.length,
      totalSpeakers,
      skippedNoEmail,
      skippedAlreadyPanelist,
    });
  } catch (err) {
    apiLogger.error({ err }, "webinar-panelists:sync-speakers-failed");
    const message = err instanceof Error ? err.message : "Failed to sync speakers";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
