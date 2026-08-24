import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp, checkRateLimit } from "@/lib/security";
import { sendAbstractSubmissionConfirmation } from "@/lib/abstract-notifications";

/**
 * Resend the abstract-submission-confirmation email for one abstract
 * (organizer action, Aug 4 2026 — "resend from speaker"). The automatic
 * sends (create POST / resubmit PUT) are fire-and-forget, so a bounced or
 * lost confirmation left the submitter with nothing and the organizer with
 * no recovery. This mirrors the reviewer resend-invitation pattern: same
 * shared send implementation as the auto path, but a send failure SURFACES
 * as a 502 so the organizer knows it didn't go.
 *
 * Organizer-only (default denyReviewer set) — submitters re-trigger their
 * own confirmation by resubmitting; this is the staff recovery lever.
 */
interface RouteParams {
  params: Promise<{ eventId: string; abstractId: string }>;
}

/** Statuses that never received a submission confirmation / where resending
 * "your abstract was submitted" would be misleading. */
const NOT_RESENDABLE_STATUSES = new Set(["DRAFT", "WITHDRAWN"]);

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, abstractId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/abstracts/[abstractId]/resend-confirmation:POST" });
    if ("error" in orgGuard) return orgGuard.error;
    const denied = denyReviewer(session);
    if (denied) return denied;

    return await runWithTenant(orgGuard.orgId, async () => {
    const rl = checkRateLimit({ key: `abstract-confirm-resend:${session.user.id}`, limit: 30, windowMs: 60 * 60 * 1000 });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "abstract-confirm-resend:rate-limited", userId: session.user.id, eventId });
      return NextResponse.json(
        { error: "Too many resend attempts. Please try again later.", retryAfterSeconds: rl.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: orgGuard.orgId },
      select: { id: true, name: true, slug: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "abstract-confirm-resend:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const abstract = await db.abstract.findFirst({
      where: { id: abstractId, eventId },
      select: {
        id: true,
        title: true,
        status: true,
        serialId: true,
        speaker: {
          select: { id: true, email: true, additionalEmail: true, firstName: true, lastName: true, title: true },
        },
      },
    });
    if (!abstract) {
      apiLogger.warn({ msg: "abstract-confirm-resend:abstract-not-found", eventId, abstractId, userId: session.user.id });
      return NextResponse.json({ error: "Abstract not found" }, { status: 404 });
    }

    if (NOT_RESENDABLE_STATUSES.has(abstract.status)) {
      apiLogger.warn({ msg: "abstract-confirm-resend:not-resendable", eventId, abstractId, status: abstract.status });
      return NextResponse.json(
        {
          error:
            abstract.status === "DRAFT"
              ? "This abstract is still a draft — no submission confirmation exists to resend."
              : "This abstract was withdrawn — resending a submission confirmation would be misleading.",
          code: "NOT_RESENDABLE",
        },
        { status: 400 },
      );
    }

    if (!abstract.speaker?.email) {
      apiLogger.warn({ msg: "abstract-confirm-resend:no-speaker-email", eventId, abstractId });
      return NextResponse.json(
        { error: "The submitting author has no email address on file.", code: "NO_SPEAKER_EMAIL" },
        { status: 400 },
      );
    }

    // Manual sends render the resending organizer's saved signature (the
    // automated sends deliberately leave {{organizerSignature}} empty).
    const sender = await db.user.findUnique({
      where: { id: session.user.id },
      select: { emailSignature: true },
    });

    const sent = await sendAbstractSubmissionConfirmation({
      eventId,
      organizationId: orgGuard.orgId,
      eventName: event.name,
      eventSlug: event.slug,
      abstractId: abstract.id,
      abstractTitle: abstract.title,
      serialId: abstract.serialId,
      speaker: abstract.speaker,
      triggeredByUserId: session.user.id,
      organizerSignature: sender?.emailSignature ?? null,
    });

    if (!sent) {
      apiLogger.error({ msg: "abstract-confirm-resend:send-failed", eventId, abstractId, userId: session.user.id });
      return NextResponse.json(
        { error: "Failed to send the confirmation email. Please try again.", code: "EMAIL_SEND_FAILED" },
        { status: 502 },
      );
    }

    apiLogger.info({ msg: "abstract-confirm-resend:sent", eventId, abstractId, userId: session.user.id });
    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "EMAIL_SENT",
        entityType: "Abstract",
        entityId: abstractId,
        changes: {
          resend: "abstract-submission-confirmation",
          recipient: abstract.speaker.email,
          ip: getClientIp(req),
        },
      },
    }).catch((err) => apiLogger.error({ err, msg: "abstract-confirm-resend:audit-log-failed", eventId, abstractId }));

    return NextResponse.json({ success: true, sentTo: abstract.speaker.email });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error resending abstract submission confirmation" });
    return NextResponse.json({ error: "Failed to resend confirmation" }, { status: 500 });
  }
}
