import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { getClientIp, checkRateLimit } from "@/lib/security";
import { reviewerPoolIds } from "@/lib/abstract-reviewer-access";
import { inviterNameOf, sendReviewerInvitation } from "@/lib/abstract-reviewer-notify";
import { loadPublicBrandForOrg } from "@/lib/public-brand-server";

/**
 * Send to all: the reviewer invitation to EVERY reviewer on the event's pool
 * (owner, Nov 10, 2026). The same email the row's Send button sends
 * (sendReviewerInvitation), one reviewer after another.
 *
 *   POST { after?: string }
 *     → everyone on the pool, in userId order, starting after `after`.
 *
 * Each press goes to everyone, including people already emailed: nothing
 * records who was sent what, and a second press is how an organiser reminds
 * the committee. The page asks before sending for that reason.
 *
 * One request sends for SEND_BUDGET_MS and then stops, answering `nextAfter`
 * so the client carries on from there: nginx cuts a response at 60 seconds
 * while Node would keep sending.
 */
interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const bodySchema = z.object({ after: z.string().min(1).max(100).optional() }).strict();

export const maxDuration = 60;

/** Half the gateway's 60 seconds: the rest is left for the one send in flight. */
const SEND_BUDGET_MS = 30_000;
/** Requests, not emails: one press on a large committee is several requests. */
const SENDS_PER_HOUR = 60;

const ROUTE = "events/[eventId]/reviewers/send-invitations:POST";

export async function POST(req: Request, { params }: RouteParams) {
  try {
    // A body that is not JSON is refused, never read as "start from the top".
    const [{ eventId }, session, body] = await Promise.all([params, auth(), req.json().catch(() => null)]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: ROUTE });
    if ("error" in orgGuard) return orgGuard.error;
    // The Reviewers page's own key: the row's Send button asks it too.
    const gate = requirePermission(session, "reviewers.pool.manage", { route: ROUTE, eventId });
    if (!gate.ok) return gate.response;

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "reviewer-invitations-send:invalid-input", eventId, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    const { after } = parsed.data;

    return await runWithTenant(orgGuard.orgId, async () => {
      const rl = checkRateLimit({ key: `reviewer-invitations-send:${session.user.id}`, limit: SENDS_PER_HOUR, windowMs: 60 * 60 * 1000 });
      if (!rl.allowed) {
        apiLogger.warn({ msg: "reviewer-invitations-send:rate-limited", userId: session.user.id, eventId });
        return NextResponse.json(
          { error: "Too many sends. Please try again later.", retryAfterSeconds: rl.retryAfterSeconds, limit: SENDS_PER_HOUR, windowSeconds: 3600 },
          { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
        );
      }

      const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true, name: true, slug: true, settings: true } });
      if (!event) {
        apiLogger.warn({ msg: "reviewer-invitations-send:event-not-found", eventId, userId: session.user.id });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }

      const pool = reviewerPoolIds(event.settings);
      const [reviewers, brand] = await Promise.all([
        pool.length
          ? db.user.findMany({
              where: { id: { in: pool, ...(after ? { gt: after } : {}) } },
              select: { id: true, email: true, firstName: true, lastName: true, emailVerified: true, role: true },
              orderBy: { id: "asc" },
            })
          : [],
        session.user.organizationId ? loadPublicBrandForOrg(orgGuard.orgId) : null,
      ]);

      const startedAt = Date.now();
      const results: Array<{ reviewerId: string; ok: boolean; kind?: string; message?: string }> = [];
      // One at a time: the provider has a send rate. The first is always
      // attempted, so the cursor moves on every request.
      for (const reviewer of reviewers) {
        if (results.length > 0 && Date.now() - startedAt >= SEND_BUDGET_MS) break;
        const sent = await sendReviewerInvitation({
          eventId,
          organizationId: orgGuard.orgId,
          eventName: event.name,
          eventSlug: event.slug,
          reviewer,
          organizationName: brand?.name || "your organization",
          inviterName: inviterNameOf(session.user),
          triggeredByUserId: session.user.id,
        });
        results.push(sent.ok ? { reviewerId: reviewer.id, ok: true, kind: sent.kind } : { reviewerId: reviewer.id, ok: false, message: sent.message });
      }

      const remaining = reviewers.length - results.length;
      const nextAfter = remaining > 0 ? results[results.length - 1].reviewerId : null;
      const emailed = results.filter((r) => r.ok).length;
      const failedRows = results.filter((r) => !r.ok);
      const durationMs = Date.now() - startedAt;

      apiLogger.info({ msg: "reviewer-invitations-send:done", eventId, attempted: results.length, emailed, failed: failedRows.length, remaining, nextAfter, durationMs });
      if (failedRows.length > 0) {
        apiLogger.warn({ msg: "reviewer-invitations-send:some-failed", eventId, failed: failedRows });
      }
      db.auditLog.create({
        data: {
          eventId,
          userId: session.user.id,
          action: "UPDATE",
          entityType: "EventReviewer",
          entityId: eventId,
          changes: { sendInvitations: { emailed, failed: failedRows.length, remaining, after: after ?? null, durationMs }, ip: getClientIp(req) },
        },
      }).catch((err) => apiLogger.error({ err, msg: "reviewer-invitations-send:audit-log-failed" }));

      return NextResponse.json({ emailed, failed: failedRows.length, remaining, nextAfter, results });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "reviewer-invitations-send:failed" });
    return NextResponse.json({ error: "Failed to send the invitations" }, { status: 500 });
  }
}
