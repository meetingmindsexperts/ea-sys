/**
 * DELETE a webinar handout (Oct 6, 2026): removed from the list under the row
 * lock first, then the file is deleted. A failed file delete only leaves an
 * orphan in the private prefix, which is logged.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requireOrgId } from "@/lib/require-org";
import { requirePermission } from "@/lib/permissions/require-permission";
import { runWithTenant } from "@/lib/tenant-context";
import { deleteStoredFile } from "@/lib/storage";
import { UPLOAD_PREFIX } from "@/lib/upload-prefixes";
import type { WebinarHandout } from "@/lib/webinar/handouts";
import { updateHandouts } from "@/lib/webinar/handouts-store";

type RouteParams = { params: Promise<{ eventId: string; handoutId: string }> };

export async function DELETE(_req: Request, { params }: RouteParams) {
  const ROUTE = "events/[eventId]/webinar/handouts/[handoutId]:DELETE";
  try {
    const [session, { eventId, handoutId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      apiLogger.warn({ eventId, handoutId }, "webinar-handouts:unauthorized");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: ROUTE });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.manage", { route: ROUTE, eventId });
    if (!gate.ok) return gate.response;

    return await runWithTenant(orgGuard.orgId, async () => {
      const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true } });
      if (!event) {
        apiLogger.warn({ eventId, userId: session.user.id }, "webinar-handouts:event-not-found");
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      let removed: WebinarHandout | undefined;
      const result = await updateHandouts(event.id, (current) => {
        removed = current.find((h) => h.id === handoutId);
        return removed ? current.filter((h) => h.id !== handoutId) : "not-found";
      });
      if (!result.ok || !removed) {
        apiLogger.warn({ eventId, handoutId, reason: result.ok ? "not-found" : result.reason }, "webinar-handouts:delete-not-found");
        return NextResponse.json({ error: "Handout not found" }, { status: 404 });
      }
      try {
        await deleteStoredFile(removed.storedPath, UPLOAD_PREFIX.webinarHandouts);
      } catch (err) {
        apiLogger.error({ err, eventId, handoutId, storedPath: removed.storedPath }, "webinar-handouts:file-delete-failed");
      }
      apiLogger.info({ eventId, handoutId, userId: session.user.id }, "webinar-handouts:deleted");
      return NextResponse.json({ handouts: result.handouts });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-handouts:delete-failed");
    return NextResponse.json({ error: "Failed to delete the handout" }, { status: 500 });
  }
}
