/**
 * Sponsor-prospectus email — the CRM's outbound bulk send. SERVER ONLY.
 *
 * "Send the prospectus to all sponsors of an event": resolve the event's sponsor
 * contacts (via its non-lost deals), render a personalized cover email + attach the
 * prospectus, and send one email per contact.
 *
 * Boundary: this lives in the CRM module and OWNS the audience + token logic, but it
 * reuses the core send primitives (`sendEmail`, `renderAndWrap`, `brandingFrom`) —
 * `crm → core` imports are allowed, `core → crm` is not, so the sender stays in core
 * and the sponsor-specific concern stays here. We do NOT reach into the event
 * bulk-email pipeline (`executeBulkEmail`), which is built around event recipient
 * types (registrations/speakers) and would drag those concerns across the boundary.
 *
 * Per-recipient failure is isolated (one bad address never sinks the batch); each
 * successful send records a `PROSPECTUS_SENT` row on the contact's CRM history and an
 * `EmailLog` row so it shows in the contact's Email History.
 */
import type { EmailBranding } from "@/lib/email";
import { sendEmail, renderAndWrap, brandingFrom, brandingCc } from "@/lib/email";
import { escapeHtml } from "@/lib/html";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { recordCrmActivity } from "@/crm/lib/crm-activity";
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
const BODY_TEMPLATE = `<p style="margin:0 0 16px">Dear {{firstName}},</p>\n{{message}}\n{{signature}}`;
const TEXT_TEMPLATE =
  "Dear {{firstName}},\n\nPlease find our sponsorship prospectus for {{eventName}} attached.\n";
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

interface ResolvedEvent {
  id: string;
  name: string;
  emailHeaderImage: string | null;
  emailFooterImage: string | null;
  emailFooterHtml: string | null;
  emailFromAddress: string | null;
  emailFromName: string | null;
  emailCcAddresses: string[];
}

const DEAL_SELECT = {
  company: { select: { name: true } },
  contacts: {
    select: {
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
    },
  },
} as const;

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
    return { ok: false, code: "EVENT_NOT_FOUND", message: "Event not found" };
  }

  const deals = (await db.crmDeal.findMany({
    where: {
      organizationId: args.organizationId,
      eventId: args.eventId,
      archivedAt: null,
      // A LOST deal is not a sponsor — you don't send the prospectus to a company
      // that already said no. OPEN (being pitched) + WON (confirmed) both count.
      status: { not: "LOST" },
    },
    select: DEAL_SELECT,
  })) as RawDealForRecipients[];

  const { recipients, skipped } = collectSponsorRecipients(deals);
  return {
    ok: true,
    event: { ...event, emailCcAddresses: event.emailCcAddresses ?? [] },
    recipients,
    skipped,
  };
}

export interface SendSponsorProspectusResult {
  ok: true;
  total: number;
  successCount: number;
  failureCount: number;
  errors: Array<{ email: string; error: string }>;
}

/**
 * Send the prospectus to (a subset of) an event's sponsor contacts.
 *
 * `contactIds` narrows the audience (intersection — see narrowToSelected); omit it
 * to send to everyone resolved. The whole batch shares the same attachments; the
 * cover email personalizes per contact.
 */
export async function sendSponsorProspectus(args: {
  organizationId: string;
  eventId: string;
  subject: string;
  /** Sender-authored HTML body (Tiptap). May contain {{firstName}} etc. */
  message: string;
  attachments?: SponsorAttachment[];
  /** Explicit selection from the reviewed recipient list. */
  contactIds?: string[];
  actorUserId: string | null;
  source: "rest" | "api";
}): Promise<SendSponsorProspectusResult | ServiceFail> {
  const subject = args.subject.trim();
  const message = args.message.trim();
  if (!subject) return { ok: false, code: "SUBJECT_REQUIRED", message: "A subject is required" };
  if (!message) return { ok: false, code: "BODY_REQUIRED", message: "A message is required" };

  const attachments = args.attachments ?? [];
  if (attachments.length > MAX_ATTACHMENTS) {
    return { ok: false, code: "TOO_MANY_ATTACHMENTS", message: `At most ${MAX_ATTACHMENTS} attachments` };
  }
  // base64 → bytes ≈ length * 3/4. Cheap upper-bound; the exact size doesn't matter.
  const totalBytes = attachments.reduce((s, a) => s + Math.floor((a.content.length * 3) / 4), 0);
  if (totalBytes > MAX_ATTACHMENT_BYTES) {
    return { ok: false, code: "ATTACHMENT_TOO_LARGE", message: "Attachments exceed the 10MB limit" };
  }

  const resolved = await resolveSponsorRecipients({
    organizationId: args.organizationId,
    eventId: args.eventId,
  });
  if (!resolved.ok) return resolved;

  const recipients = narrowToSelected(resolved.recipients, args.contactIds);

  // A selection that asks for ids outside the resolved sponsor set is a widening
  // attempt (or stale UI). We DROP them (never widen) but log it so it's visible.
  if (args.contactIds) {
    const resolvedIds = new Set(resolved.recipients.map((r) => r.crmContactId));
    const dropped = args.contactIds.filter((id) => !resolvedIds.has(id)).length;
    if (dropped > 0) {
      apiLogger.warn({
        msg: "crm-sponsor-email:dropped-non-sponsor-ids",
        organizationId: args.organizationId,
        eventId: args.eventId,
        dropped,
      });
    }
  }

  if (recipients.length === 0) {
    apiLogger.warn({
      msg: "crm-sponsor-email:no-recipients",
      organizationId: args.organizationId,
      eventId: args.eventId,
    });
    return { ok: false, code: "NO_RECIPIENTS", message: "No sponsor contacts to email for this event" };
  }

  const event = resolved.event;
  const branding: EmailBranding = {
    emailHeaderImage: event.emailHeaderImage,
    emailFooterImage: event.emailFooterImage,
    emailFooterHtml: event.emailFooterHtml,
    emailFromAddress: event.emailFromAddress,
    emailFromName: event.emailFromName,
    emailCcAddresses: event.emailCcAddresses,
    eventName: event.name,
  };

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

  const from = brandingFrom(branding);
  const cc = brandingCc(branding);
  const sendAttachments = attachments.map((a) => ({
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
      batch.map((r) => sendOne(r, { subject, message, signatureHtml, event, branding, from, cc, sendAttachments, args })),
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
          msg: "crm-sponsor-email:recipient-failed",
          organizationId: args.organizationId,
          eventId: args.eventId,
          crmContactId: r.crmContactId,
          error: errMsg,
        });
      }
    }
  }

  apiLogger.info({
    msg: "crm-sponsor-email:sent",
    organizationId: args.organizationId,
    eventId: args.eventId,
    total: recipients.length,
    successCount,
    failureCount,
    attachmentCount: attachments.length,
    source: args.source,
  });

  return { ok: true, total: recipients.length, successCount, failureCount, errors };
}

/** Render + send to one recipient; records CRM history on success. */
async function sendOne(
  r: SponsorRecipient,
  ctx: {
    subject: string;
    message: string;
    signatureHtml: string;
    event: ResolvedEvent;
    branding: EmailBranding;
    from: ReturnType<typeof brandingFrom>;
    cc: ReturnType<typeof brandingCc>;
    sendAttachments: SponsorAttachment[];
    args: {
      organizationId: string;
      eventId: string;
      actorUserId: string | null;
    };
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tokenVars = {
    firstName: r.firstName,
    lastName: r.lastName,
    companyName: r.companyName ?? "",
    eventName: ctx.event.name,
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

  const res = await sendEmail({
    to: [{ email: r.email, name: `${r.firstName} ${r.lastName}`.trim() || undefined }],
    cc: ctx.cc,
    from: ctx.from,
    subject: rendered.subject,
    htmlContent: rendered.htmlContent,
    textContent: rendered.textContent,
    attachments: ctx.sendAttachments.length ? ctx.sendAttachments : undefined,
    emailType: "crm_sponsor_prospectus",
    stream: "bulk",
    logContext: {
      organizationId: ctx.args.organizationId,
      eventId: ctx.args.eventId,
      // EmailLogEntityType has no CRM value; OTHER + the crmContactId keeps the row
      // attributable without a schema change.
      entityType: "OTHER",
      entityId: r.crmContactId,
      templateSlug: "crm-sponsor-prospectus",
      triggeredByUserId: ctx.args.actorUserId,
    },
  });

  if (!res.success) return { ok: false, error: res.error ?? "send failed" };

  // Surface the outreach on the contact's CRM history timeline.
  void recordCrmActivity({
    organizationId: ctx.args.organizationId,
    entityType: "CONTACT",
    entityId: r.crmContactId,
    action: "PROSPECTUS_SENT",
    actorId: ctx.args.actorUserId,
    changes: {
      subject: ctx.subject,
      event: ctx.event.name,
      attachments: ctx.sendAttachments.map((a) => a.name),
    },
  });

  return { ok: true };
}
