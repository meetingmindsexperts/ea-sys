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
import { makeRegistrationFaculty, type MakeFacultyErrorCode } from "@/services/make-faculty-service";

/**
 * "Make Faculty": move a speaker's registration onto the event's Faculty type
 * (Nov 20, 2026; docs/ABSTRACT_AUTHOR_REGISTRATION_PLAN.md step 6).
 *
 *   POST { preview?: true, confirmWaive?: number }
 *
 * `preview` answers what would happen (the fee no longer owed, the invoices
 * cancelled, the badge) and changes nothing. Without it the move is made;
 * where something is owed it is refused with `CONFIRM_WAIVE` and the plan
 * until the caller sends back the amount it was shown.
 *
 * It gives a free Faculty registration, so it needs the key that gives a
 * speaker one (`speakers.companion.grant`), and it is an edit of the
 * registration, so it needs `registrations.update` on this event too. The
 * desk holds the second and not the first. Where a fee is owed it also needs
 * `finance.view` (the amount is shown and waived), and where an invoice is
 * open, `invoices.write` on the event (it is cancelled): without them such a
 * registration is refused with `NEEDS_FINANCE` and no figure. The rules
 * themselves are the service's (make-faculty-service.ts).
 */
interface RouteParams {
  params: Promise<{ eventId: string; registrationId: string }>;
}

const ROUTE = "events/[eventId]/registrations/[registrationId]/make-faculty:POST";
const RATE_LIMIT = 120;
const RATE_WINDOW_SECONDS = 3600;

const bodySchema = z
  .object({
    preview: z.literal(true).optional(),
    confirmWaive: z.number().finite().min(0).max(10_000_000).optional(),
  })
  .strict();

const HTTP_STATUS: Record<MakeFacultyErrorCode, number> = {
  REGISTRATION_NOT_FOUND: 404,
  CANCELLED: 409,
  ALREADY_FACULTY: 409,
  NO_SPEAKER: 409,
  SPEAKER_HAS_OTHER_REGISTRATION: 409,
  HAS_PAYMENT: 409,
  PAYMENT_PENDING: 409,
  NEEDS_FINANCE: 403,
  SPONSOR_PAID: 409,
  GROUP_MEMBER: 409,
  CHECKOUT_OPEN: 409,
  CONFIRM_WAIVE: 409,
  STALE_WRITE: 409,
  UNKNOWN: 500,
};

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, registrationId }, body] = await Promise.all([auth(), params, req.json().catch(() => ({}))]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: ROUTE });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "speakers.companion.grant", { route: ROUTE, eventId });
    if (!gate.ok) return gate.response;

    const parsed = bodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      apiLogger.warn({ msg: "registrations/make-faculty:zod-validation-failed", eventId, registrationId, userId: session.user.id, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      // The event must be one the grant reaches: the service checks only the event id.
      const event = await findGatedEvent(gate, { select: { id: true, organizationId: true, eventType: true, staffAssignments: { select: { userId: true } } } });
      if (!event) {
        apiLogger.warn({ msg: "registrations/make-faculty:event-not-found", eventId, userId: session.user.id });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      // It changes the registration's type and payment status: the edit's own key, on THIS event.
      const eventFacts = eventFactsOf({ ...event, staffUserIds: (event.staffAssignments ?? []).map((a) => a.userId) });
      if (!eventFacts || !can(gate.principal, "registrations.update", { event: eventFacts })) {
        apiLogger.warn({ msg: "registrations/make-faculty:update-not-permitted", eventId, registrationId, userId: session.user.id });
        return NextResponse.json({ error: "You cannot edit registrations on this event", code: "UPDATE_NOT_PERMITTED" }, { status: 403 });
      }

      const rl = checkRateLimit({ key: `make-faculty:${session.user.id}`, limit: RATE_LIMIT, windowMs: RATE_WINDOW_SECONDS * 1000 });
      if (!rl.allowed) {
        apiLogger.warn({ msg: "registrations/make-faculty:rate-limited", eventId, userId: session.user.id, retryAfterSeconds: rl.retryAfterSeconds });
        return NextResponse.json(
          { error: "Too many requests. Try again later.", code: "RATE_LIMITED", retryAfterSeconds: rl.retryAfterSeconds, limit: RATE_LIMIT, windowSeconds: RATE_WINDOW_SECONDS },
          { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
        );
      }

      const result = await makeRegistrationFaculty({
        eventId,
        organizationId: orgGuard.orgId,
        actorUserId: session.user.id,
        registrationId,
        preview: parsed.data.preview === true,
        confirmWaive: parsed.data.confirmWaive,
        // A fee owed is named and waived, and an open invoice cancelled: each needs the key
        // every other door to that asks (custom roles can hold the two above without them).
        maySeeAmounts: can(gate.principal, "finance.view"),
        mayCancelInvoices: can(gate.principal, "invoices.write", { event: eventFacts }),
        source: "rest",
        requestIp: getClientIp(req),
      });
      // The service has logged the refusal with its code.
      if (!result.ok) {
        return NextResponse.json({ error: result.message, code: result.code, ...(result.plan && { plan: result.plan }) }, { status: HTTP_STATUS[result.code] ?? 500 });
      }
      return NextResponse.json(result);
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "registrations/make-faculty:failed" });
    return NextResponse.json({ error: "Failed to make the registration Faculty" }, { status: 500 });
  }
}
