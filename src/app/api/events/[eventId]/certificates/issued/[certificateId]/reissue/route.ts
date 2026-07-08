/**
 * POST /api/events/[eventId]/certificates/issued/[certificateId]/reissue
 *
 * Re-render an already-issued certificate from the CURRENT template (picking
 * up any template / cover-email edits — e.g. a corrected greeting) and email
 * it again. Distinct from the plain /resend route, which faithfully replays
 * the FROZEN original PDF + cover-email snapshot. Delegates to
 * reRenderAndResendCert() in the shared cert-delivery service, which updates
 * pdfUrl + bumps reprintCount + resendCount.
 *
 * Auth: ADMIN / ORGANIZER (denyReviewer). Org-bound (service enforces).
 * Rate limit: shares the 30/hr/user `cert-resend` bucket (same abuse class).
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { reRenderAndResendCert } from "@/lib/certificates/deliver";

interface RouteParams {
  params: Promise<{ eventId: string; certificateId: string }>;
}

export async function POST(_req: Request, { params }: RouteParams) {
  let eventId: string | undefined;
  let certificateId: string | undefined;
  try {
    const [session, p] = await Promise.all([auth(), params]);
    eventId = p.eventId;
    certificateId = p.certificateId;
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session);
    if (denied) return denied;
    if (!session.user.organizationId) {
      apiLogger.warn({ msg: "cert-reissue:no-org", userId: session.user.id, eventId, certificateId });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const rl = checkRateLimit({ key: `cert-resend:${session.user.id}`, limit: 30, windowMs: 60 * 60 * 1000 });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "cert-reissue:rate-limited", userId: session.user.id, eventId, certificateId, retryAfterSeconds: rl.retryAfterSeconds });
      return NextResponse.json(
        { error: "Too many attempts. Try again later.", code: "RATE_LIMITED", retryAfterSeconds: rl.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const result = await reRenderAndResendCert(
      { eventId, organizationId: session.user.organizationId, actorUserId: session.user.id, source: "rest" },
      certificateId,
    );

    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
    }
    return NextResponse.json({
      ok: true,
      certificateId: result.certificateId,
      serial: result.serial,
      recipientEmail: result.recipientEmail,
      emailMessageId: result.messageId,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-reissue:failed", eventId, certificateId });
    return NextResponse.json({ error: "Failed to re-render and resend certificate" }, { status: 500 });
  }
}
