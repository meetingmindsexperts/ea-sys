import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { runWithTenant } from "@/lib/tenant-context";
import { storeSupportingDocument } from "@/lib/supporting-document-upload";

/**
 * POST /api/events/[eventId]/registrations/walk-in/document
 *
 * The onsite desk's supporting-document upload for a walk-in
 * (docs/ONSITE_DESK_PLAN.md §4). The desk used the public form's route, which
 * allows 10 uploads an hour per IP and only on a published event: every desk
 * tablet behind the venue's network shares one IP with the attendees on the
 * venue Wi-Fi, so the eleventh resident walk-in in an hour could not be
 * registered (review of 26c17807, MED 4). This one is staff-only, limited per
 * person, and runs the same checks and storage (`storeSupportingDocument`), so
 * the walk-in route's `resolveSupportingDocument` accepts what it returns.
 */

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const ROUTE = "events/[eventId]/registrations/walk-in/document:POST";

export async function POST(req: Request, { params }: RouteParams) {
  const [{ eventId }, session] = await Promise.all([params, auth()]);
  try {
    if (!session?.user) {
      apiLogger.warn({ msg: "walk-in-document:unauthenticated", eventId });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: ROUTE, eventId });
    if ("error" in orgGuard) return orgGuard.error;

    const gate = requirePermission(session, "registrations.create", { route: ROUTE, eventId });
    if (!gate.ok) return gate.response;

    const rateLimit = checkRateLimit({ key: `walk-in-document:${session.user.id}`, limit: 120, windowMs: 60 * 60 * 1000 });
    if (!rateLimit.allowed) {
      return rateLimited(rateLimit, { route: ROUTE, userId: session.user.id, eventId, limit: 120, windowSeconds: 3600 });
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      // Resolve the event BEFORE reading the body: a wrong event costs a
      // lookup, not 5MB of buffering.
      const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true } });
      if (!event) {
        apiLogger.warn({ msg: "walk-in-document:event-not-found", eventId, userId: session.user.id });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }

      const formData = await req.formData();
      const stored = await storeSupportingDocument(formData.get("file") as File | null, event.id);
      if (!stored.ok) {
        apiLogger.warn({ msg: "walk-in-document:rejected", eventId, code: stored.code, claimedType: stored.claimedType, size: stored.size, userId: session.user.id });
        return NextResponse.json({ error: stored.error, code: stored.code }, { status: 400 });
      }

      apiLogger.info({ msg: "walk-in-document:uploaded", eventId, size: stored.size, mimeType: stored.mimeType, userId: session.user.id });
      return NextResponse.json({ url: stored.url, filename: stored.filename }, { status: 201 });
    });
  } catch (err) {
    apiLogger.error({ err, msg: "walk-in-document:failed", eventId, userId: session?.user?.id });
    return NextResponse.json({ error: "Failed to upload the document" }, { status: 500 });
  }
}
