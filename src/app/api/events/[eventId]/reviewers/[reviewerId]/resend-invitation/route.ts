import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { getClientIp, checkRateLimit } from "@/lib/security";
import { inviterNameOf, sendReviewerInvitation } from "@/lib/abstract-reviewer-notify";
import { loadPublicBrandForOrg } from "@/lib/public-brand-server";

/**
 * Send ONE reviewer the reviewer invitation: the row's Send button on the
 * Reviewers page. Adding a reviewer sends nothing (owner, Nov 10, 2026), so
 * this and Send to all (`reviewers/send-invitations`) are the only ways a
 * reviewer is emailed. The path keeps its old "resend" name so existing
 * clients keep working.
 *
 * One email for everyone (sendReviewerInvitation): an account with no
 * password yet gets a freshly minted set-password link in it, one that can
 * already sign in gets the portal button. A send failure surfaces (502) so
 * the organiser knows it did not go.
 */
interface RouteParams {
  params: Promise<{ eventId: string; reviewerId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, reviewerId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/reviewers/[reviewerId]/resend-invitation:POST" });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "reviewers.pool.manage", { route: "events/[eventId]/reviewers/[reviewerId]/resend-invitation:POST", eventId });
    if (!gate.ok) return gate.response;

    return await runWithTenant(orgGuard.orgId, async () => {
    const rl = checkRateLimit({ key: `reviewer-invite-resend:${session.user.id}`, limit: 20, windowMs: 60 * 60 * 1000 });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "reviewer-invite-resend:rate-limited", userId: session.user.id });
      return NextResponse.json(
        { error: "Too many resend attempts. Please try again later.", retryAfterSeconds: rl.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const event = await db.event.findFirst({
      where: gate.eventWhere,
      select: { id: true, name: true, slug: true, settings: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "reviewer-invite-resend:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const settings = (event.settings as Record<string, unknown>) || {};
    const reviewerUserIds = (settings.reviewerUserIds as string[]) || [];
    if (!reviewerUserIds.includes(reviewerId)) {
      apiLogger.warn({ msg: "reviewer-invite-resend:not-on-pool", eventId, reviewerUserId: reviewerId, userId: session.user.id });
      return NextResponse.json({ error: "Reviewer not found for this event" }, { status: 404 });
    }

    const user = await db.user.findUnique({
      where: { id: reviewerId },
      select: { id: true, email: true, firstName: true, lastName: true, emailVerified: true, role: true },
    });
    if (!user) {
      apiLogger.warn({ msg: "reviewer-invite-resend:account-not-found", eventId, reviewerUserId: reviewerId, userId: session.user.id });
      return NextResponse.json({ error: "Reviewer account not found" }, { status: 404 });
    }

    // A reviewer is an HCP: the invitation names the attendee-facing brand (public-brand.ts).
    const brand = session.user.organizationId ? await loadPublicBrandForOrg(orgGuard.orgId) : null;
    const sent = await sendReviewerInvitation({
      eventId,
      organizationId: session.user.organizationId ?? null,
      eventName: event.name,
      eventSlug: event.slug,
      reviewer: user,
      organizationName: brand?.name || "your organization",
      inviterName: inviterNameOf(session.user),
      triggeredByUserId: session.user.id,
    });
    if (!sent.ok) {
      apiLogger.error({ msg: "reviewer-invite-resend:send-failed", eventId, reviewerUserId: reviewerId, code: sent.code });
      return NextResponse.json({ error: sent.message, code: "EMAIL_SEND_FAILED" }, { status: 502 });
    }

    apiLogger.info({ msg: "reviewer-invite-resend:sent", eventId, reviewerUserId: reviewerId, kind: sent.kind });
    db.auditLog.create({
      data: { eventId, userId: session.user.id, action: "UPDATE", entityType: "EventReviewer", entityId: reviewerId, changes: { resend: sent.kind, ip: getClientIp(req) } },
    }).catch((err) => apiLogger.error({ err, msg: "resend-invitation:audit-log-failed" }));

    return NextResponse.json({ success: true, sent: true, type: sent.kind });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error resending reviewer invitation" });
    return NextResponse.json({ error: "Failed to resend invitation" }, { status: 500 });
  }
}
