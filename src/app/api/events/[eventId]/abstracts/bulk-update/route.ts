import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { findGatedEvent } from "@/lib/tenant/event-tenant";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { BUILT_IN_PRESENTATION_TYPE_KEYS } from "@/lib/abstract-presentation-types";
import {
  ABSTRACT_TRANSITION_STATUSES,
  bulkUpdateAbstracts,
  MAX_BULK_ABSTRACT_UPDATES,
  type BulkUpdateAbstractsErrorCode,
} from "@/services/abstract-service";

/**
 * Set a status, a presentation type, or both, on many abstracts (Nov 19, 2026).
 *
 *   POST { abstractIds, status?, presentationType?, notifyAuthors?, forceStatus? }
 *
 * The Abstracts page sends its ticked rows. Same key as changing one abstract
 * (`abstracts.update`, which there also carries the review-count override),
 * and the same rules: every status change is the single change's own code
 * (bulkUpdateAbstracts → changeAbstractStatus), so an abstract short of
 * reviews, or withdrawn, is refused here exactly as it is there and comes back
 * in `skipped` with its reason.
 *
 * Authors are emailed only with `notifyAuthors: true`.
 *
 * One request works for about 25 seconds and answers `remaining`, the ids it
 * did not reach; the page sends those again (nginx cuts a response at 60).
 */
interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export const maxDuration = 60;

/** Requests, not abstracts: a long send with emails is several requests. */
const RATE_LIMIT = 60;
const RATE_WINDOW_SECONDS = 3600;
const ROUTE = "events/[eventId]/abstracts/bulk-update:POST";

const bodySchema = z
  .object({
    abstractIds: z.array(z.string().min(1).max(100)).min(1).max(MAX_BULK_ABSTRACT_UPDATES),
    status: z.enum(ABSTRACT_TRANSITION_STATUSES).optional(),
    presentationType: z.enum(BUILT_IN_PRESENTATION_TYPE_KEYS).optional(),
    notifyAuthors: z.boolean().optional(),
    forceStatus: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.status !== undefined || body.presentationType !== undefined, {
    message: "Choose a status or a type to set",
    path: ["status"],
  });

const HTTP_STATUS: Record<BulkUpdateAbstractsErrorCode, number> = {
  EVENT_NOT_FOUND: 404,
  NOTHING_TO_CHANGE: 400,
  TYPE_NOT_OFFERED: 400,
  TOO_MANY: 400,
  UNKNOWN: 500,
};

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([auth(), params, req.json().catch(() => null)]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: ROUTE });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "abstracts.update", { route: ROUTE, eventId });
    if (!gate.ok) return gate.response;

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "abstracts/bulk-update:zod-validation-failed", eventId, userId: session.user.id, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      // The event must be one the grant reaches: the service checks only the organisation.
      const event = await findGatedEvent(gate, { select: { id: true } });
      if (!event) {
        apiLogger.warn({ msg: "abstracts/bulk-update:event-not-found", eventId, userId: session.user.id });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }

      const rl = checkRateLimit({ key: `abstract-bulk-update:${session.user.id}`, limit: RATE_LIMIT, windowMs: RATE_WINDOW_SECONDS * 1000 });
      if (!rl.allowed) {
        apiLogger.warn({ msg: "abstracts/bulk-update:rate-limited", eventId, userId: session.user.id, retryAfterSeconds: rl.retryAfterSeconds });
        return NextResponse.json(
          { error: "Too many bulk changes. Try again later.", code: "RATE_LIMITED", retryAfterSeconds: rl.retryAfterSeconds, limit: RATE_LIMIT, windowSeconds: RATE_WINDOW_SECONDS },
          { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
        );
      }

      const { abstractIds, status, presentationType, notifyAuthors, forceStatus } = parsed.data;
      const result = await bulkUpdateAbstracts({
        eventId,
        organizationId: orgGuard.orgId,
        userId: session.user.id,
        abstractIds,
        status,
        presentationType,
        notifyAuthors: notifyAuthors === true,
        forceStatus: forceStatus === true,
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
    apiLogger.error({ err: error, msg: "abstracts/bulk-update:failed" });
    return NextResponse.json({ error: "Failed to update the abstracts" }, { status: 500 });
  }
}
