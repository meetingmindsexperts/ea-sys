/**
 * On-demand certificate delivery service — the shared core behind the operator
 * actions the bulk cron pipeline never covered:
 *
 *   1. issueSingleCertificate() — issue a template to ONE registration/speaker
 *                                 on demand (render → create cert → email).
 *   2. reRenderAndResendCert()  — re-render an EXISTING cert from the CURRENT
 *                                 template (picks up template/greeting edits),
 *                                 update its pdfUrl, and email it again.
 *
 * Both are synchronous (fast enough for a single recipient) and share the
 * render + send internals below. The bulk "resend latest to everyone" path
 * (Phase 4) reuses `reRenderAndResendCert` per item inside a run so it can
 * batch + rate-limit against SES.
 *
 * KEY DIFFERENCE vs the per-cert resend route: that route faithfully replays
 * the FROZEN run snapshot (old PDF + old cover email). This service always
 * renders + emails from the CURRENT template, so corrections propagate. It
 * bumps reprintCount/lastReprintedAt (re-render) AND resendCount/lastResentAt
 * (re-send) — the previously-dormant reprint fields finally get used.
 *
 * Errors-as-values: returns { ok:false, code, error, status } for the caller
 * to map to an HTTP response. Owns its own audit + EmailLog (via sendEmail's
 * logContext). Never imports next/server.
 */

import { Prisma } from "@prisma/client";
import type { CertificateType } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { escapeHtml } from "@/lib/html";
import {
  sendEmail,
  wrapWithBranding,
  inlineCss,
  brandingFrom,
  type EmailBranding,
} from "@/lib/email";
import { renderCertificate } from "./render";
import { uploadCertificatePdf } from "@/lib/storage";
import {
  resolveCoverEmailTokens,
  type CoverEmailTokenContext,
} from "./email-tokens-resolver";
import { SYSTEM_DEFAULT_SUBJECT, defaultBodyForCategory } from "./email-tokens";
import {
  loadEventContext,
  loadRecipient,
  allocateSerial,
  loadPosterAbstractTitle,
} from "./cert-context";
import type { CertificateData, CertificateTemplate } from "./types";

export interface DeliverContext {
  eventId: string;
  organizationId: string;
  /** Operator who triggered it. NULL for a worker-driven bulk run with no
   *  operator (never today — the bulk route always sets one — but null keeps
   *  the audit/issuedByUserId FKs valid instead of an empty-string FK failure). */
  actorUserId: string | null;
  /** Where the request came from — written into the audit trail. */
  source: "rest" | "bulk";
}

export type DeliverSuccess = {
  ok: true;
  certificateId: string;
  serial: string;
  recipientEmail: string;
  messageId?: string;
  /** True when this issued a new cert; false for a re-render+resend. */
  issued: boolean;
};
export type DeliverFailure = { ok: false; code: string; error: string; status: number };
export type DeliverResult = DeliverSuccess | DeliverFailure;

// ── Shared internals ──────────────────────────────────────────────────────────

interface LoadedTemplate {
  category: CertificateType;
  template: CertificateTemplate;
  emailSubject: string | null;
  emailBody: string | null;
}

async function loadTemplate(eventId: string, templateId: string): Promise<LoadedTemplate | null> {
  const tmpl = await db.certificateTemplate.findFirst({
    where: { id: templateId, eventId },
    select: {
      category: true,
      backgroundPdfUrl: true,
      textBoxes: true,
      role: true,
      cmeHours: true,
      emailSubject: true,
      emailBody: true,
    },
  });
  if (!tmpl) return null;
  return {
    category: tmpl.category,
    template: {
      backgroundPdfUrl: tmpl.backgroundPdfUrl,
      textBoxes: tmpl.textBoxes as unknown as CertificateTemplate["textBoxes"],
      role: tmpl.role,
      cmeHours: tmpl.cmeHours == null ? null : Number(tmpl.cmeHours),
    },
    emailSubject: tmpl.emailSubject,
    emailBody: tmpl.emailBody,
  };
}

/** Render a cert PDF for the given recipient + template and upload it. Returns
 *  the pdfUrl, the bytes (so the caller can attach without a reload), and the
 *  recipient snapshot. Throws RECIPIENT_NOT_FOUND / EVENT_NOT_FOUND. */
async function renderAndUpload(args: {
  eventId: string;
  type: CertificateType;
  template: CertificateTemplate;
  registrationId: string | null;
  speakerId: string | null;
  serial: string;
}): Promise<{ pdfUrl: string; pdfBuffer: Buffer; recipient: CertificateData["recipient"] }> {
  const { eventId, type, template, registrationId, speakerId, serial } = args;
  const [recipient, event] = await Promise.all([
    loadRecipient(registrationId, speakerId),
    loadEventContext(eventId),
  ]);
  if (!recipient) throw new Error("RECIPIENT_NOT_FOUND");
  if (!event) throw new Error("EVENT_NOT_FOUND");

  const extras: CertificateData["extras"] =
    type === "APPRECIATION" && speakerId
      ? { type: "APPRECIATION", abstractTitle: await loadPosterAbstractTitle(speakerId, eventId) }
      : { type: "ATTENDANCE" };

  const pdfBuffer = await renderCertificate({
    type,
    serial,
    issuedAt: new Date(),
    recipient,
    event,
    extras,
    template,
  });
  const pdfUrl = await uploadCertificatePdf(pdfBuffer, `${serial}.pdf`, eventId);
  return { pdfUrl, pdfBuffer, recipient };
}

/** Live recipient email — prefers the current Attendee/Speaker record. */
async function resolveRecipientEmail(registrationId: string | null, speakerId: string | null): Promise<string | null> {
  if (registrationId) {
    const reg = await db.registration.findUnique({
      where: { id: registrationId },
      select: { attendee: { select: { email: true } } },
    });
    return reg?.attendee.email ?? null;
  }
  if (speakerId) {
    const s = await db.speaker.findUnique({ where: { id: speakerId }, select: { email: true } });
    return s?.email ?? null;
  }
  return null;
}

/** Build + send the cover email using the CURRENT template's subject/body
 *  (fallback to system default). Mirrors the worker/resend send pipeline so
 *  all cert code paths render identical emails. */
async function sendCertEmail(args: {
  eventId: string;
  type: CertificateType;
  serial: string;
  speakerId: string | null;
  registrationId: string | null;
  recipientName: string;
  recipientEmail: string;
  pdfBuffer: Buffer;
  emailSubjectTemplate: string;
  emailBodyTemplate: string;
  organizationId: string;
  triggeredByUserId: string | null;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const event = await db.event.findUnique({
    where: { id: args.eventId },
    select: {
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
  });
  if (!event) return { success: false, error: "Event not found" };

  const tokenCtx: CoverEmailTokenContext = {
    recipientName: args.recipientName,
    eventName: event.name,
    eventStartDate: event.startDate,
    eventEndDate: event.endDate,
    venue: event.venue,
    city: event.city,
    country: event.country,
    organizationName: event.organization.name,
    certificateType: args.type,
    certificateSerial: args.serial,
    speakerId: args.speakerId,
    eventId: args.eventId,
  };
  const escapedTokenCtx: CoverEmailTokenContext = {
    ...tokenCtx,
    recipientName: escapeHtml(tokenCtx.recipientName),
    eventName: escapeHtml(tokenCtx.eventName),
    organizationName: escapeHtml(tokenCtx.organizationName),
    venue: tokenCtx.venue ? escapeHtml(tokenCtx.venue) : tokenCtx.venue,
    city: tokenCtx.city ? escapeHtml(tokenCtx.city) : tokenCtx.city,
    country: tokenCtx.country ? escapeHtml(tokenCtx.country) : tokenCtx.country,
    escapeDynamic: true,
  };

  const subject = (await resolveCoverEmailTokens(args.emailSubjectTemplate, tokenCtx)).replace(/\s+/g, " ").trim();
  const bodyHtml = await resolveCoverEmailTokens(args.emailBodyTemplate, escapedTokenCtx);
  const bodyText = await resolveCoverEmailTokens(args.emailBodyTemplate, tokenCtx).then((html) =>
    html
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );

  const branding: EmailBranding = {
    emailHeaderImage: event.emailHeaderImage,
    emailFooterImage: event.emailFooterImage,
    emailFooterHtml: event.emailFooterHtml,
    emailFromAddress: event.emailFromAddress,
    emailFromName: event.emailFromName ?? event.organization.name,
    eventName: event.name,
  };
  const wrappedHtml = inlineCss(wrapWithBranding(bodyHtml, branding));

  return sendEmail({
    to: [{ email: args.recipientEmail, name: args.recipientName }],
    subject,
    htmlContent: wrappedHtml,
    textContent: bodyText,
    from: brandingFrom(branding),
    attachments: [{ name: `${args.serial}.pdf`, content: args.pdfBuffer.toString("base64"), contentType: "application/pdf" }],
    emailType: "certificate",
    logContext: {
      organizationId: args.organizationId,
      entityType: args.speakerId ? "SPEAKER" : "REGISTRATION",
      entityId: args.registrationId ?? args.speakerId ?? null,
      eventId: args.eventId,
      templateSlug: "certificate-delivery",
      triggeredByUserId: args.triggeredByUserId,
    },
  });
}

function snapshotName(snapshot: unknown): string {
  const s = (snapshot ?? {}) as { title?: string | null; firstName?: string | null; lastName?: string | null; fullName?: string | null };
  return (
    s.fullName?.trim() ||
    [s.title, s.firstName, s.lastName].filter(Boolean).join(" ").trim() ||
    "Certificate recipient"
  );
}

async function writeAudit(ctx: DeliverContext, action: string, certificateId: string, changes: Record<string, unknown>) {
  await db.auditLog
    .create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.actorUserId,
        action,
        entityType: "IssuedCertificate",
        entityId: certificateId,
        changes: { source: ctx.source, ...changes } as Prisma.InputJsonValue,
      },
    })
    .catch((err) => apiLogger.warn({ err, msg: "cert-deliver:audit-failed", certificateId }));
}

// ── Public: single-recipient issue ────────────────────────────────────────────

export async function issueSingleCertificate(
  ctx: DeliverContext,
  input: { templateId: string; registrationId?: string | null; speakerId?: string | null },
): Promise<DeliverResult> {
  const registrationId = input.registrationId ?? null;
  const speakerId = input.speakerId ?? null;
  if ((registrationId && speakerId) || (!registrationId && !speakerId)) {
    return { ok: false, code: "INVALID_RECIPIENT", error: "Provide exactly one of registrationId or speakerId.", status: 400 };
  }

  const tmpl = await loadTemplate(ctx.eventId, input.templateId);
  if (!tmpl) return { ok: false, code: "TEMPLATE_NOT_FOUND", error: "Certificate template not found.", status: 404 };

  if (tmpl.category === "ATTENDANCE" && !registrationId) {
    return { ok: false, code: "WRONG_RECIPIENT_TYPE", error: "An attendance certificate must go to a registration.", status: 400 };
  }
  if (tmpl.category === "APPRECIATION" && !speakerId) {
    return { ok: false, code: "WRONG_RECIPIENT_TYPE", error: "An appreciation certificate must go to a speaker.", status: 400 };
  }

  const recipientEmail = await resolveRecipientEmail(registrationId, speakerId);
  if (!recipientEmail) {
    return { ok: false, code: "NO_RECIPIENT_EMAIL", error: "Recipient has no email address on file.", status: 409 };
  }

  const serial = await allocateSerial(ctx.eventId, tmpl.category);

  let render: { pdfUrl: string; pdfBuffer: Buffer; recipient: CertificateData["recipient"] };
  try {
    render = await renderAndUpload({
      eventId: ctx.eventId,
      type: tmpl.category,
      template: tmpl.template,
      registrationId,
      speakerId,
      serial,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    apiLogger.error({ err, msg: "cert-deliver:render-failed", eventId: ctx.eventId, templateId: input.templateId });
    return { ok: false, code: "RENDER_FAILED", error: `Could not render the certificate (${msg}).`, status: 500 };
  }

  // Create the cert row — per-template uniqueness → 409 if they already hold it.
  let certificateId: string;
  try {
    const cert = await db.issuedCertificate.create({
      data: {
        eventId: ctx.eventId,
        registrationId,
        speakerId,
        type: tmpl.category,
        certificateTemplateId: input.templateId,
        serial,
        issuedByUserId: ctx.actorUserId,
        recipientSnapshot: render.recipient as unknown as Prisma.InputJsonValue,
        pdfUrl: render.pdfUrl,
      },
      select: { id: true },
    });
    certificateId = cert.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return {
        ok: false,
        code: "ALREADY_ISSUED",
        error: "This person already holds a certificate from this template — use “Resend latest version” instead.",
        status: 409,
      };
    }
    throw err;
  }

  const subjectTpl = tmpl.emailSubject?.trim().length ? tmpl.emailSubject : SYSTEM_DEFAULT_SUBJECT;
  const bodyTpl = tmpl.emailBody?.trim().length ? tmpl.emailBody : defaultBodyForCategory(tmpl.category);
  const send = await sendCertEmail({
    eventId: ctx.eventId,
    type: tmpl.category,
    serial,
    speakerId,
    registrationId,
    recipientName: render.recipient.fullName,
    recipientEmail,
    pdfBuffer: render.pdfBuffer,
    emailSubjectTemplate: subjectTpl,
    emailBodyTemplate: bodyTpl,
    organizationId: ctx.organizationId,
    triggeredByUserId: ctx.actorUserId,
  });

  await writeAudit(ctx, "CERT_ISSUED", certificateId, { serial, recipientEmail, sent: send.success });

  if (!send.success) {
    // The cert IS issued (rendered + stored); only the email failed. Operator
    // can Resend. Surface as a distinct error so the UI can say so.
    apiLogger.warn({ msg: "cert-deliver:issued-send-failed", eventId: ctx.eventId, certificateId, err: send.error });
    return { ok: false, code: "ISSUED_SEND_FAILED", error: "Certificate issued, but the email failed to send — use Resend.", status: 502 };
  }

  apiLogger.info({ msg: "cert-deliver:issued", eventId: ctx.eventId, certificateId, recipientEmail, messageId: send.messageId });
  return { ok: true, certificateId, serial, recipientEmail, messageId: send.messageId, issued: true };
}

// ── Public: re-render an existing cert from the current template + resend ──────

export async function reRenderAndResendCert(ctx: DeliverContext, certificateId: string): Promise<DeliverResult> {
  const cert = await db.issuedCertificate.findFirst({
    where: { id: certificateId, eventId: ctx.eventId, event: { organizationId: ctx.organizationId } },
    select: {
      id: true,
      type: true,
      serial: true,
      certificateTemplateId: true,
      registrationId: true,
      speakerId: true,
      revokedAt: true,
      recipientSnapshot: true,
    },
  });
  if (!cert) return { ok: false, code: "NOT_FOUND", error: "Certificate not found.", status: 404 };
  if (cert.revokedAt) return { ok: false, code: "CERT_REVOKED", error: "Cannot resend a revoked certificate.", status: 409 };
  if (!cert.certificateTemplateId) {
    return { ok: false, code: "NO_TEMPLATE", error: "This certificate isn’t linked to a template, so it can’t be re-rendered.", status: 409 };
  }

  const tmpl = await loadTemplate(ctx.eventId, cert.certificateTemplateId);
  if (!tmpl) return { ok: false, code: "TEMPLATE_NOT_FOUND", error: "The certificate’s template no longer exists.", status: 409 };

  const recipientEmail = await resolveRecipientEmail(cert.registrationId, cert.speakerId);
  if (!recipientEmail) return { ok: false, code: "NO_RECIPIENT_EMAIL", error: "Recipient has no email address on file.", status: 409 };

  let render: { pdfUrl: string; pdfBuffer: Buffer; recipient: CertificateData["recipient"] };
  try {
    render = await renderAndUpload({
      eventId: ctx.eventId,
      type: cert.type,
      template: tmpl.template,
      registrationId: cert.registrationId,
      speakerId: cert.speakerId,
      serial: cert.serial, // keep the same serial — same cert, fresh render
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    apiLogger.error({ err, msg: "cert-deliver:rerender-failed", eventId: ctx.eventId, certificateId });
    return { ok: false, code: "RENDER_FAILED", error: `Could not re-render the certificate (${msg}).`, status: 500 };
  }

  // Point the cert at the fresh PDF + bump the reprint counters. NOTE:
  // reprintCount counts RENDER attempts (bumped here, before the send) — so a
  // repeatedly-send-failing item increments reprintCount each retry while
  // reissueCount (bumped only on delivery, below) stays flat. That's intended:
  // reprintCount = "times re-rendered", reissueCount = "times a refreshed cert
  // was actually delivered".
  await db.issuedCertificate.update({
    where: { id: certificateId },
    data: {
      pdfUrl: render.pdfUrl,
      recipientSnapshot: render.recipient as unknown as Prisma.InputJsonValue,
      reprintCount: { increment: 1 },
      lastReprintedAt: new Date(),
    },
  });

  const recipientName = render.recipient.fullName || snapshotName(cert.recipientSnapshot);
  const subjectTpl = tmpl.emailSubject?.trim().length ? tmpl.emailSubject : SYSTEM_DEFAULT_SUBJECT;
  const bodyTpl = tmpl.emailBody?.trim().length ? tmpl.emailBody : defaultBodyForCategory(cert.type);
  const send = await sendCertEmail({
    eventId: ctx.eventId,
    type: cert.type,
    serial: cert.serial,
    speakerId: cert.speakerId,
    registrationId: cert.registrationId,
    recipientName,
    recipientEmail,
    pdfBuffer: render.pdfBuffer,
    emailSubjectTemplate: subjectTpl,
    emailBodyTemplate: bodyTpl,
    organizationId: ctx.organizationId,
    triggeredByUserId: ctx.actorUserId,
  });
  if (!send.success) {
    // Re-render succeeded (pdfUrl updated) but the email failed — don't bump
    // resendCount so a retry is the same operation. Log it (send failures are
    // operationally important — surface, don't swallow).
    apiLogger.warn({ msg: "cert-deliver:reissue-send-failed", eventId: ctx.eventId, certificateId, recipientEmail, err: send.error });
    return { ok: false, code: "SEND_FAILED", error: send.error ?? "Email send failed.", status: 502 };
  }

  await db.issuedCertificate.update({
    where: { id: certificateId },
    data: {
      resendCount: { increment: 1 },
      lastResentAt: new Date(),
      // Dedicated reissue counter — the clean "refreshed cert delivered" metric.
      reissueCount: { increment: 1 },
      lastReissuedAt: new Date(),
    },
  });
  await writeAudit(ctx, "CERT_REISSUED", certificateId, { serial: cert.serial, recipientEmail });

  apiLogger.info({ msg: "cert-deliver:reissued", eventId: ctx.eventId, certificateId, recipientEmail, messageId: send.messageId });
  return { ok: true, certificateId, serial: cert.serial, recipientEmail, messageId: send.messageId, issued: false };
}
