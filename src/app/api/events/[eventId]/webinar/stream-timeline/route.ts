import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { runWithTenant } from "@/lib/tenant-context";
import { readWebinarSettings } from "@/lib/webinar";
import { listStreamEvents } from "@/lib/webinar/stream-timeline";

type RouteParams = { params: Promise<{ eventId: string }> };

/**
 * The webinar console's Stream timeline (Nov 5, 2026): the room opened or
 * closed, Start or Stop stream pressed, the stream seen live or dropped, and
 * the watchdog's automatic restarts, newest first. Same read key as the
 * console itself. See src/lib/webinar/stream-timeline.ts.
 */
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/webinar/stream-timeline:GET" });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.analytics.read", {
      route: "events/[eventId]/webinar/stream-timeline:GET",
      eventId,
      onMissing: "hide",
    });
    if (!gate.ok) return gate.response;

    return await runWithTenant(orgGuard.orgId, async () => {
      const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true, settings: true } });
      if (!event) {
        apiLogger.warn({ eventId, userId: session.user.id }, "webinar-stream-timeline:event-not-found");
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      const sessionId = readWebinarSettings(event.settings)?.sessionId;
      if (!sessionId) return NextResponse.json({ entries: [] });
      const entries = await listStreamEvents(event.id, sessionId);
      return NextResponse.json({ entries }, { headers: { "Cache-Control": "private, no-store" } });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-stream-timeline:failed");
    return NextResponse.json({ error: "Failed to load the stream timeline" }, { status: 500 });
  }
}
