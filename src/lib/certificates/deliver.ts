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
import { SYSTEM_DEFAULT_SUBJECT, defaultBodyForCategory, defaultCoverEmailFor } from "./email-tokens";
import { allocateSerial, loadRecipient } from "./cert-context";
import {
  loadCertTemplate,
  renderAndUpload,
  resolveRecipientEmail,
  sendCertificateBundleEmail,
  findOrIssueCertificate,
  type RenderAndUploadResult,
  type BundleCert,
} from "./bundle";

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
// loadCertTemplate / renderAndUpload / resolveRecipientEmail moved to
// bundle.ts (the shared lower layer) so the bulk + worker + auto-issue paths
// compose the same primitives without duplication or an import cycle.

/** Build + send the cover email using the CURRENT template's subject/body
 *  (fallback to system default). Thin 1-cert wrapper over the shared bundle
 *  sender so all cert code paths render identical emails. */
async function sendCertEmail(args: {
  eventId: string;
  type: CertificateType;
  serial: string;
  templateName: string;
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
  return sendCertificateBundleEmail({
    eventId: args.eventId,
    organizationId: args.organizationId,
    recipientEmail: args.recipientEmail,
    recipientName: args.recipientName,
    registrationId: args.registrationId,
    speakerId: args.speakerId,
    certs: [
      {
        serial: args.serial,
        type: args.type,
        templateName: args.templateName,
        pdfBuffer: args.pdfBuffer,
      },
    ],
    emailSubjectTemplate: args.emailSubjectTemplate,
    emailBodyTemplate: args.emailBodyTemplate,
    triggeredByUserId: args.triggeredByUserId,
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

  const tmpl = await loadCertTemplate(ctx.eventId, input.templateId);
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

  let render: RenderAndUploadResult;
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
    templateName: tmpl.name,
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

  const tmpl = await loadCertTemplate(ctx.eventId, cert.certificateTemplateId);
  if (!tmpl) return { ok: false, code: "TEMPLATE_NOT_FOUND", error: "The certificate’s template no longer exists.", status: 409 };

  const recipientEmail = await resolveRecipientEmail(cert.registrationId, cert.speakerId);
  if (!recipientEmail) return { ok: false, code: "NO_RECIPIENT_EMAIL", error: "Recipient has no email address on file.", status: 409 };

  let render: RenderAndUploadResult;
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
    templateName: tmpl.name,
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

// ── Public: multi-template bundle issue to ONE person ────────────────────────

export type BundleIssueResult =
  | {
      ok: true;
      recipientEmail: string;
      /** Every cert carried by the email — `reused: true` rows were already
       *  held (per-template dedup) and re-attached rather than re-minted. */
      certs: Array<{ certificateId: string; serial: string; templateName: string; reused: boolean }>;
      /** Templates that could NOT be materialized (revoked / render failure).
       *  Non-empty means a partial send — surfaced to the operator. */
      failures: Array<{ templateId: string; templateName: string; error: string }>;
      messageId?: string;
    }
  | DeliverFailure;

/**
 * Issue SEVERAL certificate templates to ONE registration or speaker and
 * email them as ONE bundle (one email, one PDF per cert) — the multi-select
 * "Issue certificate" flow on the registration/speaker detail cards.
 *
 * Semantics mirror the bulk-email path, NOT the strict single-issue one: an
 * already-held template is REUSED (re-attached with its existing serial,
 * same rule as `findOrIssueCertificate` everywhere else) instead of failing
 * the whole request with ALREADY_ISSUED. Tags are not checked — an explicit
 * operator selection outranks tag routing, like issueSingleCertificate.
 */
export async function issueCertificateBundle(
  ctx: DeliverContext,
  input: { templateIds: string[]; registrationId?: string | null; speakerId?: string | null },
): Promise<BundleIssueResult> {
  const registrationId = input.registrationId ?? null;
  const speakerId = input.speakerId ?? null;
  if ((registrationId && speakerId) || (!registrationId && !speakerId)) {
    return { ok: false, code: "INVALID_RECIPIENT", error: "Provide exactly one of registrationId or speakerId.", status: 400 };
  }

  const templateIds = [...new Set(input.templateIds)];
  if (templateIds.length === 0) {
    return { ok: false, code: "NO_TEMPLATES", error: "Select at least one certificate template.", status: 400 };
  }

  const loaded = await Promise.all(templateIds.map((id) => loadCertTemplate(ctx.eventId, id)));
  if (loaded.some((t) => t === null)) {
    return { ok: false, code: "TEMPLATE_NOT_FOUND", error: "One or more certificate templates were not found.", status: 404 };
  }
  const templates = loaded as NonNullable<(typeof loaded)[number]>[];

  // Facet check — the card is facet-bound (registration → ATTENDANCE,
  // speaker → APPRECIATION), same rule as issueSingleCertificate.
  const wrongFacet = templates.find((t) =>
    t.category === "ATTENDANCE" ? !registrationId : !speakerId,
  );
  if (wrongFacet) {
    return {
      ok: false,
      code: "WRONG_RECIPIENT_TYPE",
      error:
        wrongFacet.category === "ATTENDANCE"
          ? `"${wrongFacet.name}" is an attendance certificate — it must go to a registration.`
          : `"${wrongFacet.name}" is an appreciation certificate — it must go to a speaker.`,
      status: 400,
    };
  }

  const [recipientEmail, recipient] = await Promise.all([
    resolveRecipientEmail(registrationId, speakerId),
    loadRecipient(registrationId, speakerId),
  ]);
  if (!recipient) {
    return { ok: false, code: "RECIPIENT_NOT_FOUND", error: "Recipient no longer exists.", status: 404 };
  }
  if (!recipientEmail) {
    return { ok: false, code: "NO_RECIPIENT_EMAIL", error: "Recipient has no email address on file.", status: 409 };
  }

  const bundled: Array<{ template: (typeof templates)[number]; cert: BundleCert }> = [];
  const failures: Array<{ templateId: string; templateName: string; error: string }> = [];
  for (const t of templates) {
    const res = await findOrIssueCertificate({
      eventId: ctx.eventId,
      templateId: t.id,
      registrationId,
      speakerId,
      issuedByUserId: ctx.actorUserId,
      template: t,
    });
    if (!res.ok) {
      // Already logged inside findOrIssueCertificate; collect for the
      // operator-facing partial-send summary.
      failures.push({ templateId: t.id, templateName: t.name, error: res.error });
      continue;
    }
    bundled.push({ template: t, cert: res.cert });
    if (!res.cert.reused) {
      await writeAudit(ctx, "CERT_ISSUED", res.cert.certificateId, {
        serial: res.cert.serial,
        templateId: t.id,
        recipientEmail,
      });
    }
  }

  if (bundled.length === 0) {
    return {
      ok: false,
      code: "ALL_TEMPLATES_FAILED",
      error: `No certificate could be issued — ${failures.map((f) => `${f.templateName}: ${f.error}`).join("; ")}`,
      status: 500,
    };
  }

  // Cover email — same precedence as every other send: exactly one cert →
  // that template's saved cover (or its category default); several → the
  // bundle default with {{certificateList}}.
  const single = bundled.length === 1 ? bundled[0].template : null;
  const cover = single
    ? {
        subject: single.emailSubject?.trim().length ? single.emailSubject : SYSTEM_DEFAULT_SUBJECT,
        body: single.emailBody?.trim().length ? single.emailBody : defaultBodyForCategory(single.category),
      }
    : defaultCoverEmailFor(bundled.length, bundled[0].template.category);

  const send = await sendCertificateBundleEmail({
    eventId: ctx.eventId,
    organizationId: ctx.organizationId,
    recipientEmail,
    recipientName: recipient.fullName,
    recipientFirstName: recipient.firstName,
    recipientLastName: recipient.lastName,
    registrationId,
    speakerId,
    certs: bundled.map((b) => ({
      serial: b.cert.serial,
      type: b.cert.type,
      templateName: b.cert.templateName,
      pdfBuffer: b.cert.pdfBuffer,
    })),
    emailSubjectTemplate: cover.subject,
    emailBodyTemplate: cover.body,
    triggeredByUserId: ctx.actorUserId,
  });

  if (!send.success) {
    // The certs ARE issued (rendered + stored); only the email failed —
    // "Resend all" on the card recovers without re-minting.
    apiLogger.warn({
      msg: "cert-deliver:bundle-issued-send-failed",
      eventId: ctx.eventId,
      certificateIds: bundled.map((b) => b.cert.certificateId),
      err: send.error,
    });
    return {
      ok: false,
      code: "ISSUED_SEND_FAILED",
      error: `Certificate${bundled.length > 1 ? "s" : ""} issued, but the email failed to send — use "Resend all".`,
      status: 502,
    };
  }

  apiLogger.info({
    msg: "cert-deliver:bundle-issued",
    eventId: ctx.eventId,
    recipientEmail,
    certCount: bundled.length,
    reusedCount: bundled.filter((b) => b.cert.reused).length,
    failureCount: failures.length,
    messageId: send.messageId,
  });
  return {
    ok: true,
    recipientEmail,
    certs: bundled.map((b) => ({
      certificateId: b.cert.certificateId,
      serial: b.cert.serial,
      templateName: b.cert.templateName,
      reused: b.cert.reused,
    })),
    failures,
    messageId: send.messageId,
  };
}
