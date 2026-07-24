import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { readWebinarSettings } from "@/lib/webinar";

type RouteParams = { params: Promise<{ eventId: string }> };

// "Present right now" = a heartbeat within the last minute.
const PRESENT_WINDOW_MS = 60_000;

/**
 * Real-time lobby/live presence for the Webinar Console "Live now" card.
 * Returns registrants currently on the webinar page (heartbeat in the last
 * 60s), split lobby vs joined. This is OUR-page presence, distinct from the
 * authoritative post-event ZoomAttendance. Auth + org-scope (read-only,
 * matches the attendance GET guard — no denyReviewer on GET).
 */
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: orgGuard.orgId },
      select: { id: true, settings: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const webinar = readWebinarSettings(event.settings);
    const anchorSessionId = webinar?.sessionId;
    if (!anchorSessionId) {
      // No webinar session yet — return an empty roster rather than an error so
      // the card renders a clean empty state.
      return NextResponse.json({ lobby: 0, joined: 0, total: 0, rows: [] });
    }

    const cutoff = new Date(Date.now() - PRESENT_WINDOW_MS);
    const rows = await db.webinarPresence.findMany({
      where: { sessionId: anchorSessionId, lastSeenAt: { gte: cutoff } },
      select: {
        id: true,
        phase: true,
        firstJoinedAt: true,
        lastSeenAt: true,
        joinCount: true,
        registration: {
          select: {
            serialId: true,
            attendee: { select: { firstName: true, lastName: true, email: true } },
          },
        },
      },
      orderBy: { lastSeenAt: "desc" },
      take: 1000,
    });

    const mapped = rows.map((r) => ({
      id: r.id,
      phase: r.phase,
      name: `${r.registration.attendee?.firstName ?? ""} ${r.registration.attendee?.lastName ?? ""}`.trim() || "Attendee",
      email: r.registration.attendee?.email ?? null,
      serialId: r.registration.serialId,
      firstJoinedAt: r.firstJoinedAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      joinCount: r.joinCount,
    }));

    const joined = mapped.filter((r) => r.phase === "joined").length;
    const lobby = mapped.length - joined;

    return NextResponse.json({ lobby, joined, total: mapped.length, rows: mapped });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar:presence-fetch-failed");
    return NextResponse.json({ error: "Failed to load presence" }, { status: 500 });
  }
}
