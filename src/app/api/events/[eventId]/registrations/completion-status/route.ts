import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { runWithTenant } from "@/lib/tenant-context";

/**
 * GET /api/events/[eventId]/registrations/completion-status?ids=a,b,c
 *
 * The desk's "Waiting to complete" poll (docs/ONSITE_DESK_PLAN.md §5.1): for
 * each id, whether their form is in and their status, nothing else. It
 * replaced one full detail read per waiting person every 4 seconds (review of
 * cf9775fd, MED 5). Ids not on this event are simply absent, so the desk drops
 * them.
 */

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const ROUTE = "events/[eventId]/registrations/completion-status:GET";
const MAX_IDS = 50;

export async function GET(req: Request, { params }: RouteParams) {
  const { eventId } = await params;
  try {
    const session = await auth();
    if (!session?.user) {
      apiLogger.warn({ msg: "completion-status:unauthenticated", eventId });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: ROUTE, eventId });
    if ("error" in orgGuard) return orgGuard.error;

    const gate = requirePermission(session, "registrations.read", { route: ROUTE, eventId });
    if (!gate.ok) return gate.response;

    const ids = (new URL(req.url).searchParams.get("ids") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    if (ids.length === 0 || ids.length > MAX_IDS) {
      apiLogger.warn({ msg: "completion-status:bad-ids", eventId, count: ids.length, userId: session.user.id });
      return NextResponse.json({ error: `Pass 1 to ${MAX_IDS} ids`, code: "INVALID_IDS" }, { status: 400 });
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true } });
      if (!event) {
        apiLogger.warn({ msg: "completion-status:event-not-found", eventId, userId: session.user.id });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      const rows = await db.registration.findMany({
        where: { id: { in: ids }, eventId },
        select: { id: true, status: true, completedAt: true, userId: true },
      });
      return NextResponse.json({
        // An account counts as completed, as everywhere else (registration-completion.ts).
        statuses: rows.map((r) => ({ id: r.id, status: r.status, completed: !!(r.completedAt || r.userId) })),
      });
    });
  } catch (err) {
    apiLogger.error({ err, msg: "completion-status:failed", eventId });
    return NextResponse.json({ error: "Failed to read the status" }, { status: 500 });
  }
}
