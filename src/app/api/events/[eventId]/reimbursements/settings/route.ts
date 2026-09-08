/**
 * Event-level reimbursement settings: which claim types the event offers.
 *
 *   GET → { claimItems: ClaimItemKey[] }          (absent = all five)
 *   PUT { claimItems: ClaimItemKey[] } → saves it  (at least one)
 *
 * Stored in `Event.settings.reimbursement.claimItems` (no migration); a
 * speaker's own `reimbursementClaimItems` overrides it per person. The public
 * form renders only the allowed types and the public POST refuses any other
 * kind, so this is a real control, not a display preference.
 *
 * ACCESS: the reimbursement boundary, `denyReviewer(session)` with NO
 * allow-list (SUPER_ADMIN / ADMIN / ORGANIZER), like the honorarium route and
 * deliberately NOT the event PUT, which admits WEBINARS on webinar events.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { rateLimited, zodErrorResponse } from "@/lib/api-errors";
import { updateEventSettings } from "@/lib/event-settings";
import { claimItemsInputSchema, readEventClaimItems } from "@/lib/reimbursement/constants";

type RouteParams = { params: Promise<{ eventId: string }> };

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session, { route: "events/[eventId]/reimbursements/settings:GET" });
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true, settings: true },
    });
    if (!event) {
      apiLogger.warn({ eventId, userId: session.user.id }, "reimbursement-settings:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    // Event carries no RLS policy, so nothing here needs the lane; the wrap
    // keeps this swept domain's every-handler invariant honest.
    return await runWithTenant(event.organizationId, async () =>
      NextResponse.json({ claimItems: readEventClaimItems(event.settings) }),
    );
  } catch (err) {
    apiLogger.error({ err }, "reimbursement-settings:get-failed");
    return NextResponse.json({ error: "Failed to load reimbursement settings" }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  const route = "events/[eventId]/reimbursements/settings:PUT";
  try {
    const [session, { eventId }, body] = await Promise.all([auth(), params, req.json().catch(() => null)]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session, { route: "events/[eventId]/reimbursements/settings:PUT" });
    if (denied) return denied;

    const rl = checkRateLimit({ key: `reimbursement-settings:${session.user.id}`, limit: 60, windowMs: 3600_000 });
    if (!rl.allowed) {
      return rateLimited(rl, { route, eventId, userId: session.user.id, limit: 60, windowSeconds: 3600 });
    }

    const parsed = claimItemsInputSchema.safeParse(body);
    if (!parsed.success) {
      return zodErrorResponse(parsed, { route, eventId, userId: session.user.id });
    }

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true, settings: true },
    });
    if (!event) {
      apiLogger.warn({ eventId, userId: session.user.id }, "reimbursement-settings:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const before = readEventClaimItems(event.settings);
    const after = parsed.data.claimItems;
    const ip = getClientIp(req);
    return await runWithTenant(event.organizationId, async () => {
      // Atomic merge under the row lock: only the `reimbursement` sub-key
      // changes, and only its `claimItems` field inside it.
      await updateEventSettings(eventId, (cur) => ({
        ...cur,
        reimbursement: { ...((cur.reimbursement as Record<string, unknown> | undefined) ?? {}), claimItems: after },
      }));

      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "REIMBURSEMENT_SETTINGS_SET",
            entityType: "Event",
            entityId: eventId,
            changes: { source: "rest", before: { claimItems: before }, after: { claimItems: after }, ip },
            ipAddress: ip,
          },
        })
        .catch((err) => apiLogger.error({ err, eventId }, "reimbursement-settings:audit-failed"));

      apiLogger.info({ eventId, userId: session.user.id, before, after }, "reimbursement-settings:set");
      return NextResponse.json({ claimItems: after });
    });
  } catch (err) {
    apiLogger.error({ err }, "reimbursement-settings:put-failed");
    return NextResponse.json({ error: "Failed to save reimbursement settings" }, { status: 500 });
  }
}
