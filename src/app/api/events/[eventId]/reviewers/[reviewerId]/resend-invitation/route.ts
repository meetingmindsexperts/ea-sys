import { NextResponse } from "next/server";
import crypto from "crypto";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp, hashVerificationToken, checkRateLimit } from "@/lib/security";
import { sendEmail, emailTemplates } from "@/lib/email";
import { notifyReviewerPoolAdded } from "@/lib/abstract-reviewer-notify";

/**
 * Resend a reviewer's invitation.
 *
 * The add-reviewer flow logs a warning + silently returns when the invitation
 * email fails to send (`invitationSent: false`), so a reviewer can be stranded
 * with no account and no link, indistinguishable from "sent, not yet accepted".
 * This action recovers that: it re-mints the setup token + resends the
 * account-setup invite for a pending account, OR resends the event-level
 * "you're a reviewer" email for an already-active account. Unlike the add path,
 * it **surfaces** a send failure (502) so the organizer knows it didn't go.
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
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;
    const denied = denyReviewer(session);
    if (denied) return denied;

    const rl = checkRateLimit({ key: `reviewer-invite-resend:${session.user.id}`, limit: 20, windowMs: 60 * 60 * 1000 });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "reviewer-invite-resend:rate-limited", userId: session.user.id });
      return NextResponse.json(
        { error: "Too many resend attempts. Please try again later.", retryAfterSeconds: rl.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: orgGuard.orgId },
      select: { id: true, name: true, slug: true, settings: true, emailFromAddress: true, emailFromName: true },
    });
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    const settings = (event.settings as Record<string, unknown>) || {};
    const reviewerUserIds = (settings.reviewerUserIds as string[]) || [];
    if (!reviewerUserIds.includes(reviewerId)) {
      return NextResponse.json({ error: "Reviewer not found for this event" }, { status: 404 });
    }

    const user = await db.user.findUnique({
      where: { id: reviewerId },
      select: { id: true, email: true, firstName: true, lastName: true, emailVerified: true },
    });
    if (!user) return NextResponse.json({ error: "Reviewer account not found" }, { status: 404 });

    const eventFrom = event.emailFromAddress
      ? { email: event.emailFromAddress, name: event.emailFromName || undefined }
      : undefined;

    // Already-active account → resend the event-level pool invitation (a
    // reminder; they already have a working login). notifyReviewerPoolAdded is
    // failure-isolated, so we report success optimistically here.
    if (user.emailVerified) {
      await notifyReviewerPoolAdded({
        eventId,
        organizationId: session.user.organizationId ?? null,
        reviewer: user,
        eventName: event.name,
        triggeredByUserId: session.user.id,
      });
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

    const organization = session.user.organizationId
      ? await db.organization.findUnique({ where: { id: orgGuard.orgId }, select: { name: true } })
      : null;
    const inviterName = session.user.firstName && session.user.lastName
      ? `${session.user.firstName} ${session.user.lastName}`
      : session.user.email || "A team member";

    const emailTemplate = emailTemplates.userInvitation({
      recipientName: `${user.firstName} ${user.lastName}`,
      recipientEmail: user.email,
      organizationName: organization?.name || "your organization",
      inviterName,
      role: "Reviewer",
      setupLink,
      expiresIn: "7 days",
    });

    const emailResult = await sendEmail({
      to: [{ email: normalizedEmail, name: `${user.firstName} ${user.lastName}` }],
      subject: emailTemplate.subject,
      htmlContent: emailTemplate.htmlContent,
      textContent: emailTemplate.textContent,
      from: eventFrom,
      emailType: "reviewer_invitation",
      stream: "transactional",
      logContext: {
        organizationId: session.user.organizationId,
        eventId,
        entityType: "USER",
        entityId: user.id,
        templateSlug: "reviewer-invitation",
        triggeredByUserId: session.user.id,
      },
    });

    if (!emailResult.success) {
      apiLogger.error({ msg: "reviewer-invite-resend:send-failed", eventId, reviewerUserId: reviewerId, error: emailResult.error });
      return NextResponse.json(
        { error: "Failed to send the invitation email. Please check the address and try again.", code: "EMAIL_SEND_FAILED" },
        { status: 502 },
      );
    }

    apiLogger.info({ msg: "reviewer-invite-resend:setup", eventId, reviewerUserId: reviewerId });
    db.auditLog.create({
      data: { eventId, userId: session.user.id, action: "UPDATE", entityType: "EventReviewer", entityId: reviewerId, changes: { resend: "setup", ip: getClientIp(req) } },
    }).catch((err) => apiLogger.error({ err, msg: "resend-invitation:audit-log-failed" }));

    return NextResponse.json({ success: true, sent: true, type: "setup" });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error resending reviewer invitation" });
    return NextResponse.json({ error: "Failed to resend invitation" }, { status: 500 });
  }
}
