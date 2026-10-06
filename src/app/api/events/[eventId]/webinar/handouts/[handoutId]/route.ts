/**
 * GET opens a handout for staff checking a file they added (review of
 * handouts: WEBINARS producers could upload but not open one). Same reader as
 * the attendee download.
 *
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
import { readHandouts, type WebinarHandout } from "@/lib/webinar/handouts";
import { handoutDownloadResponse, handoutFolder } from "@/lib/webinar/handout-download";
import { readWebinarSettings } from "@/lib/webinar";
import { updateHandouts } from "@/lib/webinar/handouts-store";

type RouteParams = { params: Promise<{ eventId: string; handoutId: string }> };

export async function GET(_req: Request, { params }: RouteParams) {
  const ROUTE = "events/[eventId]/webinar/handouts/[handoutId]:GET";
  try {
    const [session, { eventId, handoutId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      apiLogger.warn({ eventId, handoutId }, "webinar-handouts:unauthorized");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: ROUTE });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.analytics.read", { route: ROUTE, eventId, onMissing: "hide" });
    if (!gate.ok) return gate.response;

    return await runWithTenant(orgGuard.orgId, async () => {
      const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true, settings: true } });
      if (!event) {
        apiLogger.warn({ eventId, userId: session.user.id }, "webinar-handouts:event-not-found");
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      const handout = readHandouts(readWebinarSettings(event.settings)).find((h) => h.id === handoutId);
      return handoutDownloadResponse(event.id, handout, { handoutId, userId: session.user.id, staff: true });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-handouts:staff-open-failed");
    return NextResponse.json({ error: "Failed to open the handout" }, { status: 500 });
  }
}

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
        // This event's own folder only: an entry can never delete another
        // event's file (review of handouts).
        await deleteStoredFile(removed.storedPath, handoutFolder(event.id));
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
