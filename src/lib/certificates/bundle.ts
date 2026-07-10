/**
 * Certificate bundle core — the SHARED lower layer behind every path that
 * issues or emails certificates (multi-cert-per-email feature, 2026-07-09):
 *
 *   findOrIssueCertificate()      — idempotent "get this person's cert from
 *                                   this template": reuses an existing cert's
 *                                   PDF (same serial, no duplicate record),
 *                                   repairs a missing PDF by re-rendering with
 *                                   the SAME serial, or issues a fresh cert
 *                                   (serial + render + upload + record).
 *   sendCertificateBundleEmail()  — ONE cover email carrying 1..N certificate
 *                                   PDFs as attachments. Owns token resolution
 *                                   (incl. the {{certificateList}} bundle
 *                                   token), the branding pipeline, and the
 *                                   EmailLog logContext.
 *
 * Layering: deliver.ts, issue-worker.ts, bulk-issue.ts and auto-issue.ts all
 * import from HERE — this module never imports any of them (no cycles). The
 * render/recipient primitives it composes live in cert-context.ts / render.ts
 * / storage.ts, mirroring the existing extraction pattern.
 *
 * Errors-as-values on findOrIssueCertificate; sendCertificateBundleEmail
 * returns sendEmail's { success, messageId?, error? } shape. Callers own
 * marking emailedAt / counters / audit rows. Never imports next/server.
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
  getEventTemplate,
  type EmailBranding,
} from "@/lib/email";
import { renderCertificate } from "./render";
import { uploadCertificatePdf } from "@/lib/storage";
import { loadCertificatePdfBytes } from "./pdf-loader";
import {
  resolveCoverEmailTokens,
  type CoverEmailTokenContext,
} from "./email-tokens-resolver";
import {
  SYSTEM_DEFAULT_SUBJECT,
  SYSTEM_DEFAULT_SUBJECT_MULTI,
  SYSTEM_DEFAULT_BODY_MULTI,
  CERT_BUNDLE_COVER_TEMPLATE_SLUG,
  defaultBodyForCategory,
} from "./email-tokens";
import {
  loadEventContext,
  loadRecipient,
  allocateSerial,
  loadPosterAbstractTitle,
  type EventContext,
} from "./cert-context";
import { resolveLinkedRegistration, resolveLinkedSpeaker } from "@/lib/activity-feed";
import type { Prisma as PrismaTypes } from "@prisma/client";
import type { CertificateData, CertificateTemplate } from "./types";

// SES rejects messages over 10MB raw; base64 inflates ~4/3, so cap the
// combined PDF payload well below that. Overlay-model cert PDFs are
// normally well under 1MB each — hitting this means something is wrong
// with the background PDF, not a legitimate bundle.
const MAX_BUNDLE_ATTACHMENT_BYTES = 8 * 1024 * 1024;

// ── Template loading ─────────────────────────────────────────────────────────

export interface LoadedCertTemplate {
  id: string;
  name: string;
  category: CertificateType;
  /** The template's tag — decides WHO receives this certificate on every
   *  issue path (manual, bulk email, survey auto-issue). Column is named
   *  autoIssueTag for historical reasons; the meaning is general. */
  autoIssueTag: string | null;
  template: CertificateTemplate;
  emailSubject: string | null;
  emailBody: string | null;
}

export async function loadCertTemplate(
  eventId: string,
  templateId: string,
): Promise<LoadedCertTemplate | null> {
  const tmpl = await db.certificateTemplate.findFirst({
    where: { id: templateId, eventId },
    select: {
      id: true,
      name: true,
      category: true,
      autoIssueTag: true,
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
    id: tmpl.id,
    name: tmpl.name,
    category: tmpl.category,
    autoIssueTag: tmpl.autoIssueTag,
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

// ── Render + upload ──────────────────────────────────────────────────────────

export interface RenderAndUploadResult {
  pdfUrl: string;
  pdfBuffer: Buffer;
  recipient: CertificateData["recipient"];
  event: EventContext;
}

/** Render a cert PDF for the given recipient + template and upload it.
 *  Throws RECIPIENT_NOT_FOUND / EVENT_NOT_FOUND (message-coded). */
export async function renderAndUpload(args: {
  eventId: string;
  type: CertificateType;
  template: CertificateTemplate;
  registrationId: string | null;
  speakerId: string | null;
  serial: string;
}): Promise<RenderAndUploadResult> {
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
  return { pdfUrl, pdfBuffer, recipient, event };
}

/** Live recipient email — prefers the current Attendee/Speaker record. */
export async function resolveRecipientEmail(
  registrationId: string | null,
  speakerId: string | null,
): Promise<string | null> {
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

// ── Find-or-issue ────────────────────────────────────────────────────────────

export interface BundleCert {
  certificateId: string;
  serial: string;
  type: CertificateType;
  templateName: string;
  pdfBuffer: Buffer;
  /** True when an already-issued cert was reused (its record + serial were
   *  kept; the PDF may still have been re-rendered if it had gone missing). */
  reused: boolean;
}

export type FindOrIssueResult =
  | { ok: true; cert: BundleCert }
  | {
      ok: false;
      code:
        | "TEMPLATE_NOT_FOUND"
        | "WRONG_RECIPIENT_TYPE"
        | "RECIPIENT_NOT_FOUND"
        | "RENDER_FAILED"
        | "CERT_REVOKED";
      error: string;
    };

/**
 * Idempotent per-(template, person) certificate materialization.
 *
 * Callers may pass BOTH facet ids of a person (registrationId + linked
 * speakerId); the template's category picks the one that applies —
 * ATTENDANCE certs key on the registration, APPRECIATION on the speaker.
 * Missing the required facet → WRONG_RECIPIENT_TYPE.
 *
 * Reuse rules (confirmed product decisions):
 *   - cert exists + PDF loads      → attach the existing PDF, same serial.
 *   - cert exists + PDF missing    → re-render with the SAME serial, repair
 *                                    pdfUrl (bumps reprintCount — "times
 *                                    re-rendered", consistent with reissue).
 *   - cert exists + revoked        → CERT_REVOKED (never silently re-send a
 *                                    revoked cert).
 *   - no cert                      → allocate serial, render, upload, create;
 *                                    a P2002 race resolves to the winner row.
 */
export async function findOrIssueCertificate(args: {
  eventId: string;
  templateId: string;
  registrationId: string | null;
  speakerId: string | null;
  issuedByUserId: string | null;
  /** Pre-loaded template (batch callers) — skips the per-call lookup. */
  template?: LoadedCertTemplate | null;
  /** Run item that PRODUCED this cert (worker path) — stamped on the cert's
   *  issueRunItemId at CREATE only, as provenance. A REUSED cert keeps its
   *  original pointer: the send phase recomputes each item's cert set
   *  deterministically from (item.templateIds × item facets), so re-pointing
   *  is unnecessary — and would steal the cert out of another in-flight
   *  run's bundle (review finding, 2026-07-10). */
  issueRunItemId?: string | null;
}): Promise<FindOrIssueResult> {
  const tmpl = args.template ?? (await loadCertTemplate(args.eventId, args.templateId));
  if (!tmpl) {
    return { ok: false, code: "TEMPLATE_NOT_FOUND", error: "Certificate template not found." };
  }

  // Category picks the facet; the other id is nulled on the cert row so the
  // per-template uniqueness keys stay single-facet (matches every existing row).
  const registrationId = tmpl.category === "ATTENDANCE" ? args.registrationId : null;
  const speakerId = tmpl.category === "APPRECIATION" ? args.speakerId : null;
  if (!registrationId && !speakerId) {
    return {
      ok: false,
      code: "WRONG_RECIPIENT_TYPE",
      error:
        tmpl.category === "ATTENDANCE"
          ? "An attendance certificate must go to a registration."
          : "An appreciation certificate must go to a speaker.",
    };
  }

  const recipientWhere = registrationId ? { registrationId } : { speakerId };
  const existing = await db.issuedCertificate.findFirst({
    where: { eventId: args.eventId, certificateTemplateId: args.templateId, ...recipientWhere },
    select: { id: true, serial: true, pdfUrl: true, revokedAt: true },
  });
  if (existing) {
    return reuseExistingCert(args.eventId, tmpl, registrationId, speakerId, existing);
  }

  const serial = await allocateSerial(args.eventId, tmpl.category);
  let render: RenderAndUploadResult;
  try {
    render = await renderAndUpload({
      eventId: args.eventId,
      type: tmpl.category,
      template: tmpl.template,
      registrationId,
      speakerId,
      serial,
    });
  } catch (err) {
    return renderFailure(err, args.eventId, args.templateId);
  }

  try {
    const cert = await db.issuedCertificate.create({
      data: {
        eventId: args.eventId,
        registrationId,
        speakerId,
        type: tmpl.category,
        certificateTemplateId: args.templateId,
        serial,
        issuedByUserId: args.issuedByUserId,
        issueRunItemId: args.issueRunItemId ?? null,
        recipientSnapshot: render.recipient as unknown as Prisma.InputJsonValue,
        cmeHoursSnapshot: tmpl.template.cmeHours ?? render.event.cmeHours ?? null,
        pdfUrl: render.pdfUrl,
      },
      select: { id: true },
    });
    return {
      ok: true,
      cert: {
        certificateId: cert.id,
        serial,
        type: tmpl.category,
        templateName: tmpl.name,
        pdfBuffer: render.pdfBuffer,
        reused: false,
      },
    };
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
    // Concurrent issue from another path won the race — reuse the winner row
    // (its serial is the authoritative one; our fresh render is discarded).
    const winner = await db.issuedCertificate.findFirst({
      where: { eventId: args.eventId, certificateTemplateId: args.templateId, ...recipientWhere },
      select: { id: true, serial: true, pdfUrl: true, revokedAt: true },
    });
    if (!winner) throw err;
    apiLogger.info({
      msg: "cert-bundle:dedupe-race-winner",
      eventId: args.eventId,
      templateId: args.templateId,
      certificateId: winner.id,
    });
    return reuseExistingCert(args.eventId, tmpl, registrationId, speakerId, winner);
  }
}

/** Reuse an already-issued cert: load its PDF, or repair it by re-rendering
 *  with the SAME serial when the PDF is missing/unloadable. The cert's
 *  issueRunItemId provenance pointer is deliberately left untouched — the
 *  worker's send phase recomputes delivery sets from item.templateIds, so
 *  a reuse never steals the cert out of another run's bundle. */
async function reuseExistingCert(
  eventId: string,
  tmpl: LoadedCertTemplate,
  registrationId: string | null,
  speakerId: string | null,
  existing: { id: string; serial: string; pdfUrl: string | null; revokedAt: Date | null },
): Promise<FindOrIssueResult> {
  if (existing.revokedAt) {
    apiLogger.warn({
      msg: "cert-bundle:revoked-skip",
      eventId,
      certificateId: existing.id,
      serial: existing.serial,
    });
    return {
      ok: false,
      code: "CERT_REVOKED",
      error: `Certificate ${existing.serial} is revoked and cannot be re-sent.`,
    };
  }

  if (existing.pdfUrl) {
    try {
      const pdfBuffer = await loadCertificatePdfBytes(existing.pdfUrl, {
        eventId,
        certificateId: existing.id,
      });
      return {
        ok: true,
        cert: {
          certificateId: existing.id,
          serial: existing.serial,
          type: tmpl.category,
          templateName: tmpl.name,
          pdfBuffer,
          reused: true,
        },
      };
    } catch (err) {
      apiLogger.warn({
        err,
        msg: "cert-bundle:rerender-missing-pdf",
        eventId,
        certificateId: existing.id,
        pdfUrl: existing.pdfUrl,
        hint: "Existing cert PDF unloadable — re-rendering with the same serial.",
      });
    }
  } else {
    apiLogger.info({
      msg: "cert-bundle:rerender-missing-pdf",
      eventId,
      certificateId: existing.id,
      hint: "Existing cert has no pdfUrl — re-rendering with the same serial.",
    });
  }

  let render: RenderAndUploadResult;
  try {
    render = await renderAndUpload({
      eventId,
      type: tmpl.category,
      template: tmpl.template,
      registrationId,
      speakerId,
      serial: existing.serial,
    });
  } catch (err) {
    return renderFailure(err, eventId, tmpl.id);
  }
  await db.issuedCertificate.update({
    where: { id: existing.id },
    data: {
      pdfUrl: render.pdfUrl,
      recipientSnapshot: render.recipient as unknown as Prisma.InputJsonValue,
      reprintCount: { increment: 1 },
      lastReprintedAt: new Date(),
    },
  });
  return {
    ok: true,
    cert: {
      certificateId: existing.id,
      serial: existing.serial,
      type: tmpl.category,
      templateName: tmpl.name,
      pdfBuffer: render.pdfBuffer,
      reused: true,
    },
  };
}

function renderFailure(err: unknown, eventId: string, templateId: string): FindOrIssueResult {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === "RECIPIENT_NOT_FOUND") {
    apiLogger.warn({ msg: "cert-bundle:recipient-not-found", eventId, templateId });
    return { ok: false, code: "RECIPIENT_NOT_FOUND", error: "Certificate recipient not found." };
  }
  apiLogger.error({ err, msg: "cert-bundle:render-failed", eventId, templateId });
  return { ok: false, code: "RENDER_FAILED", error: `Could not render the certificate (${msg}).` };
}

// ── Person cert-set resolution ───────────────────────────────────────────────

/**
 * Where-clause covering EVERY cert the PERSON behind one facet holds —
 * the anchored registration/speaker plus its linked counterpart (companion
 * pointer, else email match). Shared by the issued-list GET and the
 * resend-bundle route so both agree on "the same person's" cert set.
 * Returns the resolved counterpart too so callers can log/anchor on it.
 */
export async function buildPersonCertificateWhere(
  eventId: string,
  registrationId: string | null,
  speakerId: string | null,
): Promise<{
  where: PrismaTypes.IssuedCertificateWhereInput;
  linkedRegistrationId: string | null;
  linkedSpeakerId: string | null;
}> {
  if (registrationId) {
    const reg = await db.registration.findFirst({
      where: { id: registrationId, eventId },
      select: { attendee: { select: { email: true } } },
    });
    const linkedSpeaker = await resolveLinkedSpeaker(eventId, {
      id: registrationId,
      attendeeEmail: reg?.attendee?.email ?? null,
    });
    return {
      where: {
        eventId,
        OR: [
          { registrationId },
          ...(linkedSpeaker ? [{ speakerId: linkedSpeaker.id }] : []),
        ],
      },
      linkedRegistrationId: registrationId,
      linkedSpeakerId: linkedSpeaker?.id ?? null,
    };
  }
  const spk = await db.speaker.findFirst({
    where: { id: speakerId!, eventId },
    select: { sourceRegistrationId: true, email: true },
  });
  const linkedReg = spk ? await resolveLinkedRegistration(eventId, spk) : null;
  return {
    where: {
      eventId,
      OR: [
        { speakerId: speakerId! },
        ...(linkedReg ? [{ registrationId: linkedReg.id }] : []),
      ],
    },
    linkedRegistrationId: linkedReg?.id ?? null,
    linkedSpeakerId: speakerId,
  };
}

// ── Bundle email ─────────────────────────────────────────────────────────────

export interface BundleEmailCert {
  serial: string;
  type: CertificateType;
  templateName: string;
  pdfBuffer: Buffer;
}

export interface BundleEmailEvent {
  name: string;
  startDate: Date;
  endDate: Date;
  venue: string | null;
  city: string | null;
  country: string | null;
  emailHeaderImage: string | null;
  emailFooterImage: string | null;
  emailFooterHtml: string | null;
  emailFromAddress: string | null;
  emailFromName: string | null;
  organization: { name: string };
}

/**
 * The event's EDITABLE bundle cover email — the `certificate-bundle-delivery`
 * EmailTemplate (Communications → Email Templates). `getEventTemplate` falls
 * back to the seeded system default (identical content to the
 * SYSTEM_DEFAULT_*_MULTI constants), so this only returns null on a genuine
 * lookup failure — callers then fall back to the hardcoded constants.
 * Applies to sends carrying 2+ certs; single-cert sends keep the certificate
 * template's own saved cover.
 */
export async function loadBundleCoverEmailTemplate(
  eventId: string,
): Promise<{ subject: string; body: string } | null> {
  try {
    const tpl = await getEventTemplate(eventId, CERT_BUNDLE_COVER_TEMPLATE_SLUG);
    if (!tpl) return null;
    return { subject: tpl.subject, body: tpl.htmlContent };
  } catch (err) {
    apiLogger.warn({
      err,
      msg: "cert-bundle:cover-template-load-failed",
      eventId,
      hint: "Falling back to the hardcoded bundle cover-email default.",
    });
    return null;
  }
}

/** The event fields the bundle email needs — batch callers load this once
 *  per batch and pass it in; single-recipient callers let the sender load. */
export async function loadBundleEmailEvent(eventId: string): Promise<BundleEmailEvent | null> {
  return db.event.findUnique({
    where: { id: eventId },
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
}

/**
 * Render the cover email CONTENT for a bundle send — subject, branded
 * wrapped HTML, and the plain-text body — WITHOUT sending anything. The
 * exact pipeline the send below uses, factored out so the preview-before-
 * resend endpoints show byte-identical content to what would go out
 * (2026-07-10, "preview before resend" organizer request). PDFs are not
 * needed here: only the certs' serial/type/templateName drive the tokens.
 */
export async function renderBundleEmailContent(args: {
  eventId: string;
  recipientName: string;
  recipientFirstName?: string | null;
  recipientLastName?: string | null;
  /** Speaker id when the bundle carries an APPRECIATION cert — drives the
   *  {{abstractTitle}} lookup. */
  speakerId: string | null;
  certs: Array<{ serial: string; type: CertificateType; templateName?: string | null }>;
  emailSubjectTemplate: string;
  emailBodyTemplate: string;
  event: BundleEmailEvent;
}): Promise<{ subject: string; wrappedHtml: string; bodyText: string; branding: EmailBranding }> {
  const { event } = args;
  const primary = args.certs[0];
  const bundle = {
    certs: args.certs.map((c) => ({ serial: c.serial, type: c.type, templateName: c.templateName })),
  };
  const tokenCtx: CoverEmailTokenContext = {
    recipientName: args.recipientName,
    firstName: args.recipientFirstName,
    lastName: args.recipientLastName,
    eventName: event.name,
    eventStartDate: event.startDate,
    eventEndDate: event.endDate,
    venue: event.venue,
    city: event.city,
    country: event.country,
    organizationName: event.organization.name,
    certificateType: primary.type,
    certificateSerial: primary.serial,
    speakerId: args.speakerId,
    eventId: args.eventId,
    bundle,
  };
  const escapedTokenCtx: CoverEmailTokenContext = {
    ...tokenCtx,
    recipientName: escapeHtml(tokenCtx.recipientName),
    firstName: tokenCtx.firstName ? escapeHtml(tokenCtx.firstName) : tokenCtx.firstName,
    lastName: tokenCtx.lastName ? escapeHtml(tokenCtx.lastName) : tokenCtx.lastName,
    eventName: escapeHtml(tokenCtx.eventName),
    organizationName: escapeHtml(tokenCtx.organizationName),
    venue: tokenCtx.venue ? escapeHtml(tokenCtx.venue) : tokenCtx.venue,
    city: tokenCtx.city ? escapeHtml(tokenCtx.city) : tokenCtx.city,
    country: tokenCtx.country ? escapeHtml(tokenCtx.country) : tokenCtx.country,
    // Resolver-internal dynamic values (abstractTitle, bundle templateName)
    // are escaped inside the resolver on the HTML-body path.
    escapeDynamic: true,
  };

  const subject = (await resolveCoverEmailTokens(args.emailSubjectTemplate, tokenCtx))
    .replace(/\s+/g, " ")
    .trim();
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
  return { subject, wrappedHtml, bodyText, branding };
}

/**
 * Send ONE cover email carrying 1..N certificate PDFs. The single-cert case
 * renders byte-identically to the historical per-cert email (the bundle
 * token context collapses to the old singular tokens).
 */
export async function sendCertificateBundleEmail(args: {
  eventId: string;
  organizationId: string | null;
  recipientEmail: string;
  recipientName: string;
  /** Split name parts — back the {{firstName}}/{{lastName}} cover-email
   *  tokens (saved email templates reused as covers). Optional: the manual
   *  Issue worker snapshots only the full recipientName. */
  recipientFirstName?: string | null;
  recipientLastName?: string | null;
  registrationId: string | null;
  speakerId: string | null;
  certs: BundleEmailCert[];
  emailSubjectTemplate: string;
  emailBodyTemplate: string;
  triggeredByUserId: string | null;
  /** Pre-loaded event (batch callers) — skips the per-recipient lookup. */
  event?: BundleEmailEvent | null;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (args.certs.length === 0) {
    apiLogger.warn({ msg: "cert-bundle:empty-send", eventId: args.eventId, recipientEmail: args.recipientEmail });
    return { success: false, error: "No certificates to send." };
  }
  const totalBytes = args.certs.reduce((sum, c) => sum + c.pdfBuffer.length, 0);
  if (totalBytes > MAX_BUNDLE_ATTACHMENT_BYTES) {
    apiLogger.warn({
      msg: "cert-bundle:attachments-too-large",
      eventId: args.eventId,
      recipientEmail: args.recipientEmail,
      totalBytes,
      certCount: args.certs.length,
    });
    return {
      success: false,
      error: `Combined certificate attachments are too large to email (${Math.round(totalBytes / 1024 / 1024)}MB).`,
    };
  }

  const event = args.event ?? (await loadBundleEmailEvent(args.eventId));
  if (!event) return { success: false, error: "Event not found" };

  const { subject, wrappedHtml, bodyText, branding } = await renderBundleEmailContent({
    eventId: args.eventId,
    recipientName: args.recipientName,
    recipientFirstName: args.recipientFirstName,
    recipientLastName: args.recipientLastName,
    speakerId: args.speakerId,
    certs: args.certs,
    emailSubjectTemplate: args.emailSubjectTemplate,
    emailBodyTemplate: args.emailBodyTemplate,
    event,
  });

  // EmailLog anchor: prefer the SPEAKER facet whenever the bundle carries an
  // APPRECIATION (speaker) cert — the speaker detail sheet's Email History
  // queries strictly by SPEAKER, and pre-bundle sends attributed speaker
  // certs there. Pure-attendance bundles anchor on the registration.
  const speakerAnchored =
    Boolean(args.speakerId) &&
    (args.certs.some((c) => c.type === "APPRECIATION") || !args.registrationId);
  return sendEmail({
    to: [{ email: args.recipientEmail, name: args.recipientName }],
    subject,
    htmlContent: wrappedHtml,
    textContent: bodyText,
    from: brandingFrom(branding),
    attachments: args.certs.map((c) => ({
      name: `${c.serial}.pdf`,
      content: c.pdfBuffer.toString("base64"),
      contentType: "application/pdf",
    })),
    emailType: "certificate",
    logContext: {
      organizationId: args.organizationId,
      entityType: speakerAnchored ? "SPEAKER" : "REGISTRATION",
      entityId: speakerAnchored ? args.speakerId : args.registrationId ?? args.speakerId ?? null,
      eventId: args.eventId,
      // templateSlug doubles as a discriminator on the EmailLogCard — the
      // amber "Certificate" pill keys off this slug regardless of path.
      templateSlug: "certificate-delivery",
      triggeredByUserId: args.triggeredByUserId,
      // Persist the final rendered HTML onto the EmailLog row — the audit
      // copy behind "view exactly what was sent" (organizer request).
      storeBody: true,
    },
  });
}

/**
 * Render the certificate COVER EMAIL as a preview — same subject/body
 * precedence and token pipeline as the real send (`coverEmailFor` in
 * bulk-issue.ts + `sendCertificateBundleEmail` above), against a synthetic
 * recipient ("Dr. Sample Attendee") and PREVIEW-DRAFT serials. No DB
 * writes, no email. Backs the Communications bulk-email dialog's Preview
 * button for the "certificate" email type.
 *
 * Assumes the recipient earns EVERY passed template (the most informative
 * preview of {{certificateList}}); a real recipient may get a subset per
 * their tags. speakerId stays null so {{abstractTitle}} resolves empty —
 * matching an ATTENDANCE-only recipient — rather than leaking a random
 * speaker's abstract into the sample.
 */
export async function buildCertCoverEmailPreview(args: {
  eventId: string;
  templates: Array<{
    name: string;
    category: CertificateType;
    emailSubject: string | null;
    emailBody: string | null;
  }>;
  customSubject?: string;
  customMessage?: string;
}): Promise<{ subject: string; htmlContent: string } | null> {
  if (args.templates.length === 0) return null;
  const event = await loadBundleEmailEvent(args.eventId);
  if (!event) return null;

  // Subject/body precedence — mirror coverEmailFor (bulk-issue.ts): custom
  // override → single template's saved cover → category/multi system default.
  const primary = args.templates[0];
  let subjectTemplate: string;
  let bodyTemplate: string;
  if (args.templates.length === 1) {
    subjectTemplate = primary.emailSubject?.trim().length
      ? primary.emailSubject
      : SYSTEM_DEFAULT_SUBJECT;
    bodyTemplate = primary.emailBody?.trim().length
      ? primary.emailBody
      : defaultBodyForCategory(primary.category);
  } else {
    // 2+ certs → the event's editable bundle cover template (same source
    // the real send uses), hardcoded default as the safety net.
    const bundleCover = await loadBundleCoverEmailTemplate(args.eventId);
    subjectTemplate = bundleCover?.subject ?? SYSTEM_DEFAULT_SUBJECT_MULTI;
    bodyTemplate = bundleCover?.body ?? SYSTEM_DEFAULT_BODY_MULTI;
  }
  if (args.customSubject?.trim().length) subjectTemplate = args.customSubject;
  if (args.customMessage?.trim().length) bodyTemplate = args.customMessage;

  const bundle = {
    certs: args.templates.map((t, i) => ({
      serial: `PREVIEW-DRAFT-${i + 1}`,
      type: t.category,
      templateName: t.name,
    })),
  };
  const tokenCtx: CoverEmailTokenContext = {
    recipientName: "Dr. Sample Attendee",
    firstName: "Sample",
    lastName: "Attendee",
    eventName: event.name,
    eventStartDate: event.startDate,
    eventEndDate: event.endDate,
    venue: event.venue,
    city: event.city,
    country: event.country,
    organizationName: event.organization.name,
    certificateType: primary.category,
    certificateSerial: bundle.certs[0].serial,
    speakerId: null,
    eventId: args.eventId,
    bundle,
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

  const subject = (await resolveCoverEmailTokens(subjectTemplate, tokenCtx))
    .replace(/\s+/g, " ")
    .trim();
  const bodyHtml = await resolveCoverEmailTokens(bodyTemplate, escapedTokenCtx);

  const branding: EmailBranding = {
    emailHeaderImage: event.emailHeaderImage,
    emailFooterImage: event.emailFooterImage,
    emailFooterHtml: event.emailFooterHtml,
    emailFromAddress: event.emailFromAddress,
    emailFromName: event.emailFromName ?? event.organization.name,
    eventName: event.name,
  };
  return { subject, htmlContent: inlineCss(wrapWithBranding(bodyHtml, branding)) };
}
