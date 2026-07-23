/**
 * CRM outbound email — the sponsor blast AND the per-deal send. SERVER ONLY.
 *
 * Two entry points, one engine:
 *   - sendSponsorProspectus  — everyone on an EVENT's non-lost deals ("email all
 *                              sponsors of BRIDGES 2026").
 *   - sendDealEmail          — the contacts on ONE deal ("email the people on the
 *                              Abbott deal").
 * Both resolve a deduped recipient list (via collectSponsorRecipients — shared), a
 * branding/eventName context, then hand off to `dispatchCrmEmail`, which owns the
 * validate → narrow → batch → per-recipient render/send/record loop. The audience +
 * token logic stays in the CRM module; rendering + sending reuse the CORE primitives
 * (`sendEmail`/`renderAndWrap`/branding) — crm→core, never core→crm, and never the
 * event `executeBulkEmail` pipeline (built around event recipient types).
 *
 * Per-recipient failure is isolated; each success writes an `EmailLog` row (Email
 * History) and a CRM history row on the contact (and, for a deal send, one summary
 * row on the deal).
 */
import type { EmailBranding } from "@/lib/email";
import { sendEmail, renderAndWrap, brandingFrom, brandingCc } from "@/lib/email";
import { escapeHtml } from "@/lib/html";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { recordCrmActivity } from "@/crm/lib/crm-activity";
import {
  crmReplyAddress,
  mintReplyToken,
  recordOutboundEmail,
} from "@/crm/services/crm-email-thread-service";
import {
  collectSponsorRecipients,
  narrowToSelected,
  type RawDealForRecipients,
} from "@/crm/lib/sponsor-recipients";
import type { SponsorRecipient } from "@/crm/lib/crm-types";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB total, mirrors the dashboard dialog
const MAX_ATTACHMENTS = 5;
const BATCH_SIZE = 25;

/** Cover-email skeleton. The greeting is baked in so a body with no tokens is still
 *  personalized; `message` (the sender's HTML) and `signature` are inserted raw. */
const BODY_TEMPLATE = `<p style="margin:0 0 8px">Dear {{firstName}},</p>\n{{message}}\n{{signature}}`;
const TEXT_TEMPLATE =
  "Dear {{firstName}},\n\nPlease find our message below / attached.\n";
const RAW_KEYS = new Set(["message", "signature"]);

// Only these tokens are substituted inside the sender-authored body/subject. Values
// are HTML-escaped so a contact's name containing "<" can't inject markup.
const BODY_TOKEN_RE = /\{\{\s*(firstName|lastName|companyName|eventName)\s*\}\}/g;

function substituteBodyTokens(html: string, vars: Record<string, string>): string {
  return html.replace(BODY_TOKEN_RE, (_, k: string) => escapeHtml(vars[k] ?? ""));
}

export interface SponsorAttachment {
  name: string;
  /** Base64-encoded file content. */
  content: string;
  contentType?: string;
}

type ServiceFail = { ok: false; code: string; message: string };

interface EventBrandingRow {
  name: string;
  emailHeaderImage: string | null;
  emailFooterImage: string | null;
  emailFooterHtml: string | null;
  emailFromAddress: string | null;
  emailFromName: string | null;
  emailCcAddresses: string[];
}

function brandingFromEventRow(e: EventBrandingRow): EmailBranding {
  return {
    emailHeaderImage: e.emailHeaderImage,
    emailFooterImage: e.emailFooterImage,
    emailFooterHtml: e.emailFooterHtml,
    emailFromAddress: e.emailFromAddress,
    emailFromName: e.emailFromName,
    emailCcAddresses: e.emailCcAddresses ?? [],
    eventName: e.name,
  };
}

const CONTACT_ON_DEAL_SELECT = {
  crmContact: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      emailKey: true,
      archivedAt: true,
      company: { select: { name: true } },
    },
  },
} as const;

// ── Resolve: event ──────────────────────────────────────────────────────────────

interface ResolvedEvent extends EventBrandingRow {
  id: string;
}

/**
 * Resolve the deduped sponsor contacts for an event. Org-bound: the event must
 * belong to the caller's org (else EVENT_NOT_FOUND — a 404, no cross-tenant peek).
 */
export async function resolveSponsorRecipients(args: {
  organizationId: string;
  eventId: string;
}): Promise<
  | {
      ok: true;
      event: ResolvedEvent;
      recipients: SponsorRecipient[];
      skipped: { noEmail: number; archivedContacts: number };
    }
  | ServiceFail
> {
  const event = await db.event.findFirst({
    where: { id: args.eventId, organizationId: args.organizationId },
    select: {
      id: true,
      name: true,
      emailHeaderImage: true,
      emailFooterImage: true,
      emailFooterHtml: true,
      emailFromAddress: true,
      emailFromName: true,
      emailCcAddresses: true,
    },
  });
  if (!event) {
    // Per-site log (R2 rider L5) — the boundary logs too, but without the ids.
    apiLogger.warn({ msg: "crm-sponsor-email:event-not-found", organizationId: args.organizationId, eventId: args.eventId });
    return { ok: false, code: "EVENT_NOT_FOUND", message: "Event not found" };
  }

  const deals = (await db.crmDeal.findMany({
    where: {
      organizationId: args.organizationId,
      eventId: args.eventId,
      archivedAt: null,
      // A LOST deal is not a sponsor — you don't send to a company that said no.
      status: { not: "LOST" },
    },
    select: { company: { select: { name: true } }, contacts: { select: CONTACT_ON_DEAL_SELECT } },
  })) as RawDealForRecipients[];

  const { recipients, skipped } = collectSponsorRecipients(deals);
  return {
    ok: true,
    event: { ...event, emailCcAddresses: event.emailCcAddresses ?? [] },
    recipients,
    skipped,
  };
}

// ── Resolve: single deal ──────────────────────────────────────────────────────────

/**
 * Resolve the deduped contacts on ONE deal, plus the branding to send under (the
 * deal's linked event, if any — otherwise the org default sender). Org-bound + not
 * archived.
 */
export async function resolveDealRecipients(args: {
  organizationId: string;
  dealId: string;
}): Promise<
  | {
      ok: true;
      target: { id: string; name: string };
      branding: EmailBranding;
      eventName: string;
      recipients: SponsorRecipient[];
      skipped: { noEmail: number; archivedContacts: number };
    }
  | ServiceFail
> {
  const deal = await db.crmDeal.findFirst({
    where: { id: args.dealId, organizationId: args.organizationId, archivedAt: null },
    select: {
      id: true,
      name: true,
      company: { select: { name: true } },
      contacts: { select: CONTACT_ON_DEAL_SELECT },
      event: {
        select: {
          name: true,
          emailHeaderImage: true,
          emailFooterImage: true,
          emailFooterHtml: true,
          emailFromAddress: true,
          emailFromName: true,
          emailCcAddresses: true,
        },
      },
    },
  });
  if (!deal) {
    apiLogger.warn({ msg: "crm-sponsor-email:deal-not-found", organizationId: args.organizationId, dealId: args.dealId });
    return { ok: false, code: "DEAL_NOT_FOUND", message: "Deal not found" };
  }

  // collectSponsorRecipients takes a LIST of deals — a single deal is a one-element
  // list, so the same dedup/skip logic (and its tests) covers this path.
  const { recipients, skipped } = collectSponsorRecipients([
    { company: deal.company, contacts: deal.contacts },
  ] as RawDealForRecipients[]);

  const branding: EmailBranding = deal.event
    ? brandingFromEventRow(deal.event)
    : { emailCcAddresses: [], eventName: undefined };

  return {
    ok: true,
    target: { id: deal.id, name: deal.name },
    branding,
    eventName: deal.event?.name ?? "",
    recipients,
    skipped,
  };
}

// ── Send ──────────────────────────────────────────────────────────────────────────

export interface CrmEmailSendResult {
  ok: true;
  total: number;
  successCount: number;
  failureCount: number;
  errors: Array<{ email: string; error: string }>;
}

function validateSend(
  subject: string,
  message: string,
  attachments: SponsorAttachment[],
): { ok: true; subject: string; message: string } | ServiceFail {
  const s = subject.trim();
  const m = message.trim();
  // Per-site warns on every rejection (R2 rider L5) — matches the sibling
  // services' discipline; the boundary log alone lacks the shape details.
  if (!s) {
    apiLogger.warn({ msg: "crm-sponsor-email:subject-required" });
    return { ok: false, code: "SUBJECT_REQUIRED", message: "A subject is required" };
  }
  if (!m) {
    apiLogger.warn({ msg: "crm-sponsor-email:body-required" });
    return { ok: false, code: "BODY_REQUIRED", message: "A message is required" };
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    apiLogger.warn({ msg: "crm-sponsor-email:too-many-attachments", count: attachments.length });
    return { ok: false, code: "TOO_MANY_ATTACHMENTS", message: `At most ${MAX_ATTACHMENTS} attachments` };
  }
  // base64 → bytes ≈ length * 3/4. Cheap upper-bound; the exact size doesn't matter.
  const totalBytes = attachments.reduce((acc, a) => acc + Math.floor((a.content.length * 3) / 4), 0);
  if (totalBytes > MAX_ATTACHMENT_BYTES) {
    apiLogger.warn({ msg: "crm-sponsor-email:attachments-too-large", totalBytes });
    return { ok: false, code: "ATTACHMENT_TOO_LARGE", message: "Attachments exceed the 10MB limit" };
  }
  // Document/image types only (CRM review L12): this blast fans out to EXTERNAL
  // sponsor inboxes under the org's branded sender — an executable or HTML
  // payload has no business riding it. The prospectus is a PDF/DOCX/image.
  for (const a of attachments) {
    const t = (a.contentType ?? "").trim().toLowerCase();
    if (t && !ALLOWED_ATTACHMENT_TYPES.has(t)) {
      apiLogger.warn({ msg: "crm-sponsor-email:attachment-type-rejected", contentType: t });
      return {
        ok: false,
        code: "ATTACHMENT_TYPE_NOT_ALLOWED",
        message: `Attachment type "${t}" is not allowed — send PDF, Word, PowerPoint or image files`,
      };
    }
  }
  return { ok: true, subject: s, message: m };
}

const ALLOWED_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

interface DispatchArgs {
  organizationId: string;
  recipients: SponsorRecipient[];
  contactIds?: string[];
  branding: EmailBranding;
  eventName: string;
  subject: string;
  message: string;
  attachments: SponsorAttachment[];
  actorUserId: string | null;
  /** CRM history action recorded on each contact on a successful send. */
  contactActivityAction: string;
  /**
   * Deal to attach each recipient's inbox thread to. Null for event-wide blasts
   * (a contact there may span deals) — the thread still exists, just deal-less.
   */
  threadDealId: string | null;
  /** For the "dropped a non-sponsor id" log line. */
  logScope: Record<string, unknown>;
}

/**
 * The shared send engine: narrow the audience to the selection (intersection —
 * never widen), then batch-send with per-recipient failure isolation. Assumes
 * subject/message/attachments are already validated.
 */
async function dispatchCrmEmail(args: DispatchArgs): Promise<CrmEmailSendResult | ServiceFail> {
  const recipients = narrowToSelected(args.recipients, args.contactIds);

  // A selection asking for ids outside the resolved set is a widening attempt (or
  // stale UI). We DROP them (never widen) but log it.
  if (args.contactIds) {
    const resolvedIds = new Set(args.recipients.map((r) => r.crmContactId));
    const dropped = args.contactIds.filter((id) => !resolvedIds.has(id)).length;
    if (dropped > 0) {
      apiLogger.warn({ msg: "crm-email:dropped-non-recipient-ids", ...args.logScope, dropped });
    }
  }

  if (recipients.length === 0) {
    apiLogger.warn({ msg: "crm-email:no-recipients", ...args.logScope });
    return { ok: false, code: "NO_RECIPIENTS", message: "No contacts to email" };
  }

  // The sender's own signature (same feature as the event bulk-email organizer
  // signature). Appended raw beneath the body.
  let signatureHtml = "";
  if (args.actorUserId) {
    const sender = await db.user.findUnique({
      where: { id: args.actorUserId },
      select: { emailSignature: true },
    });
    signatureHtml = sender?.emailSignature ?? "";
  }

  const from = brandingFrom(args.branding);
  const cc = brandingCc(args.branding);
  const sendAttachments = args.attachments.map((a) => ({
    name: a.name,
    content: a.content,
    contentType: a.contentType,
  }));

  const errors: Array<{ email: string; error: string }> = [];
  let successCount = 0;
  let failureCount = 0;

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map((r) =>
        sendOne(r, {
          subject: args.subject,
          message: args.message,
          signatureHtml,
          eventName: args.eventName,
          branding: args.branding,
          from,
          cc,
          sendAttachments,
          organizationId: args.organizationId,
          actorUserId: args.actorUserId,
          contactActivityAction: args.contactActivityAction,
          threadDealId: args.threadDealId,
        }),
      ),
    );
    for (let j = 0; j < settled.length; j++) {
      const r = batch[j];
      const outcome = settled[j];
      if (outcome.status === "fulfilled" && outcome.value.ok) {
        successCount++;
      } else {
        failureCount++;
        const errMsg =
          outcome.status === "rejected"
            ? outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason)
            : outcome.value.ok
              ? "send failed"
              : outcome.value.error;
        errors.push({ email: r.email, error: errMsg });
        apiLogger.warn({
          msg: "crm-email:recipient-failed",
          ...args.logScope,
          crmContactId: r.crmContactId,
          error: errMsg,
        });
      }
    }
  }

  apiLogger.info({
    msg: "crm-email:sent",
    ...args.logScope,
    total: recipients.length,
    successCount,
    failureCount,
    attachmentCount: args.attachments.length,
  });

  return { ok: true, total: recipients.length, successCount, failureCount, errors };
}

/** Render + send to one recipient; records CRM history on the contact on success. */
async function sendOne(
  r: SponsorRecipient,
  ctx: {
    subject: string;
    message: string;
    signatureHtml: string;
    eventName: string;
    branding: EmailBranding;
    from: ReturnType<typeof brandingFrom>;
    cc: ReturnType<typeof brandingCc>;
    sendAttachments: SponsorAttachment[];
    organizationId: string;
    actorUserId: string | null;
    contactActivityAction: string;
    threadDealId: string | null;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tokenVars = {
    firstName: r.firstName,
    lastName: r.lastName,
    companyName: r.companyName ?? "",
    eventName: ctx.eventName,
  };
  // Personalize the sender's body first (tokens escaped), THEN insert it raw — so a
  // {{firstName}} typed into the body resolves, but the body's own markup survives.
  const personalizedMessage = substituteBodyTokens(ctx.message, tokenVars);

  const rendered = renderAndWrap(
    { subject: ctx.subject, htmlContent: BODY_TEMPLATE, textContent: TEXT_TEMPLATE },
    { ...tokenVars, message: personalizedMessage, signature: ctx.signatureHtml },
    ctx.branding,
    RAW_KEYS,
  );

  // Inbox threading: every recipient gets their own thread + reply token. While
  // CRM_REPLY_DOMAIN is unset the address is null (no Reply-To — behavior
  // unchanged) but the thread still records as sent-history.
  const replyToken = mintReplyToken();
  const replyAddress = crmReplyAddress(replyToken);

  const res = await sendEmail({
    to: [{ email: r.email, name: `${r.firstName} ${r.lastName}`.trim() || undefined }],
    cc: ctx.cc,
    from: ctx.from,
    ...(replyAddress ? { replyTo: { email: replyAddress, name: ctx.from?.name } } : {}),
    subject: rendered.subject,
    htmlContent: rendered.htmlContent,
    textContent: rendered.textContent,
    attachments: ctx.sendAttachments.length ? ctx.sendAttachments : undefined,
    emailType: "crm_email",
    stream: "bulk",
    logContext: {
      organizationId: ctx.organizationId,
      // EmailLogEntityType has no CRM value; OTHER + the crmContactId keeps the row
      // attributable without a schema change.
      entityType: "OTHER",
      entityId: r.crmContactId,
      templateSlug: "crm-email",
      triggeredByUserId: ctx.actorUserId,
    },
  });

  if (!res.success) return { ok: false, error: res.error ?? "send failed" };

  void recordOutboundEmail({
    organizationId: ctx.organizationId,
    dealId: ctx.threadDealId,
    crmContactId: r.crmContactId,
    counterpartyEmail: r.email,
    counterpartyName: `${r.firstName} ${r.lastName}`.trim() || null,
    subject: rendered.subject,
    htmlBody: rendered.htmlContent,
    textBody: rendered.textContent ?? null,
    replyToken,
    providerMessageId: res.messageId ?? null,
    sentByUserId: ctx.actorUserId,
    // brandingFrom() returns undefined when the event has no sender override —
    // sendEmail then uses the env default, so mirror that here.
    fromEmail: ctx.from?.email ?? process.env.EMAIL_FROM ?? "",
    fromName: ctx.from?.name ?? null,
  });

  void recordCrmActivity({
    organizationId: ctx.organizationId,
    entityType: "CONTACT",
    entityId: r.crmContactId,
    action: ctx.contactActivityAction,
    actorId: ctx.actorUserId,
    changes: {
      subject: ctx.subject,
      ...(ctx.eventName ? { event: ctx.eventName } : {}),
      attachments: ctx.sendAttachments.map((a) => a.name),
    },
  });

  return { ok: true };
}

/**
 * Send the prospectus to (a subset of) an EVENT's sponsor contacts.
 */
export async function sendSponsorProspectus(args: {
  organizationId: string;
  eventId: string;
  subject: string;
  message: string;
  attachments?: SponsorAttachment[];
  contactIds?: string[];
  actorUserId: string | null;
  source: "rest" | "api";
}): Promise<CrmEmailSendResult | ServiceFail> {
  const attachments = args.attachments ?? [];
  const valid = validateSend(args.subject, args.message, attachments);
  if (!valid.ok) return valid;

  const resolved = await resolveSponsorRecipients({
    organizationId: args.organizationId,
    eventId: args.eventId,
  });
  if (!resolved.ok) return resolved;

  return dispatchCrmEmail({
    organizationId: args.organizationId,
    recipients: resolved.recipients,
    contactIds: args.contactIds,
    branding: brandingFromEventRow(resolved.event),
    eventName: resolved.event.name,
    subject: valid.subject,
    message: valid.message,
    attachments,
    actorUserId: args.actorUserId,
    contactActivityAction: "PROSPECTUS_SENT",
    threadDealId: null,
    logScope: { organizationId: args.organizationId, eventId: args.eventId, source: args.source },
  });
}

/**
 * Send an email to (a subset of) ONE deal's contacts. Records a summary row on the
 * deal's history in addition to the per-contact rows.
 */
export async function sendDealEmail(args: {
  organizationId: string;
  dealId: string;
  subject: string;
  message: string;
  attachments?: SponsorAttachment[];
  contactIds?: string[];
  actorUserId: string | null;
  source: "rest" | "api";
}): Promise<CrmEmailSendResult | ServiceFail> {
  const attachments = args.attachments ?? [];
  const valid = validateSend(args.subject, args.message, attachments);
  if (!valid.ok) return valid;

  const resolved = await resolveDealRecipients({
    organizationId: args.organizationId,
    dealId: args.dealId,
  });
  if (!resolved.ok) return resolved;

  const result = await dispatchCrmEmail({
    organizationId: args.organizationId,
    recipients: resolved.recipients,
    contactIds: args.contactIds,
    branding: resolved.branding,
    eventName: resolved.eventName,
    subject: valid.subject,
    message: valid.message,
    attachments,
    actorUserId: args.actorUserId,
    contactActivityAction: "EMAIL_SENT",
    threadDealId: args.dealId,
    logScope: { organizationId: args.organizationId, dealId: args.dealId, source: args.source },
  });

  // Summarize the outreach on the DEAL's own history timeline (in addition to the
  // per-contact rows), so "who emailed this deal, and when?" is answerable from the
  // deal sheet.
  if (result.ok && result.successCount > 0) {
    void recordCrmActivity({
      organizationId: args.organizationId,
      entityType: "DEAL",
      entityId: args.dealId,
      action: "EMAIL_SENT",
      actorId: args.actorUserId,
      changes: {
        subject: valid.subject,
        recipients: result.successCount,
        ...(resolved.eventName ? { event: resolved.eventName } : {}),
      },
    });
  }

  return result;
}
