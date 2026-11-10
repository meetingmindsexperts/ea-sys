import { NextResponse } from "next/server";
import crypto from "crypto";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { getClientIp, hashVerificationToken, checkRateLimit } from "@/lib/security";
import { notifyReviewerPoolAdded, sendReviewerSetupInvitation } from "@/lib/abstract-reviewer-notify";
import { loadPublicBrandForOrg } from "@/lib/public-brand-server";

/**
 * Send a reviewer their email: the ONLY way a reviewer is emailed about being
 * added, since adding one sends nothing (owner, Nov 10, 2026: "disable auto
 * email trigger on reviewer addition, send email manually"). The path keeps
 * its old "resend" name so existing clients keep working.
 *
 * A pending account gets a freshly minted setup token and the account-setup
 * invitation; an account that can already sign in gets the event-level
 * "you're a reviewer" email. A send failure surfaces (502) so the organiser
 * knows it did not go.
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
      select: { id: true, email: true, firstName: true, lastName: true, emailVerified: true },
    });
    if (!user) {
      apiLogger.warn({ msg: "reviewer-invite-resend:account-not-found", eventId, reviewerUserId: reviewerId, userId: session.user.id });
      return NextResponse.json({ error: "Reviewer account not found" }, { status: 404 });
    }

    // An account that can already sign in gets the "added as a reviewer"
    // email. A refused send surfaces (502), as the setup invite's does below:
    // until Nov 10, 2026 this answered "sent" whatever happened.
    if (user.emailVerified) {
      const sent = await notifyReviewerPoolAdded({
        eventId,
        organizationId: session.user.organizationId ?? null,
        reviewer: user,
        eventName: event.name,
        triggeredByUserId: session.user.id,
      });
      if (!sent.ok) {
        apiLogger.error({ msg: "reviewer-invite-resend:pool-send-failed", eventId, reviewerUserId: reviewerId, code: sent.code });
        return NextResponse.json({ error: sent.message, code: "EMAIL_SEND_FAILED" }, { status: 502 });
      }
      apiLogger.info({ msg: "reviewer-invite-resend:pool", eventId, reviewerUserId: reviewerId });
      db.auditLog.create({
        data: { eventId, userId: session.user.id, action: "UPDATE", entityType: "EventReviewer", entityId: reviewerId, changes: { resend: "pool", ip: getClientIp(req) } },
      }).catch((err) => apiLogger.error({ err, msg: "resend-invitation:audit-log-failed" }));
      return NextResponse.json({ success: true, sent: true, type: "pool" });
    }

    // Pending account → re-mint a fresh setup token + resend the setup invite.
    const invitationToken = crypto.randomBytes(32).toString("hex");
    const invitationTokenHash = hashVerificationToken(invitationToken);
    const tokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const normalizedEmail = user.email.toLowerCase();

    await db.$transaction(async (tx) => {
      await tx.verificationToken.deleteMany({ where: { identifier: normalizedEmail } });
      await tx.verificationToken.create({ data: { identifier: normalizedEmail, token: invitationTokenHash, expires: tokenExpiry } });
    });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
    const setupLink = `${appUrl}/accept-invitation?token=${invitationToken}&email=${encodeURIComponent(normalizedEmail)}&eventSlug=${encodeURIComponent(event.slug)}`;

    // A reviewer is an HCP: the invitation names the attendee-facing brand (public-brand.ts).
    const brand = session.user.organizationId ? await loadPublicBrandForOrg(orgGuard.orgId) : null;
    const inviterName = session.user.firstName && session.user.lastName
      ? `${session.user.firstName} ${session.user.lastName}`
      : session.user.email || "A team member";

    // The event's own template (Email Templates → Reviewer Account Invitation).
    // The event's Auto-CC and the reviewer's additional email are copied; the
    // account stays on their main address (owner, Nov 10, 2026).
    const sent = await sendReviewerSetupInvitation({
      eventId,
      organizationId: session.user.organizationId ?? null,
      reviewer: user,
      eventName: event.name,
      triggeredByUserId: session.user.id,
      organizationName: brand?.name || "your organization",
      inviterName,
      setupLink,
      expiresIn: "7 days",
    });
    if (!sent.ok) {
      apiLogger.error({ msg: "reviewer-invite-resend:send-failed", eventId, reviewerUserId: reviewerId, code: sent.code });
      return NextResponse.json({ error: sent.message, code: "EMAIL_SEND_FAILED" }, { status: 502 });
    }

    apiLogger.info({ msg: "reviewer-invite-resend:setup", eventId, reviewerUserId: reviewerId });
    db.auditLog.create({
      data: { eventId, userId: session.user.id, action: "UPDATE", entityType: "EventReviewer", entityId: reviewerId, changes: { resend: "setup", ip: getClientIp(req) } },
    }).catch((err) => apiLogger.error({ err, msg: "resend-invitation:audit-log-failed" }));

    return NextResponse.json({ success: true, sent: true, type: "setup" });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error resending reviewer invitation" });
    return NextResponse.json({ error: "Failed to resend invitation" }, { status: 500 });
  }
}
