import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import { readWebinarSettings } from "@/lib/webinar";

type RouteParams = { params: Promise<{ eventId: string }> };

const roomSchema = z.object({ open: z.boolean() });

/**
 * Producer "Open the room / Go live" control. Sets the webinar's anchor
 * EventSession.status to LIVE (open) or COMPLETED (close). The anchor session's
 * status is the single source of truth the public waiting room polls
 * (`lobby-status`) and the join gate checks — opening the room is what admits
 * waiting attendees into the live view. Re-openable (sets LIVE again).
 */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([auth(), params, req.json()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `webinar-room:${eventId}`,
      limit: 60,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ eventId, userId: session.user.id }, "webinar:room-rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const validated = roomSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ errors: validated.error.flatten() }, "webinar:room-validation-failed");
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 },
      );
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true, settings: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const webinar = readWebinarSettings(event.settings);
    if (!webinar?.sessionId) {
      apiLogger.warn({ eventId }, "webinar:room-no-anchor-session");
      return NextResponse.json(
        { error: "This event has no webinar session to open. Re-run the provisioner first." },
        { status: 400 },
      );
    }

    const nextStatus = validated.data.open ? "LIVE" : "COMPLETED";

    // Scope the update by eventId too so it can't touch another event's session.
    const updated = await db.eventSession.updateMany({
      where: { id: webinar.sessionId, eventId },
      data: { status: nextStatus },
    });
    if (updated.count === 0) {
      return NextResponse.json({ error: "Webinar session not found" }, { status: 404 });
    }

    apiLogger.info(
      { eventId, sessionId: webinar.sessionId, userId: session.user.id, status: nextStatus },
      validated.data.open ? "webinar:room-opened" : "webinar:room-closed",
    );

    return NextResponse.json({
      open: validated.data.open,
      sessionId: webinar.sessionId,
      status: nextStatus,
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar:room-toggle-failed");
    return NextResponse.json({ error: "Failed to update the webinar room" }, { status: 500 });
  }
}
