import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { getClientIp, checkRateLimit } from "@/lib/security";
import { reviewerPoolIds, sendableAssignmentWhere } from "@/lib/abstract-reviewer-access";
import { sendPendingAssignments } from "@/lib/abstract-reviewer-notify";

/**
 * Send reviewers their new assignments: one email per reviewer, listing every
 * assignment on this event not emailed yet (owner, Nov 10, 2026: assigning
 * sends nothing, so a large event does not send hundreds of emails, each
 * copied to the event's Auto-CC list).
 *
 *   POST { reviewerIds?: string[], after?: string }
 *     → the reviewers named, or with none named everyone, who are ON THE
 *       EVENT'S POOL and hold something sendable (sendableAssignmentWhere:
 *       the same people and numbers the Reviewers page shows), in userId
 *       order, starting after `after`.
 *
 * One request sends for SEND_BUDGET_MS and then stops, answering `nextAfter`
 * so the client carries on from there: nginx cuts a response at 60 seconds
 * while Node would keep sending, and the organiser's retry then overlapped the
 * first run (review of 2df0f9e6). Overlapping runs are safe anyway: each
 * reviewer's rows are leased before their email (sendPendingAssignments), and
 * a reviewer another run holds is answered as busy, not emailed twice.
 */
interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const bodySchema = z
  .object({
    reviewerIds: z.array(z.string().min(1).max(100)).max(500).optional(),
    after: z.string().min(1).max(100).optional(),
  })
  .strict();

export const maxDuration = 60;

/** Half the gateway's 60 seconds: the rest is left for the one send in flight. */
const SEND_BUDGET_MS = 30_000;
/** Requests, not emails: one press on a large event is several requests. */
const SENDS_PER_HOUR = 60;

type SendResult = Awaited<ReturnType<typeof sendPendingAssignments>>;

function resultRow(reviewerId: string, r: SendResult) {
  if (r.ok) return { reviewerId, ok: true as const, sent: r.sent, recorded: r.recorded, reclaimed: r.reclaimed };
  return { reviewerId, ok: false as const, code: r.code, message: r.message };
}

/** Skipped, not failed: nothing was wrong with the send itself. */
const NOT_A_FAILURE = new Set(["NOTHING_PENDING", "IN_PROGRESS", "ACCOUNT_NOT_SET_UP"]);

export async function POST(req: Request, { params }: RouteParams) {
  try {
    // A body that is not JSON is refused, never read as "send to everyone".
    const [{ eventId }, session, body] = await Promise.all([params, auth(), req.json().catch(() => null)]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/reviewers/send-assignments:POST" });
    if ("error" in orgGuard) return orgGuard.error;
    // The Reviewers page's own key: its buttons, its counts and its other
    // email button (resend-invitation) all ask it.
    const gate = requirePermission(session, "reviewers.pool.manage", { route: "events/[eventId]/reviewers/send-assignments:POST", eventId });
    if (!gate.ok) return gate.response;

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "reviewer-assignments-send:invalid-input", eventId, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    const { reviewerIds, after } = parsed.data;

    return await runWithTenant(orgGuard.orgId, async () => {
      const rl = checkRateLimit({ key: `reviewer-assignments-send:${session.user.id}`, limit: SENDS_PER_HOUR, windowMs: 60 * 60 * 1000 });
      if (!rl.allowed) {
        apiLogger.warn({ msg: "reviewer-assignments-send:rate-limited", userId: session.user.id, eventId });
        return NextResponse.json(
          { error: "Too many sends. Please try again later.", retryAfterSeconds: rl.retryAfterSeconds, limit: SENDS_PER_HOUR, windowSeconds: 3600 },
          { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
        );
      }

      const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true, settings: true } });
      if (!event) {
        apiLogger.warn({ msg: "reviewer-assignments-send:event-not-found", eventId, userId: session.user.id });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }

      // Only people on the pool: the page lists and counts nobody else, so a
      // press must not email someone it does not show.
      const pool = reviewerPoolIds(event.settings);
      const targets = reviewerIds ? reviewerIds.filter((id) => pool.includes(id)) : pool;
      if (reviewerIds && targets.length < reviewerIds.length) {
        apiLogger.warn({ msg: "reviewer-assignments-send:not-on-pool", eventId, ids: reviewerIds.filter((id) => !pool.includes(id)) });
      }

      const candidates = targets.length
        ? await db.abstractReviewer.findMany({
            where: { ...sendableAssignmentWhere(eventId), userId: { in: targets, ...(after ? { gt: after } : {}) } },
            select: { userId: true },
            distinct: ["userId"],
            orderBy: { userId: "asc" },
          })
        : [];

      const startedAt = Date.now();
      const results: ReturnType<typeof resultRow>[] = [];
      // One at a time: the provider has a send rate, and each send leases and
      // marks its own rows. The first is always attempted, so the cursor moves.
      for (const { userId } of candidates) {
        if (results.length > 0 && Date.now() - startedAt >= SEND_BUDGET_MS) break;
        const sent = await sendPendingAssignments({
          eventId,
          organizationId: orgGuard.orgId,
          reviewerUserId: userId,
          triggeredByUserId: session.user.id,
        });
        results.push(resultRow(userId, sent));
      }

      const remaining = candidates.length - results.length;
      const nextAfter = remaining > 0 ? results[results.length - 1].reviewerId : null;
      const emailed = results.filter((r) => r.ok).length;
      const busy = results.filter((r) => !r.ok && r.code === "IN_PROGRESS").length;
      const notSetUp = results.filter((r) => !r.ok && r.code === "ACCOUNT_NOT_SET_UP").length;
      const notRecorded = results.filter((r) => r.ok && !r.recorded).length;
      const failedRows = results.filter((r) => !r.ok && !NOT_A_FAILURE.has(r.code));
      const durationMs = Date.now() - startedAt;

      apiLogger.info({ msg: "reviewer-assignments-send:done", eventId, attempted: results.length, emailed, busy, notSetUp, notRecorded, failed: failedRows.length, remaining, durationMs });
      if (remaining > 0) {
        apiLogger.info({ msg: "reviewer-assignments-send:budget-reached", eventId, remaining, nextAfter, durationMs });
      }
      if (failedRows.length > 0) {
        apiLogger.warn({ msg: "reviewer-assignments-send:some-failed", eventId, failed: failedRows });
      }
      db.auditLog.create({
        data: {
          eventId,
          userId: session.user.id,
          action: "UPDATE",
          entityType: "EventReviewer",
          entityId: eventId,
          changes: { sendAssignments: { emailed, failed: failedRows.length, busy, notSetUp, notRecorded, remaining, after: after ?? null, durationMs }, ip: getClientIp(req) },
        },
      }).catch((err) => apiLogger.error({ err, msg: "reviewer-assignments-send:audit-log-failed" }));

      return NextResponse.json({ emailed, failed: failedRows.length, busy, notSetUp, notRecorded, remaining, nextAfter, results });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "reviewer-assignments-send:failed" });
    return NextResponse.json({ error: "Failed to send assignments" }, { status: 500 });
  }
}
