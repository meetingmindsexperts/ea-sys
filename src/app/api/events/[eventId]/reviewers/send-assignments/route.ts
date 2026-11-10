import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { getClientIp, checkRateLimit } from "@/lib/security";
import { sendPendingAssignments } from "@/lib/abstract-reviewer-notify";

/**
 * Send reviewers their new assignments: one email per reviewer, listing every
 * assignment on this event not emailed yet (owner, Nov 10, 2026: assigning
 * sends nothing, so a large event does not send hundreds of emails, each
 * copied to the event's Auto-CC list).
 *
 *   POST { reviewerIds?: string[] }
 *     → every reviewer named, or, with none named, everyone holding an unsent
 *       assignment on this event. Answers what went to whom.
 */
interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const bodySchema = z.object({ reviewerIds: z.array(z.string().min(1).max(100)).max(200).optional() });

/** More than this in one press is not a reviewer list; it would also hold the request open too long. */
const MAX_REVIEWERS_PER_SEND = 200;

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session, body] = await Promise.all([params, auth(), req.json().catch(() => ({}))]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/reviewers/send-assignments:POST" });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "abstracts.reviewers.assign", { route: "events/[eventId]/reviewers/send-assignments:POST", eventId });
    if (!gate.ok) return gate.response;

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "reviewer-assignments-send:invalid-input", eventId, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const rl = checkRateLimit({ key: `reviewer-assignments-send:${session.user.id}`, limit: 30, windowMs: 60 * 60 * 1000 });
      if (!rl.allowed) {
        apiLogger.warn({ msg: "reviewer-assignments-send:rate-limited", userId: session.user.id, eventId });
        return NextResponse.json(
          { error: "Too many sends. Please try again later.", retryAfterSeconds: rl.retryAfterSeconds, limit: 30, windowSeconds: 3600 },
          { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
        );
      }

      const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true } });
      if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

      // Who has something unsent on THIS event: a named id with nothing
      // pending, or from another event, is simply not in the list.
      const pending = await db.abstractReviewer.findMany({
        where: {
          notifiedAt: null,
          abstract: { eventId },
          ...(parsed.data.reviewerIds ? { userId: { in: parsed.data.reviewerIds } } : {}),
        },
        select: { userId: true },
        distinct: ["userId"],
        take: MAX_REVIEWERS_PER_SEND,
      });

      const results: { reviewerId: string; ok: boolean; sent?: number; code?: string; message?: string }[] = [];
      // One at a time: the provider has a send rate, and each send marks its rows.
      for (const { userId } of pending) {
        const r = await sendPendingAssignments({
          eventId,
          organizationId: orgGuard.orgId,
          reviewerUserId: userId,
          triggeredByUserId: session.user.id,
        });
        results.push(r.ok ? { reviewerId: userId, ok: true, sent: r.sent } : { reviewerId: userId, ok: false, code: r.code, message: r.message });
      }

      const emailed = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok && r.code !== "NOTHING_PENDING");
      apiLogger.info({ msg: "reviewer-assignments-send:done", eventId, reviewers: results.length, emailed, failed: failed.length });
      if (failed.length > 0) {
        apiLogger.warn({ msg: "reviewer-assignments-send:some-failed", eventId, failed });
      }
      db.auditLog.create({
        data: { eventId, userId: session.user.id, action: "UPDATE", entityType: "EventReviewer", entityId: eventId, changes: { sendAssignments: { emailed, failed: failed.length }, ip: getClientIp(req) } },
      }).catch((err) => apiLogger.error({ err, msg: "reviewer-assignments-send:audit-log-failed" }));

      return NextResponse.json({ emailed, failed: failed.length, results });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "reviewer-assignments-send:failed" });
    return NextResponse.json({ error: "Failed to send assignments" }, { status: 500 });
  }
}
