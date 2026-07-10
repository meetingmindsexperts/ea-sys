/**
 * POST /api/events/[eventId]/certificates/issued/resend-bundle
 *   body: { registrationId?: string; speakerId?: string }   (exactly one)
 *   → 200 { sentCount, serials, recipientEmail }
 *
 * Re-sends EVERY certificate the PERSON behind the given facet holds —
 * the anchored registration/speaker plus the linked counterpart's certs —
 * as ONE email with one PDF attachment per cert (the "Resend all" action
 * on the IssuedCertificatesCard; it used to loop N single resends → N
 * emails).
 *
 * RESEND semantics: replays each cert's frozen PDF (same serial, no
 * re-render) — distinct from the card's per-row "Resend latest version"
 * (reissue), which re-renders from the CURRENT template. Certs with an
 * unloadable PDF are skipped with a warn (the per-row reissue is the
 * repair path); revoked certs are never sent.
 *
 * Cover email: the bundle/system default ({{certificateList}} enumerates
 * the attached certs) — with multiple certs there is no single frozen
 * run snapshot that could apply.
 *
 * Auth: ADMIN / ORGANIZER (denyReviewer), org-bound via the event.
 * Rate limit: 30/hr per user (shared abuse-floor with single resend).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import {
  buildPersonCertificateWhere,
  sendCertificateBundleEmail,
  resolveRecipientEmail,
  type BundleEmailCert,
} from "@/lib/certificates/bundle";
import { loadCertificatePdfBytes } from "@/lib/certificates/pdf-loader";
import { loadRecipient } from "@/lib/certificates/cert-context";
import { defaultCoverEmailFor } from "@/lib/certificates/email-tokens";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const bodySchema = z
  .object({
    registrationId: z.string().min(1).max(100).optional(),
    speakerId: z.string().min(1).max(100).optional(),
  })
  .refine((d) => Boolean(d.registrationId) !== Boolean(d.speakerId), {
    message: "Provide exactly one of registrationId or speakerId",
  });

export async function POST(req: Request, { params }: RouteParams) {
  let eventId: string | undefined;
  try {
    const [session, p, rawBody] = await Promise.all([
      auth(),
      params,
      req.json().catch(() => ({})),
    ]);
    eventId = p.eventId;
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;
    if (!session.user.organizationId) {
      apiLogger.warn({ msg: "cert-resend-bundle:no-org", userId: session.user.id, eventId });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = bodySchema.safeParse(rawBody);
    if (!parsed.success) {
      apiLogger.warn({
        msg: "cert-resend-bundle:validation-failed",
        eventId,
        userId: session.user.id,
        errors: parsed.error.flatten(),
      });
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const registrationId = parsed.data.registrationId ?? null;
    const speakerId = parsed.data.speakerId ?? null;

    // Same abuse-floor bucket as the single-cert resend — a bundle resend
    // is one operator action, so it costs one slot.
    const rl = checkRateLimit({
      key: `cert-resend:${session.user.id}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      apiLogger.warn({
        msg: "cert-resend-bundle:rate-limited",
        userId: session.user.id,
        eventId,
        retryAfterSeconds: rl.retryAfterSeconds,
      });
      return NextResponse.json(
        {
          error: "Too many resend attempts. Try again later.",
          code: "RATE_LIMITED",
          retryAfterSeconds: rl.retryAfterSeconds,
        },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    // Org binding (404 on cross-tenant — non-enumeration).
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId },
      select: { organizationId: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "cert-resend-bundle:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const { where, linkedRegistrationId, linkedSpeakerId } = await buildPersonCertificateWhere(
      eventId,
      registrationId,
      speakerId,
    );
    const certs = await db.issuedCertificate.findMany({
      where: { ...where, revokedAt: null, pdfUrl: { not: null } },
      orderBy: { issuedAt: "asc" },
      select: {
        id: true,
        serial: true,
        type: true,
        pdfUrl: true,
        certificateTemplate: { select: { name: true } },
      },
    });
    if (certs.length === 0) {
      apiLogger.warn({
        msg: "cert-resend-bundle:no-sendable-certs",
        eventId,
        userId: session.user.id,
        registrationId,
        speakerId,
      });
      return NextResponse.json(
        {
          error: "This person holds no sendable certificates (revoked or un-rendered ones can't be re-sent).",
          code: "NO_SENDABLE_CERTS",
        },
        { status: 409 },
      );
    }

    const [recipientEmail, recipient] = await Promise.all([
      resolveRecipientEmail(linkedRegistrationId, linkedSpeakerId),
      loadRecipient(linkedRegistrationId, linkedSpeakerId),
    ]);
    if (!recipientEmail) {
      return NextResponse.json(
        { error: "Recipient has no email address on file.", code: "NO_RECIPIENT_EMAIL" },
        { status: 409 },
      );
    }

    // Load each frozen PDF; unloadable ones are skipped with a warn (the
    // per-row reissue is the repair path — this action replays, not repairs).
    const bundle: BundleEmailCert[] = [];
    const sentCertIds: string[] = [];
    for (const cert of certs) {
      try {
        const pdfBuffer = await loadCertificatePdfBytes(cert.pdfUrl!, {
          eventId,
          certificateId: cert.id,
          userId: session.user.id,
        });
        bundle.push({
          serial: cert.serial,
          type: cert.type,
          templateName: cert.certificateTemplate?.name ?? "",
          pdfBuffer,
        });
        sentCertIds.push(cert.id);
      } catch (err) {
        apiLogger.warn({
          err,
          msg: "cert-resend-bundle:pdf-unloadable-skipped",
          eventId,
          certificateId: cert.id,
          serial: cert.serial,
        });
      }
    }
    if (bundle.length === 0) {
      return NextResponse.json(
        {
          error: "None of this person's certificate PDFs could be loaded — use “Resend latest version” to re-render them.",
          code: "PDF_MISSING",
        },
        { status: 409 },
      );
    }

    const cover = defaultCoverEmailFor(bundle.length, bundle[0].type);
    const send = await sendCertificateBundleEmail({
      eventId,
      organizationId: event.organizationId,
      recipientEmail,
      recipientName: recipient?.fullName ?? "Certificate recipient",
      registrationId: linkedRegistrationId,
      speakerId: linkedSpeakerId,
      certs: bundle,
      emailSubjectTemplate: cover.subject,
      emailBodyTemplate: cover.body,
      triggeredByUserId: session.user.id,
    });
    if (!send.success) {
      apiLogger.warn({
        msg: "cert-resend-bundle:send-failed",
        eventId,
        userId: session.user.id,
        recipientEmail,
        err: send.error,
      });
      return NextResponse.json(
        { error: send.error ?? "Email send failed.", code: "SEND_FAILED" },
        { status: 502 },
      );
    }

    await db.issuedCertificate.updateMany({
      where: { id: { in: sentCertIds } },
      data: { resendCount: { increment: 1 }, lastResentAt: new Date() },
    });
    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "CERT_BUNDLE_RESENT",
          entityType: "IssuedCertificate",
          entityId: registrationId ?? speakerId ?? "",
          changes: {
            source: "dashboard",
            certificateIds: sentCertIds,
            serials: bundle.map((c) => c.serial),
            recipientEmail,
          },
        },
      })
      .catch((err) =>
        apiLogger.warn({ err, msg: "cert-resend-bundle:audit-failed", eventId }),
      );

    apiLogger.info({
      msg: "cert-resend-bundle:sent",
      eventId,
      userId: session.user.id,
      recipientEmail,
      sentCount: bundle.length,
      serials: bundle.map((c) => c.serial),
      skippedCount: certs.length - bundle.length,
    });
    return NextResponse.json({
      sentCount: bundle.length,
      serials: bundle.map((c) => c.serial),
      recipientEmail,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-resend-bundle:failed", eventId });
    return NextResponse.json({ error: "Failed to resend certificates" }, { status: 500 });
  }
}
