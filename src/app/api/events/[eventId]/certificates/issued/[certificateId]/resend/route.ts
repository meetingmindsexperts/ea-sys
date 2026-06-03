/**
 * POST /api/events/[eventId]/certificates/issued/[certificateId]/resend
 *
 * Re-fires the delivery email for one already-issued certificate. Uses
 * the EXISTING pdfUrl (no re-render) and the cover-email snapshot from
 * the original CertificateIssueRun row (no template re-fetch) so the
 * resend is a faithful replay of what the recipient would have received
 * the first time. If the run's email snapshot is missing (legacy cert
 * issued before the cover-email editor), falls back to the same system
 * defaults the cron worker uses.
 *
 * Bumps IssuedCertificate.resendCount + lastResentAt atomically AFTER
 * the email is accepted by SES, so a failed send doesn't poison the
 * counter (you can hit Resend again, no skew).
 *
 * Auth: ADMIN / ORGANIZER (denyReviewer). Org-bound via the event
 * (404 on cross-tenant — non-enumeration).
 *
 * Rate limit: 30/hr/user on `cert-resend:${userId}` — covers a
 * reasonable cleanup-after-event cadence without making accidental
 * spam loops cheap.
 *
 * Side effects:
 *  1. EmailLog row written by sendEmail() via shared logContext
 *     (entityType + entityId + eventId + emailType: "certificate") —
 *     surfaces on the EmailLogCard on the same detail sheet for free.
 *  2. apiLogger.info("cert-resend:ok") for the audit trail.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import {
  sendEmail,
  wrapWithBranding,
  inlineCss,
  brandingFrom,
  type EmailBranding,
} from "@/lib/email";
import {
  resolveCoverEmailTokens,
  type CoverEmailTokenContext,
} from "@/lib/certificates/email-tokens-resolver";
import {
  SYSTEM_DEFAULT_SUBJECT,
  defaultBodyForCategory,
} from "@/lib/certificates/email-tokens";

interface RouteParams {
  params: Promise<{ eventId: string; certificateId: string }>;
}

/**
 * Local copy of the HTML-escape helper used by the issue worker. Same
 * five-replace pattern. Duplicated rather than refactored shared
 * because (a) keeping the resend route self-contained avoids touching
 * the worker mid-feature, and (b) email.ts's private helper is
 * intentionally not exported.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Read PDF bytes from local disk OR remote URL. Mirrors the worker's
 *  loadPdfBytes — local files served directly from public/ on EC2;
 *  Supabase / absolute URLs fetched. */
async function loadPdfBytes(pdfUrl: string): Promise<Buffer> {
  if (pdfUrl.startsWith("/uploads/")) {
    const { readFile } = await import("fs/promises");
    const { join } = await import("path");
    return readFile(join(process.cwd(), "public", pdfUrl));
  }
  const res = await fetch(pdfUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch PDF: HTTP ${res.status} ${pdfUrl}`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

export async function POST(_req: Request, { params }: RouteParams) {
  let eventId: string | undefined;
  let certificateId: string | undefined;
  try {
    const [session, p] = await Promise.all([auth(), params]);
    eventId = p.eventId;
    certificateId = p.certificateId;
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;
    if (!session.user.organizationId) {
      apiLogger.warn({
        msg: "cert-resend:no-org",
        userId: session.user.id,
        eventId,
        certificateId,
      });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Rate limit per user — abuse-floor, not per-event because a single
    // operator cleaning up across multiple events still shouldn't be
    // able to dump hundreds of resends in a minute.
    const rl = checkRateLimit({
      key: `cert-resend:${session.user.id}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      apiLogger.warn({
        msg: "cert-resend:rate-limited",
        userId: session.user.id,
        eventId,
        certificateId,
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

    // Load cert + run + event in one query each. Bind to org via the
    // event relation — cross-tenant resolves to 404 not 403 to avoid
    // resource enumeration.
    const cert = await db.issuedCertificate.findFirst({
      where: {
        id: certificateId,
        event: { organizationId: session.user.organizationId },
      },
      include: {
        // The linked CertificateIssueRunItem points at the run that
        // produced this cert. Run row carries the cover-email
        // snapshot the recipient saw originally; fall back to system
        // defaults when null (legacy cert from before the cover-email
        // editor existed).
        issueRunItem: {
          select: {
            runId: true,
            run: {
              select: { emailSubject: true, emailBody: true },
            },
          },
        },
        event: {
          select: {
            id: true,
            name: true,
            startDate: true,
            endDate: true,
            venue: true,
            city: true,
            country: true,
            emailHeaderImage: true,
            emailFooterImage: true,
            emailFooterHtml: true,
            emailFromAddress: true,
            emailFromName: true,
            organization: { select: { name: true } },
          },
        },
      },
    });

    if (!cert || cert.eventId !== eventId) {
      apiLogger.warn({
        msg: "cert-resend:not-found-or-cross-tenant",
        eventId,
        certificateId,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "Certificate not found" },
        { status: 404 },
      );
    }

    if (cert.revokedAt) {
      // Don't resend a revoked cert — that'd undo the revocation in the
      // recipient's eyes.
      return NextResponse.json(
        {
          error: "Cannot resend a revoked certificate",
          code: "CERT_REVOKED",
          revokedAt: cert.revokedAt,
          revocationReason: cert.revocationReason,
        },
        { status: 409 },
      );
    }

    if (!cert.pdfUrl) {
      // Cert was issued but the render never completed (broken run, or
      // the worker crashed mid-render). Resending makes no sense — no
      // PDF to attach. Operator should re-issue, not resend.
      apiLogger.warn({
        msg: "cert-resend:no-pdf",
        eventId,
        certificateId,
        userId: session.user.id,
      });
      return NextResponse.json(
        {
          error: "Certificate has no rendered PDF yet — wait for the render to complete, or re-issue.",
          code: "PDF_NOT_RENDERED",
        },
        { status: 409 },
      );
    }

    // Resolve recipient name + email from the snapshot stored at issue
    // time. The snapshot survives a Registration row edit, so resend
    // always uses the name as it appeared on the cert. Email is on the
    // recipient relation since IssuedCertificate doesn't snapshot it.
    type RecipientSnapshot = {
      title?: string | null;
      firstName?: string | null;
      lastName?: string | null;
      fullName?: string | null;
    };
    const snapshot = (cert.recipientSnapshot as RecipientSnapshot | null) ?? {};
    const recipientName =
      snapshot.fullName?.trim()
      || [snapshot.title, snapshot.firstName, snapshot.lastName].filter(Boolean).join(" ").trim()
      || "Certificate recipient";

    // Look up the current email — fall back to attendee/speaker.
    // Strong preference for the live record so the resend goes to the
    // address that's actually monitored today, not whatever was on file
    // 6 months ago.
    let recipientEmail: string | null = null;
    if (cert.registrationId) {
      const reg = await db.registration.findUnique({
        where: { id: cert.registrationId },
        select: { attendee: { select: { email: true } } },
      });
      recipientEmail = reg?.attendee.email ?? null;
    } else if (cert.speakerId) {
      const speaker = await db.speaker.findUnique({
        where: { id: cert.speakerId },
        select: { email: true },
      });
      recipientEmail = speaker?.email ?? null;
    }

    if (!recipientEmail) {
      apiLogger.warn({
        msg: "cert-resend:no-recipient-email",
        eventId,
        certificateId,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "Recipient has no email address on file" },
        { status: 409 },
      );
    }

    // Load the PDF — local disk OR remote URL. Cross-machine pattern
    // (file uploaded on local dev, resend fired on prod) surfaces here
    // with a clear error so the operator knows to re-upload, not
    // re-issue.
    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await loadPdfBytes(cert.pdfUrl);
    } catch (e) {
      apiLogger.warn({
        msg: "cert-resend:pdf-load-failed",
        eventId,
        certificateId,
        pdfUrl: cert.pdfUrl,
        err: e instanceof Error ? e.message : String(e),
      });
      return NextResponse.json(
        {
          error: "The certificate PDF could not be loaded. It may have been moved or deleted. Re-issue the certificate.",
          code: "PDF_MISSING",
        },
        { status: 409 },
      );
    }

    // Pull the cover-email snapshot from the run. Snapshot semantics
    // are the whole point of resend — what the recipient would have
    // received originally. Legacy certs (no run, or null snapshot)
    // fall back to the system default for the cert's category.
    const run = cert.issueRunItem?.run ?? null;
    const emailSubjectTemplate =
      run?.emailSubject?.trim().length ? run.emailSubject : SYSTEM_DEFAULT_SUBJECT;
    const emailBodyTemplate =
      run?.emailBody?.trim().length ? run.emailBody : defaultBodyForCategory(cert.type);

    // Build token context — same shape the worker uses, including the
    // speakerId for {{abstractTitle}} resolution on APPRECIATION certs.
    const tokenCtx: CoverEmailTokenContext = {
      recipientName,
      eventName: cert.event.name,
      eventStartDate: cert.event.startDate,
      eventEndDate: cert.event.endDate,
      venue: cert.event.venue,
      city: cert.event.city,
      country: cert.event.country,
      organizationName: cert.event.organization.name,
      certificateType: cert.type,
      certificateSerial: cert.serial,
      speakerId: cert.speakerId,
      eventId,
    };
    const escapedTokenCtx: CoverEmailTokenContext = {
      ...tokenCtx,
      recipientName: escapeHtml(tokenCtx.recipientName),
      eventName: escapeHtml(tokenCtx.eventName),
      organizationName: escapeHtml(tokenCtx.organizationName),
      venue: tokenCtx.venue ? escapeHtml(tokenCtx.venue) : tokenCtx.venue,
      city: tokenCtx.city ? escapeHtml(tokenCtx.city) : tokenCtx.city,
      country: tokenCtx.country ? escapeHtml(tokenCtx.country) : tokenCtx.country,
    };

    const subject = (
      await resolveCoverEmailTokens(emailSubjectTemplate, tokenCtx)
    ).replace(/\s+/g, " ").trim();
    const bodyHtml = await resolveCoverEmailTokens(emailBodyTemplate, escapedTokenCtx);
    const bodyText = await resolveCoverEmailTokens(emailBodyTemplate, tokenCtx)
      .then((html) =>
        html
          .replace(/<\s*br\s*\/?>/gi, "\n")
          .replace(/<\/p>/gi, "\n\n")
          .replace(/<[^>]+>/g, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim(),
      );

    // Apply the per-event branding pipeline — header image, footer
    // HTML, footer image, sender override, CSS inlining. Same shape
    // the worker uses; if you change branding here, change it there.
    const branding: EmailBranding = {
      emailHeaderImage: cert.event.emailHeaderImage,
      emailFooterImage: cert.event.emailFooterImage,
      emailFooterHtml: cert.event.emailFooterHtml,
      emailFromAddress: cert.event.emailFromAddress,
      emailFromName: cert.event.emailFromName ?? cert.event.organization.name,
      eventName: cert.event.name,
    };
    const wrappedHtml = inlineCss(wrapWithBranding(bodyHtml, branding));

    const sendResult = await sendEmail({
      to: [{ email: recipientEmail, name: recipientName }],
      subject,
      htmlContent: wrappedHtml,
      textContent: bodyText,
      from: brandingFrom(branding),
      attachments: [
        {
          name: `${cert.serial}.pdf`,
          content: pdfBuffer.toString("base64"),
          contentType: "application/pdf",
        },
      ],
      emailType: "certificate",
      logContext: {
        // The EmailLogCard on the registration/speaker detail sheet
        // queries on (entityType, entityId), so threading the right
        // ids here is what makes the resend show up on the same sheet
        // it was triggered from.
        entityType: cert.speakerId ? "SPEAKER" : "REGISTRATION",
        entityId: cert.registrationId ?? cert.speakerId ?? null,
        eventId,
        // Match the cron worker's slug so the resend row gets the
        // same "Certificate" pill in the EmailLogCard. Both code paths
        // must agree or organizers see two visually-different rows
        // for the same logical action.
        templateSlug: "certificate-delivery",
        triggeredByUserId: session.user.id,
      },
    });

    if (!sendResult.success) {
      // Email send failed — DON'T bump the counter, so the operator's
      // next click is the same operation again, not a misleading
      // "second resend".
      apiLogger.warn({
        msg: "cert-resend:send-failed",
        eventId,
        certificateId,
        userId: session.user.id,
        err: sendResult.error,
      });
      return NextResponse.json(
        {
          error: sendResult.error ?? "Email send failed",
          code: "SEND_FAILED",
        },
        { status: 502 },
      );
    }

    // Send succeeded — bump the counter + timestamp.
    const updated = await db.issuedCertificate.update({
      where: { id: certificateId },
      data: {
        resendCount: { increment: 1 },
        lastResentAt: new Date(),
      },
      select: { resendCount: true, lastResentAt: true },
    });

    apiLogger.info({
      msg: "cert-resend:ok",
      eventId,
      certificateId,
      userId: session.user.id,
      recipientEmail,
      newResendCount: updated.resendCount,
      emailMessageId: sendResult.messageId,
    });

    return NextResponse.json({
      ok: true,
      emailMessageId: sendResult.messageId,
      resendCount: updated.resendCount,
      lastResentAt: updated.lastResentAt,
    });
  } catch (error) {
    apiLogger.error({
      err: error,
      msg: "cert-resend:failed",
      eventId,
      certificateId,
    });
    return NextResponse.json(
      { error: "Failed to resend certificate" },
      { status: 500 },
    );
  }
}
