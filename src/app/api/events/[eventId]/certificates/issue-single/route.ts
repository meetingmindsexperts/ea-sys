/**
 * POST /api/events/[eventId]/certificates/issue-single
 *
 * Issue one OR SEVERAL certificate templates to ONE registration or speaker
 * on demand — the on-the-spot alternative to the tag-driven bulk Issue flow.
 * Renders + emails synchronously (single recipient) as ONE bundle email with
 * one PDF per cert. Delegates to issueCertificateBundle() in the shared
 * cert-delivery service; an already-held template is re-attached (existing
 * serial), never duplicated.
 *
 * Body: { templateIds: string[] (1..10), registrationId? | speakerId? }
 *       (legacy single shape `templateId` still accepted).
 * Auth: ADMIN / ORGANIZER (denyReviewer). Org-bound. 30/hr/user rate limit.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { issueCertificateBundle } from "@/lib/certificates/deliver";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const bodySchema = z
  .object({
    templateId: z.string().min(1).max(64).optional(),
    templateIds: z.array(z.string().min(1).max(64)).min(1).max(10).optional(),
    registrationId: z.string().min(1).max(64).optional(),
    speakerId: z.string().min(1).max(64).optional(),
    // Default true. False = "issue only" — mint + store the certs, skip the
    // delivery email (operator downloads from the card and hands them over).
    sendEmail: z.boolean().optional(),
  })
  .refine((d) => Boolean(d.registrationId) !== Boolean(d.speakerId), {
    message: "Provide exactly one of registrationId or speakerId.",
  })
  .refine((d) => Boolean(d.templateId) || Boolean(d.templateIds?.length), {
    message: "Provide templateIds (or the legacy templateId).",
  });

export async function POST(req: Request, { params }: RouteParams) {
  let eventId: string | undefined;
  try {
    const [session, p] = await Promise.all([auth(), params]);
    eventId = p.eventId;
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session);
    if (denied) return denied;
    if (!session.user.organizationId) {
      apiLogger.warn({ msg: "cert-issue-single:no-org", userId: session.user.id, eventId });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const rl = checkRateLimit({ key: `cert-issue-single:${session.user.id}`, limit: 30, windowMs: 60 * 60 * 1000 });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "cert-issue-single:rate-limited", userId: session.user.id, eventId, retryAfterSeconds: rl.retryAfterSeconds });
      return NextResponse.json(
        { error: "Too many issue attempts. Try again later.", code: "RATE_LIMITED", retryAfterSeconds: rl.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      apiLogger.warn({ msg: "cert-issue-single:zod-failed", eventId, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    // Org-bind the event first (404 on cross-tenant — non-enumeration).
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId },
      select: { id: true },
    });
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    const templateIds = parsed.data.templateIds?.length
      ? parsed.data.templateIds
      : [parsed.data.templateId!];
    const result = await issueCertificateBundle(
      { eventId, organizationId: session.user.organizationId, actorUserId: session.user.id, source: "rest" },
      {
        templateIds,
        registrationId: parsed.data.registrationId,
        speakerId: parsed.data.speakerId,
        sendEmail: parsed.data.sendEmail,
      },
    );

    if (!result.ok) {
      // Log every rejection (validation / business / operational) so none is
      // silent — the service already logs render/send specifics; this captures
      // the errors-as-values codes it returns.
      apiLogger.warn({
        msg: "cert-issue-single:rejected",
        eventId,
        code: result.code,
        status: result.status,
        userId: session.user.id,
      });
      return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
    }
    return NextResponse.json({
      ok: true,
      recipientEmail: result.recipientEmail,
      certs: result.certs,
      failures: result.failures,
      emailed: result.emailed,
      // Legacy single-cert convenience fields (pre-multi clients during the
      // deploy overlap read these).
      certificateId: result.certs[0]?.certificateId,
      serial: result.certs[0]?.serial,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-issue-single:failed", eventId });
    return NextResponse.json({ error: "Failed to issue certificate" }, { status: 500 });
  }
}
