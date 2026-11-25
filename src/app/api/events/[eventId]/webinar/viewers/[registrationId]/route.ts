import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { findGatedEvent } from "@/lib/tenant/event-tenant";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { runWithTenant } from "@/lib/tenant-context";
import { equalsIgnoringCase } from "@/lib/like-escape";

/**
 * Remove a viewer from this webinar, or let them back (Nov 25, 2026; owner: "remove someone from
 * viewing the session if they misbehave", decided as "block this webinar only").
 *
 *   PUT /api/events/{eventId}/webinar/viewers/{registrationId}   { removed: boolean }
 *
 * Sets or clears `Registration.webinarRemovedAt`. Nothing else about the registration changes
 * (status, payment, seats, certificates). While it is set the viewer rule
 * (src/lib/webinar/viewer-entitlement.ts) lets the person into nothing on this webinar, and their
 * page is told on its next heartbeat (about 30 s) and stops the player. The video stream itself is
 * not checked per viewer, so a copied stream address keeps playing: the page is what stops.
 *
 * `webinar.manage`, the key of the console's room and stream controls. Audited.
 */
type RouteParams = { params: Promise<{ eventId: string; registrationId: string }> };

const bodySchema = z.object({ removed: z.boolean() }).strict();

const ROUTE = "events/[eventId]/webinar/viewers/[registrationId]:PUT";
const RATE_LIMIT = 120;
const RATE_WINDOW_S = 3600;

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, registrationId }, body] = await Promise.all([auth(), params, req.json().catch(() => null)]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const orgGuard = requireOrgId(session, { route: ROUTE });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.manage", { route: ROUTE, eventId });
    if (!gate.ok) return gate.response;

    const rl = checkRateLimit({ key: `webinar-viewer-removal:${session.user.id}`, limit: RATE_LIMIT, windowMs: RATE_WINDOW_S * 1000 });
    if (!rl.allowed) {
      return rateLimited(rl, { route: ROUTE, userId: session.user.id, eventId, limit: RATE_LIMIT, windowSeconds: RATE_WINDOW_S });
    }

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ eventId, userId: session.user.id, errors: parsed.error.flatten() }, "webinar-viewer:removal-validation-failed");
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    const { removed } = parsed.data;
    const userId = session.user.id;

    return await runWithTenant(orgGuard.orgId, async () => {
      const event = await findGatedEvent(gate, { select: { id: true, eventType: true } });
      if (!event) {
        apiLogger.warn({ eventId, userId }, "webinar-viewer:removal-event-not-found");
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      if (event.eventType !== "WEBINAR") {
        apiLogger.warn({ eventId, userId }, "webinar-viewer:removal-not-a-webinar");
        return NextResponse.json({ error: "Only a webinar's viewers can be removed.", code: "NOT_A_WEBINAR" }, { status: 409 });
      }

      // Bound to THIS event: a registration id from another event is not found, never touched.
      const target = await db.registration.findFirst({
        where: { id: registrationId, eventId: event.id },
        select: { userId: true, attendee: { select: { email: true } } },
      });
      if (!target) {
        apiLogger.warn({ eventId, userId, registrationId }, "webinar-viewer:removal-registration-not-found");
        return NextResponse.json({ error: "Registration not found" }, { status: 404 });
      }
      // The PERSON, not one row (review of eeebe2b2b): the viewer rule admits them through any
      // registration in their account or unheld on their address, so every such row on this event
      // is stamped, or a second registration would let them straight back in.
      const email = target.attendee?.email?.trim();
      const now = new Date();
      const updated = await db.registration.updateMany({
        where: {
          eventId: event.id,
          OR: [
            { id: registrationId },
            ...(target.userId ? [{ userId: target.userId }] : []),
            ...(email ? [{ userId: null, attendee: { email: equalsIgnoringCase(email) } }] : []),
          ],
        },
        data: removed ? { webinarRemovedAt: now, webinarRemovedById: userId } : { webinarRemovedAt: null, webinarRemovedById: null },
      });

      db.auditLog
        .create({
          data: {
            organizationId: orgGuard.orgId,
            eventId: event.id,
            userId,
            action: removed ? "WEBINAR_VIEWER_REMOVED" : "WEBINAR_VIEWER_RESTORED",
            entityType: "Registration",
            entityId: registrationId,
            changes: { removed, registrations: updated.count, source: "rest" },
          },
        })
        .catch((err: unknown) => apiLogger.error({ err, eventId, registrationId }, "webinar-viewer:removal-audit-failed"));

      apiLogger.info({ eventId, userId, registrationId, removed, registrations: updated.count }, removed ? "webinar-viewer:removed" : "webinar-viewer:restored");
      return NextResponse.json({ registrationId, removed, removedAt: removed ? now.toISOString() : null });
    });
  } catch (err) {
    apiLogger.error({ err }, "webinar-viewer:removal-failed");
    return NextResponse.json({ error: "Failed to change the viewer" }, { status: 500 });
  }
}
