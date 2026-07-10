/**
 * POST /api/events/[eventId]/certificates/issued/resend-preview
 *   body: { certificateId }                       — preview a per-row reissue
 *      or { registrationId? | speakerId? }        — preview a "Resend all" bundle
 *   → 200 { subject, htmlContent, recipientEmail, serials }
 *
 * READ-ONLY render of exactly what the corresponding resend would email
 * (same renderBundleEmailContent pipeline) — the preview-before-resend step
 * on the IssuedCertificatesCard (organizer request 2026-07-10). No DB
 * writes, no email, no counters.
 *
 * Auth: ADMIN / ORGANIZER (denyReviewer), org-bound via the event.
 * Rate limit: 60/hr per user (reads — cheaper than the 30/hr send buckets).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { previewReissueEmail, previewResendBundleEmail } from "@/lib/certificates/deliver";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const bodySchema = z
  .object({
    certificateId: z.string().min(1).max(100).optional(),
    registrationId: z.string().min(1).max(100).optional(),
    speakerId: z.string().min(1).max(100).optional(),
  })
  .refine(
    (d) =>
      d.certificateId
        ? !d.registrationId && !d.speakerId
        : Boolean(d.registrationId) !== Boolean(d.speakerId),
    { message: "Provide certificateId OR exactly one of registrationId / speakerId." },
  );

export async function POST(req: Request, { params }: RouteParams) {
  let eventId: string | undefined;
  try {
    const [session, p, rawBody] = await Promise.all([auth(), params, req.json().catch(() => ({}))]);
    eventId = p.eventId;
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session);
    if (denied) return denied;
    if (!session.user.organizationId) {
      apiLogger.warn({ msg: "cert-resend-preview:no-org", userId: session.user.id, eventId });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = bodySchema.safeParse(rawBody);
    if (!parsed.success) {
      apiLogger.warn({
        msg: "cert-resend-preview:validation-failed",
        eventId,
        userId: session.user.id,
        errors: parsed.error.flatten(),
      });
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const rl = checkRateLimit({
      key: `cert-resend-preview:${session.user.id}`,
      limit: 60,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      apiLogger.warn({
        msg: "cert-resend-preview:rate-limited",
        userId: session.user.id,
        eventId,
        retryAfterSeconds: rl.retryAfterSeconds,
      });
      return NextResponse.json(
        {
          error: "Too many preview requests. Try again shortly.",
          code: "RATE_LIMITED",
          retryAfterSeconds: rl.retryAfterSeconds,
        },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    // Org binding (404 on cross-tenant — non-enumeration).
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId },
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "cert-resend-preview:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const ctx = {
      eventId,
      organizationId: session.user.organizationId,
      actorUserId: session.user.id,
      source: "rest" as const,
    };
    const result = parsed.data.certificateId
      ? await previewReissueEmail(ctx, parsed.data.certificateId)
      : await previewResendBundleEmail(ctx, {
          registrationId: parsed.data.registrationId,
          speakerId: parsed.data.speakerId,
        });

    if (!result.ok) {
      apiLogger.warn({
        msg: "cert-resend-preview:rejected",
        eventId,
        userId: session.user.id,
        code: result.code,
        status: result.status,
      });
      return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
    }
    return NextResponse.json({
      subject: result.subject,
      htmlContent: result.htmlContent,
      recipientEmail: result.recipientEmail,
      serials: result.serials,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-resend-preview:failed", eventId });
    return NextResponse.json({ error: "Failed to build the preview" }, { status: 500 });
  }
}
