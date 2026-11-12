import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit, getClientIp } from "@/lib/security";
import {
  assignReviewersBulk,
  unassignReviewersBulk,
  MAX_BULK_REVIEWER_PAIRS,
  type BulkReviewerErrorCode,
} from "@/services/abstract-service";

/**
 * Bulk reviewer assignment for an event's abstracts (Nov 12, 2026).
 *
 *   POST    put each group's reviewer on each of its abstracts
 *   DELETE  take each group's reviewer off each of its abstracts
 *
 * Body for both: `{ groups: [{ reviewerUserId, abstractIds: [...] }] }`. The
 * Abstracts page sends one group per chosen reviewer (ticked rows, or pasted
 * abstract numbers), and the pasted reviewer sheet sends one group per person
 * the sheet names.
 *
 * Same key and the same rules as assigning one by one
 * (abstracts/[abstractId]/reviewers): no email is sent, an author is never
 * given their own abstract, a draft or withdrawn abstract takes nobody, and
 * running it twice changes nothing. Only people on the event's reviewer pool
 * can be bulk assigned. Domain logic lives in abstract-service
 * (assignReviewersBulk / unassignReviewersBulk); this route keeps auth, the
 * rate limit, Zod and the HTTP shape.
 *
 * Every pair that could not be done comes back in `skipped` with a reason
 * code, so the page can say which abstracts and why.
 */

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const RATE_LIMIT = 60;
const RATE_WINDOW_SECONDS = 3600;

const bulkSchema = z.object({
  groups: z
    .array(
      z.object({
        reviewerUserId: z.string().min(1).max(100),
        abstractIds: z.array(z.string().min(1).max(100)).min(1).max(MAX_BULK_REVIEWER_PAIRS),
      }),
    )
    .min(1)
    .max(500),
});

const HTTP_STATUS: Record<BulkReviewerErrorCode, number> = {
  EVENT_NOT_FOUND: 404,
  NO_PAIRS: 400,
  TOO_MANY: 400,
  UNKNOWN: 500,
};

type Verb = "POST" | "DELETE";

type Admitted =
  | { ok: false; response: NextResponse }
  | { ok: true; userId: string; orgId: string };

function rateLimited(userId: string, eventId: string): NextResponse | null {
  const rl = checkRateLimit({
    key: `abstract-bulk-reviewers:${userId}`,
    limit: RATE_LIMIT,
    windowMs: RATE_WINDOW_SECONDS * 1000,
  });
  if (rl.allowed) return null;
  apiLogger.warn({ msg: "abstracts/reviewer-assignments:rate-limited", userId, eventId, retryAfterSeconds: rl.retryAfterSeconds });
  return NextResponse.json(
    {
      error: "Too many bulk reviewer changes. Try again later.",
      code: "RATE_LIMITED",
      retryAfterSeconds: rl.retryAfterSeconds,
      limit: RATE_LIMIT,
      windowSeconds: RATE_WINDOW_SECONDS,
    },
    { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
  );
}

/** Everything both verbs check before reading the body: sign-in, organisation, the key, the event, the limit. */
async function admit(session: Session | null, eventId: string, verb: Verb): Promise<Admitted> {
  const route = `events/[eventId]/abstracts/reviewer-assignments:${verb}`;
  if (!session?.user) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const orgGuard = requireOrgId(session, { route });
  if ("error" in orgGuard) return { ok: false, response: orgGuard.error };

  const gate = requirePermission(session, "abstracts.reviewers.assign", { route, eventId });
  if (!gate.ok) return { ok: false, response: gate.response };

  // The event must be one the grant reaches: the service checks only the organisation.
  const inScope = await db.event.findFirst({ where: gate.eventWhere, select: { id: true } });
  if (!inScope) {
    apiLogger.warn({ msg: "abstracts/reviewer-assignments:event-not-found", eventId, userId: session.user.id, verb });
    return { ok: false, response: NextResponse.json({ error: "Event not found" }, { status: 404 }) };
  }

  const limited = rateLimited(session.user.id, eventId);
  if (limited) return { ok: false, response: limited };

  return { ok: true, userId: session.user.id, orgId: orgGuard.orgId };
}

/** A body that is not `{ groups: [...] }`: logged with its field errors, answered 400. */
function invalidInput(error: z.ZodError, eventId: string, verb: Verb): NextResponse {
  apiLogger.warn({ msg: "abstracts/reviewer-assignments:zod-validation-failed", eventId, verb, errors: error.flatten() });
  return NextResponse.json({ error: "Invalid input", details: error.flatten() }, { status: 400 });
}

/** A refused bulk change as its HTTP answer. The service has already logged it. */
function refusedResponse(result: { code: BulkReviewerErrorCode; message: string }): NextResponse {
  return NextResponse.json({ error: result.message, code: result.code }, { status: HTTP_STATUS[result.code] ?? 500 });
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([auth(), params, req.json().catch(() => null)]);
    const admitted = await admit(session, eventId, "POST");
    if (!admitted.ok) return admitted.response;

    const validated = bulkSchema.safeParse(body);
    if (!validated.success) return invalidInput(validated.error, eventId, "POST");

    return await runWithTenant(admitted.orgId, async () => {
      const result = await assignReviewersBulk({
        eventId,
        organizationId: admitted.orgId,
        groups: validated.data.groups,
        actorUserId: admitted.userId,
        source: "rest",
        ip: getClientIp(req),
      });
      if (!result.ok) return refusedResponse(result);
      return NextResponse.json({
        success: true,
        assigned: result.assigned,
        alreadyAssigned: result.alreadyAssigned,
        skipped: result.skipped,
      });
    });
  } catch (err) {
    apiLogger.error({ err, msg: "bulk-assign-reviewers:route-failed" });
    return NextResponse.json({ error: "Failed to assign reviewers", code: "BULK_ASSIGN_REVIEWERS_FAILED" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([auth(), params, req.json().catch(() => null)]);
    const admitted = await admit(session, eventId, "DELETE");
    if (!admitted.ok) return admitted.response;

    const validated = bulkSchema.safeParse(body);
    if (!validated.success) return invalidInput(validated.error, eventId, "DELETE");

    return await runWithTenant(admitted.orgId, async () => {
      const result = await unassignReviewersBulk({
        eventId,
        organizationId: admitted.orgId,
        groups: validated.data.groups,
        actorUserId: admitted.userId,
        source: "rest",
        ip: getClientIp(req),
      });
      if (!result.ok) return refusedResponse(result);
      return NextResponse.json({
        success: true,
        removed: result.removed,
        notAssigned: result.notAssigned,
        skipped: result.skipped,
      });
    });
  } catch (err) {
    apiLogger.error({ err, msg: "bulk-unassign-reviewers:route-failed" });
    return NextResponse.json({ error: "Failed to remove reviewers", code: "BULK_UNASSIGN_REVIEWERS_FAILED" }, { status: 500 });
  }
}
