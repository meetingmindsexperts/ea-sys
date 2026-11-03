import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { listUnusedDtcmOrders } from "@/services/dtcm-eticket-service";

/**
 * The event's bought DET tickets that nobody is using (docs/DTCM_ETICKET_PLAN.md
 * §6, step 5): held by a cancelled or deleted registration, or whose barcode is
 * not the one on the registration. The organiser reverses each by hand
 * (PATCH dtcm-orders/[orderId] { action: "reverse" }); nothing reverses on its
 * own, because a printed badge can still be in someone's pocket.
 *
 * `dtcm.import` (ADMIN and ORGANIZER). Returns DET order numbers and names,
 * never a barcode.
 */
interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!session.user.organizationId) {
      apiLogger.warn({ msg: "dtcm-eticket:unused-no-org", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const gate = requirePermission(session, "dtcm.import", { route: "events/[eventId]/dtcm-orders:GET", eventId });
    if (!gate.ok) return gate.response;

    return await runWithTenantLane(session.user.organizationId, { route: "events:dtcm-orders:GET", userId: session.user.id }, async () => {
      const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true } });
      if (!event) {
        apiLogger.warn({ msg: "dtcm-eticket:unused-event-not-found", eventId, userId: session.user.id });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      return NextResponse.json({ unused: await listUnusedDtcmOrders(eventId) });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "dtcm-eticket:unused-failed" });
    return NextResponse.json({ error: "Failed to list unused DET tickets" }, { status: 500 });
  }
}
