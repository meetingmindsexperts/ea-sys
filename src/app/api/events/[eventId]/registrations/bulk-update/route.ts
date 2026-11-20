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
import {
  BULK_PAYMENT_STATUSES,
  bulkUpdateRegistrations,
  MAX_BULK_REGISTRATION_UPDATES,
} from "@/services/registration-bulk-service";

/**
 * Set the payment status, set the badge type, or cancel, on many registrations
 * (Nov 20, 2026; docs/ABSTRACT_AUTHOR_REGISTRATION_PLAN.md step 3).
 *
 *   POST { registrationIds, paymentStatus?, badgeType?, cancel? }
 *
 * The Registrations page sends its ticked rows. `registrations.bulk` opens it,
 * as it opens the bulk type change. What it then does needs the key of the
 * single action it repeats, judged on this event: `registrations.update` for
 * a payment status or a badge type, `registrations.cancel` for a cancel. Each row's change is the single
 * registration's own code (registration-bulk-service.ts); a row with money on
 * it is never given a new payment status or cancelled here, and comes back in
 * `skipped` with its reason.
 *
 * One request works for about 25 seconds and answers `remaining`, the ids it
 * did not reach; the page sends those again (nginx cuts a response at 60).
 */
interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export const maxDuration = 60;

/** Requests, not registrations: a long change is several requests. */
const RATE_LIMIT = 60;
const RATE_WINDOW_SECONDS = 3600;
const ROUTE = "events/[eventId]/registrations/bulk-update:POST";

const bodySchema = z
  .object({
    registrationIds: z.array(z.string().min(1).max(100)).min(1).max(MAX_BULK_REGISTRATION_UPDATES),
    paymentStatus: z.enum(BULK_PAYMENT_STATUSES).optional(),
    /** A badge type, or an empty string to clear it. */
    // The registration's own page allows 50.
    badgeType: z.string().trim().max(50).optional(),
    cancel: z.literal(true).optional(),
  })
  .strict()
  .refine((body) => body.paymentStatus !== undefined || body.badgeType !== undefined || body.cancel === true, {
    message: "Choose what to change",
    path: ["paymentStatus"],
  })
  // A cancel is its own action: a payment status or a badge on a row being cancelled means nothing.
  .refine((body) => !(body.cancel && (body.paymentStatus !== undefined || body.badgeType !== undefined)), {
    message: "Cancel cannot be combined with another change",
    path: ["cancel"],
  });

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
      apiLogger.warn({ msg: "registrations/bulk-update:zod-validation-failed", eventId, userId: session.user.id, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    const { registrationIds, paymentStatus, badgeType, cancel } = parsed.data;

    return await runWithTenant(orgGuard.orgId, async () => {
      // The event must be one the grant reaches: the service checks only the event id.
      const event = await findGatedEvent(gate, { select: { id: true, organizationId: true, eventType: true, staffAssignments: { select: { userId: true } } } });
      if (!event) {
        apiLogger.warn({ msg: "registrations/bulk-update:event-not-found", eventId, userId: session.user.id });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      // Cancelling many is the Cancel button many times: it needs that button's
      // key too, judged on THIS event (a grant scoped to webinars does not
      // reach a conference).
      const eventFacts = eventFactsOf({ ...event, staffUserIds: (event.staffAssignments ?? []).map((a) => a.userId) });
      if (cancel && (!eventFacts || !can(gate.principal, "registrations.cancel", { event: eventFacts }))) {
        apiLogger.warn({ msg: "registrations/bulk-update:cancel-not-permitted", eventId, userId: session.user.id });
        return NextResponse.json({ error: "You cannot cancel registrations on this event", code: "CANCEL_NOT_PERMITTED" }, { status: 403 });
      }
      // A payment status or a badge type is the registration's own edit, many
      // times: it needs that edit's key too. "Bulk changes" alone was for tags
      // and the type (review of 345400df).
      if (!cancel && (!eventFacts || !can(gate.principal, "registrations.update", { event: eventFacts }))) {
        apiLogger.warn({ msg: "registrations/bulk-update:update-not-permitted", eventId, userId: session.user.id });
        return NextResponse.json({ error: "You cannot edit registrations on this event", code: "UPDATE_NOT_PERMITTED" }, { status: 403 });
      }

      const rl = checkRateLimit({ key: `registration-bulk-update:${session.user.id}`, limit: RATE_LIMIT, windowMs: RATE_WINDOW_SECONDS * 1000 });
      if (!rl.allowed) {
        apiLogger.warn({ msg: "registrations/bulk-update:rate-limited", eventId, userId: session.user.id, retryAfterSeconds: rl.retryAfterSeconds });
        return NextResponse.json(
          { error: "Too many bulk changes. Try again later.", code: "RATE_LIMITED", retryAfterSeconds: rl.retryAfterSeconds, limit: RATE_LIMIT, windowSeconds: RATE_WINDOW_SECONDS },
          { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
        );
      }

      const result = await bulkUpdateRegistrations({
        eventId,
        organizationId: orgGuard.orgId,
        actorUserId: session.user.id,
        registrationIds,
        paymentStatus,
        badgeType,
        cancel: cancel === true,
        source: "rest",
        requestIp: getClientIp(req),
      });
      // The service has logged the refusal with its code.
      if (!result.ok) {
        return NextResponse.json({ error: result.message, code: result.code }, { status: HTTP_STATUS[result.code] ?? 500 });
      }
      return NextResponse.json(result);
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "registrations/bulk-update:failed" });
    return NextResponse.json({ error: "Failed to update the registrations" }, { status: 500 });
  }
}
