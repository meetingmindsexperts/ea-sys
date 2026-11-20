import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { can } from "@/lib/permissions/can";
import { requireOrgId } from "@/lib/require-org";
import { findGatedEvent } from "@/lib/tenant/event-tenant";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { eventFactsOf } from "@/lib/permissions/event-facts";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { makePresenters } from "@/services/presenter-service";
import { MAX_BULK_REGISTRATION_UPDATES } from "@/services/registration-bulk-service";

/**
 * Make the authors of ACCEPTED abstracts presenters: their registration
 * Complimentary, with a Presenter badge (Nov 20, 2026; plan step 4).
 *
 *   POST { abstractIds }
 *
 * The Abstracts page calls it when the organiser ticks the box while
 * accepting. It changes REGISTRATIONS, so it asks the key of the bulk action
 * it runs (`registrations.bulk`), and `abstracts.read` to name abstracts at
 * all. Only accepted abstracts' authors are touched; the rules are the bulk
 * action's (presenter-service.ts → registration-bulk-service.ts).
 */
interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export const maxDuration = 60;

const RATE_LIMIT = 60;
const RATE_WINDOW_SECONDS = 3600;
const ROUTE = "events/[eventId]/abstracts/make-presenters:POST";

const bodySchema = z.object({ abstractIds: z.array(z.string().min(1).max(100)).min(1).max(MAX_BULK_REGISTRATION_UPDATES) }).strict();

const HTTP_STATUS = { NOTHING_TO_CHANGE: 400, TOO_MANY: 400, UNKNOWN: 500 } as const;

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([auth(), params, req.json().catch(() => null)]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: ROUTE });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "registrations.bulk", { route: ROUTE, eventId });
    if (!gate.ok) return gate.response;
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "abstracts/make-presenters:zod-validation-failed", eventId, userId: session.user.id, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const event = await findGatedEvent(gate, { select: { id: true, organizationId: true, eventType: true, staffAssignments: { select: { userId: true } } } });
      if (!event) {
        apiLogger.warn({ msg: "abstracts/make-presenters:event-not-found", eventId, userId: session.user.id });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      // Judged on THIS event: a grant scoped to webinars says nothing about a conference's abstracts.
      const eventFacts = eventFactsOf({ ...event, staffUserIds: event.staffAssignments.map((a) => a.userId) });
      if (!eventFacts || !can(gate.principal, "abstracts.read", { event: eventFacts })) {
        apiLogger.warn({ msg: "abstracts/make-presenters:abstracts-not-readable", eventId, userId: session.user.id });
        return NextResponse.json({ error: "You cannot see abstracts on this event", code: "ABSTRACTS_NOT_READABLE" }, { status: 403 });
      }

      // The same budget as the bulk action it runs.
      const rl = checkRateLimit({ key: `registration-bulk-update:${session.user.id}`, limit: RATE_LIMIT, windowMs: RATE_WINDOW_SECONDS * 1000 });
      if (!rl.allowed) {
        apiLogger.warn({ msg: "abstracts/make-presenters:rate-limited", eventId, userId: session.user.id, retryAfterSeconds: rl.retryAfterSeconds });
        return NextResponse.json(
          { error: "Too many bulk changes. Try again later.", code: "RATE_LIMITED", retryAfterSeconds: rl.retryAfterSeconds, limit: RATE_LIMIT, windowSeconds: RATE_WINDOW_SECONDS },
          { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
        );
      }

      const result = await makePresenters({
        eventId,
        organizationId: orgGuard.orgId,
        actorUserId: session.user.id,
        abstractIds: parsed.data.abstractIds,
        source: "rest",
        requestIp: getClientIp(req),
      });
      if (!result.ok) {
        apiLogger.warn({ msg: "abstracts/make-presenters:rejected", eventId, userId: session.user.id, code: result.code });
        return NextResponse.json({ error: result.message, code: result.code }, { status: HTTP_STATUS[result.code] ?? 500 });
      }
      return NextResponse.json(result);
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "abstracts/make-presenters:failed" });
    return NextResponse.json({ error: "Failed to change the registrations" }, { status: 500 });
  }
}
