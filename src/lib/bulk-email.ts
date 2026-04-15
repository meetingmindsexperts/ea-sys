import { RegistrationStatus, SpeakerStatus } from "@prisma/client";
import { z } from "zod";
import { db } from "./db";
import { apiLogger } from "./logger";
import {
  sendEmail,
  getEventTemplate,
  getDefaultTemplate,
  renderAndWrap,
  brandingFrom,
  type EmailBranding,
} from "./email";
import { buildSpeakerEmailContext, generateSpeakerAgreementDocx, SPEAKER_AGREEMENT_DOCX_MIME } from "./speaker-agreement";

// ───────────────────────── Types ─────────────────────────

export type BulkEmailRecipientType = "speakers" | "registrations" | "reviewers" | "abstracts";

export type BulkEmailType =
  | "invitation"
  | "agreement"
  | "confirmation"
  | "reminder"
  | "custom"
  | "abstract-accepted"
  | "abstract-rejected"
  | "abstract-revision"
  | "abstract-reminder"
  | "webinar-confirmation"
  | "webinar-reminder-24h"
  | "webinar-reminder-1h"
  | "webinar-live-now"
  | "webinar-thank-you";

export const WEBINAR_EMAIL_TYPES = [
  "webinar-confirmation",
  "webinar-reminder-24h",
  "webinar-reminder-1h",
  "webinar-live-now",
  "webinar-thank-you",
] as const;

export function isWebinarEmailType(t: string): boolean {
  return (WEBINAR_EMAIL_TYPES as readonly string[]).includes(t);
}

export interface BulkEmailAttachment {
  name: string;
  content: string; // base64
  contentType?: string;
}

export interface BulkEmailFilters {
  status?: string;
  ticketTypeId?: string;
}

export interface BulkEmailInput {
  eventId: string;
  recipientType: BulkEmailRecipientType;
  recipientIds?: string[];
  emailType: BulkEmailType;
  customSubject?: string;
  customMessage?: string;
  attachments?: BulkEmailAttachment[];
  filters?: BulkEmailFilters;
  organizerName: string;
  organizerEmail: string;
  organizerSignature?: string;
}

export interface BulkEmailResult {
  total: number;
  successCount: number;
  failureCount: number;
  errors: Array<{ email: string; error: string }>;
}

export class BulkEmailError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// Shared Zod schema reused by both immediate-send and schedule routes
export const bulkEmailSchema = z.object({
  recipientType: z.enum(["speakers", "registrations", "reviewers", "abstracts"]),
  recipientIds: z.array(z.string().max(100)).optional(),
  emailType: z.enum([
    "invitation",
    "agreement",
    "confirmation",
    "reminder",
    "custom",
    "abstract-accepted",
    "abstract-rejected",
    "abstract-revision",
    "abstract-reminder",
    "webinar-confirmation",
    "webinar-reminder-24h",
    "webinar-reminder-1h",
    "webinar-live-now",
    "webinar-thank-you",
  ]),
  customSubject: z.string().max(500).optional(),
  customMessage: z.string().max(10000).optional(),
  attachments: z
    .array(
      z.object({
        name: z.string().max(255),
        content: z.string(),
        contentType: z.string().max(100).optional(),
      })
    )
    .max(5)
    .optional(),
  filters: z
    .object({
      status: z.string().max(50).optional(),
      ticketTypeId: z.string().max(100).optional(),
    })
    .optional(),
});

const speakerStatusSchema = z.nativeEnum(SpeakerStatus);
const registrationStatusSchema = z.nativeEnum(RegistrationStatus);

// Max total attachment size: 10MB
export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

// ───────────────────────── Helper ─────────────────────────

interface ResolvedRecipient {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  ticketType?: string;
  serialId?: number | null;
}

/**
 * Resolves recipients, loads template, renders per-recipient, and dispatches in batches.
 * Used by both the immediate-send route and the cron worker for scheduled sends.
 *
 * Throws BulkEmailError on validation failures (e.g. event missing, no recipients).
 * Per-recipient send failures are captured in the result.errors array, not thrown.
 */
export async function executeBulkEmail(input: BulkEmailInput): Promise<BulkEmailResult> {
  const {
    eventId,
    recipientType,
    recipientIds,
    emailType,
    customSubject,
    customMessage,
    attachments,
    filters,
    organizerName,
    organizerEmail,
    organizerSignature,
  } = input;

  // Speaker-agreement bulk sends require an uploaded .docx template — fail
  // fast before resolving recipients so we don't half-process and stress
  // Zoom/email rate limits with errors.
  const needsAgreementDocx = emailType === "agreement" && recipientType === "speakers";

  // Validate attachment size
  if (attachments?.length) {
    const totalSize = attachments.reduce((sum, a) => sum + a.content.length, 0);
    if (totalSize > MAX_ATTACHMENT_SIZE) {
      throw new BulkEmailError("Total attachment size exceeds 10MB limit", 400);
    }
  }

  // Only fetch the columns we render into the email — avoids dragging back HTML
  // template fields, banner image, terms HTML, etc.
  // Include per-event sender fields + email branding so the `from` address
  // respects the event's configured sender (not just provider defaults).
  const event = await db.event.findFirst({
    where: { id: eventId },
    select: {
      id: true,
      name: true,
      startDate: true,
      venue: true,
      address: true,
      settings: true,
      emailFromAddress: true,
      emailFromName: true,
      emailHeaderImage: true,
      emailFooterHtml: true,
      speakerAgreementTemplate: true,
    },
  });
  if (!event) {
    throw new BulkEmailError("Event not found", 404);
  }

  if (needsAgreementDocx && !event.speakerAgreementTemplate) {
    throw new BulkEmailError(
      "Upload a speaker agreement template under Event Settings → Email Branding → Speaker Agreement Template before sending agreement emails.",
      400,
    );
  }

  const eventDate = event.startDate
    ? new Date(event.startDate).toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "TBA";
  const eventVenue = event.venue || "TBA";

  // ── Resolve recipients ──
  let recipients: ResolvedRecipient[] = [];

  if (recipientType === "reviewers") {
    const reviewerUserIds = (event.settings as { reviewerUserIds?: string[] })?.reviewerUserIds ?? [];
    if (reviewerUserIds.length === 0) {
      throw new BulkEmailError("No reviewers assigned to this event", 400);
    }
    const reviewerUsers = await db.user.findMany({
      where: {
        id: {
          in: recipientIds?.length
            ? recipientIds.filter((id) => reviewerUserIds.includes(id))
            : reviewerUserIds,
        },
        role: "REVIEWER",
      },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    recipients = reviewerUsers.map((u) => ({
      id: u.id,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
    }));
  } else if (recipientType === "speakers") {
    const parsedStatus = filters?.status ? speakerStatusSchema.safeParse(filters.status) : null;
    const status = parsedStatus?.success ? parsedStatus.data : undefined;
    const speakers = await db.speaker.findMany({
      where: {
        eventId,
        ...(recipientIds?.length ? { id: { in: recipientIds } } : {}),
        ...(status && { status }),
      },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    recipients = speakers.map((s) => ({
      id: s.id,
      email: s.email,
      firstName: s.firstName,
      lastName: s.lastName,
    }));
  } else if (recipientType === "abstracts") {
    const abstracts = await db.abstract.findMany({
      where: {
        eventId,
        ...(recipientIds?.length ? { id: { in: recipientIds } } : {}),
        ...(filters?.status ? { status: filters.status as never } : {}),
      },
      select: {
        id: true,
        speaker: { select: { email: true, firstName: true, lastName: true } },
      },
    });
    const seen = new Set<string>();
    for (const a of abstracts) {
      if (!seen.has(a.speaker.email)) {
        seen.add(a.speaker.email);
        recipients.push({
          id: a.id,
          email: a.speaker.email,
          firstName: a.speaker.firstName,
          lastName: a.speaker.lastName,
        });
      }
    }
  } else {
    const parsedStatus = filters?.status ? registrationStatusSchema.safeParse(filters.status) : null;
    const status = parsedStatus?.success ? parsedStatus.data : undefined;
    const registrations = await db.registration.findMany({
      where: {
        eventId,
        ...(recipientIds?.length ? { id: { in: recipientIds } } : {}),
        ...(status && { status }),
        ...(filters?.ticketTypeId ? { ticketTypeId: filters.ticketTypeId } : {}),
      },
      select: {
        id: true,
        serialId: true,
        ticketType: { select: { name: true } },
        attendee: { select: { email: true, firstName: true, lastName: true } },
      },
    });
    recipients = registrations.map((r) => ({
      id: r.id,
      email: r.attendee.email,
      firstName: r.attendee.firstName,
      lastName: r.attendee.lastName,
      ticketType: r.ticketType?.name,
      serialId: r.serialId,
    }));
  }

  if (recipients.length === 0) {
    throw new BulkEmailError("No recipients found matching the criteria", 400);
  }

  // ── Load template ──
  // The 5 supported types map directly to template slugs.
  //
  // The 4 abstract-* types are accepted by the schema for forward-compat with
  // the abstracts-list page, but the bulk helper cannot enrich per-recipient
  // abstract context (abstractTitle, newStatus, reviewNotes…). Sending them
  // through this path would render emails with empty {{abstractTitle}}
  // placeholders, so we reject them explicitly. Send abstract status updates
  // from the abstract detail route instead, where the Abstract row is in scope.
  const slugMap: Partial<Record<BulkEmailType, string>> = {
    invitation: "speaker-invitation",
    agreement: "speaker-agreement",
    confirmation: "registration-confirmation",
    reminder: "event-reminder",
    custom: "custom-notification",
    "webinar-confirmation": "webinar-confirmation",
    "webinar-reminder-24h": "webinar-reminder-24h",
    "webinar-reminder-1h": "webinar-reminder-1h",
    "webinar-live-now": "webinar-live-now",
    "webinar-thank-you": "webinar-thank-you",
  };
  const templateSlug = slugMap[emailType];
  if (!templateSlug) {
    throw new BulkEmailError(
      `Bulk send for "${emailType}" is not supported — send from the abstract detail page instead`,
      400
    );
  }

  const tpl = (await getEventTemplate(eventId, templateSlug)) || getDefaultTemplate(templateSlug);
  if (!tpl) {
    throw new BulkEmailError(`Email template not found for slug: ${templateSlug}`, 500);
  }

  const daysUntil = event.startDate
    ? Math.max(
        1,
        Math.ceil((new Date(event.startDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
      )
    : 1;

  // Event-level branding: prefer the explicit branding shipped with a rendered
  // event template (e.g. from /api/templates/preview), else build one from the
  // event columns we just fetched. The from/name fields are what power
  // `brandingFrom()` — without them `sendEmail` falls back to provider defaults
  // and hits "Forbidden" if the default sender isn't authorized.
  const branding: EmailBranding =
    "branding" in tpl
      ? (tpl as { branding: EmailBranding }).branding
      : {
          eventName: event.name,
          emailFromAddress: event.emailFromAddress,
          emailFromName: event.emailFromName,
          emailHeaderImage: event.emailHeaderImage,
          emailFooterHtml: event.emailFooterHtml,
        };

  // ── Webinar enrichment ────────────────────────────────────────────
  // For webinar-* types, look up the anchor session + ZoomMeeting ONCE
  // (not per recipient) and inject join URL / passcode / recording into vars.
  let webinarEnrichment: {
    joinUrl: string;
    passcode: string;
    webinarDate: string;
    webinarTime: string;
    recordingUrl: string;
    passcodeBlockHtml: string;
    passcodeBlockText: string;
    recordingBlockHtml: string;
    recordingBlockText: string;
  } | null = null;

  if (isWebinarEmailType(emailType)) {
    const webinarSettings = (event.settings as { webinar?: { sessionId?: string } } | null)?.webinar;
    const anchorSessionId = webinarSettings?.sessionId;
    if (!anchorSessionId) {
      throw new BulkEmailError(
        "Webinar email requested but event has no anchor session. Run the webinar provisioner first.",
        400,
      );
    }
    const [anchorSession, zoomMeeting] = await Promise.all([
      db.eventSession.findFirst({
        where: { id: anchorSessionId, eventId },
        select: { startTime: true, endTime: true },
      }),
      db.zoomMeeting.findUnique({
        where: { sessionId: anchorSessionId },
        select: {
          joinUrl: true,
          passcode: true,
          recordingUrl: true,
          recordingPassword: true,
          recordingStatus: true,
        },
      }),
    ]);
    if (!zoomMeeting) {
      throw new BulkEmailError(
        "Webinar email requested but no Zoom webinar is attached to the anchor session.",
        400,
      );
    }
    const webinarDate = anchorSession?.startTime
      ? new Date(anchorSession.startTime).toLocaleDateString(undefined, {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : "TBA";
    const webinarTime = anchorSession?.startTime
      ? new Date(anchorSession.startTime).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          timeZoneName: "short",
        })
      : "TBA";
    const passcode = zoomMeeting.passcode ?? "";
    // Recording URL is only populated once the webinar has ended AND the
    // cron worker has successfully fetched it from Zoom. Until then, the
    // template renders a "coming soon" fallback via recordingBlock.
    const recordingUrl =
      zoomMeeting.recordingStatus === "AVAILABLE" && zoomMeeting.recordingUrl
        ? zoomMeeting.recordingUrl
        : "";
    webinarEnrichment = {
      joinUrl: zoomMeeting.joinUrl,
      passcode,
      webinarDate,
      webinarTime,
      recordingUrl,
      passcodeBlockHtml: passcode
        ? `<div style="text-align:center; margin:12px 0; color:#374151; font-size:14px;">Passcode: <strong style="font-family:monospace;">${passcode}</strong></div>`
        : "",
      passcodeBlockText: passcode ? `Passcode: ${passcode}` : "",
      recordingBlockHtml: recordingUrl
        ? `<div style="text-align:center; margin:20px 0;"><a href="${recordingUrl}" style="display:inline-block; background:#00aade; color:#ffffff; padding:12px 28px; border-radius:6px; text-decoration:none; font-weight:600;">Watch Replay</a></div>`
        : `<p style="color:#6b7280;">The recording will be available shortly. We'll send it to you as soon as it's ready.</p>`,
      recordingBlockText: recordingUrl
        ? `Watch replay: ${recordingUrl}`
        : "The recording will be available shortly. We'll send it to you as soon as it's ready.",
    };
  }

  // For speaker-targeted templates (invitation/agreement), build the rich
  // per-speaker context so greetings include the title prefix and the body
  // shows their actual sessions/topics/dates.
  const isSpeakerContextNeeded =
    recipientType === "speakers" && (emailType === "invitation" || emailType === "agreement");

  const generateEmailForRecipient = async (recipient: ResolvedRecipient) => {
    const vars: Record<string, string | number> = {
      firstName: recipient.firstName,
      lastName: recipient.lastName,
      eventName: event.name,
      eventDate,
      eventVenue,
      eventAddress: event.address || "",
      organizerName,
      organizerEmail,
      organizerSignature: organizerSignature ?? "",
      personalMessage: customMessage || "",
      ticketType: recipient.ticketType || "General Admission",
      registrationId:
        recipient.serialId != null
          ? String(recipient.serialId).padStart(3, "0")
          : recipient.id.slice(-8).toUpperCase(),
      daysUntilEvent: daysUntil,
      title: "",
      speakerName: `${recipient.firstName} ${recipient.lastName}`,
      presentationDetails: "",
      presentationDetailsText: "",
      sessionDetails: "",
    };

    if (isSpeakerContextNeeded) {
      const ctx = await buildSpeakerEmailContext(eventId, recipient.id);
      if (ctx) {
        vars.title = ctx.title;
        vars.speakerName = ctx.speakerName;
        vars.presentationDetails = ctx.presentationDetails;
        vars.presentationDetailsText = ctx.presentationDetailsText;
        vars.sessionDetails = ctx.sessionTitles.replace(/\n/g, ", ");
      }
    }

    if (emailType === "custom") {
      if (!customSubject || !customMessage) {
        throw new BulkEmailError("Custom emails require subject and message", 400);
      }
      vars.subject = customSubject;
      vars.message = customMessage;
    }

    if (webinarEnrichment) {
      vars.joinUrl = webinarEnrichment.joinUrl;
      vars.passcode = webinarEnrichment.passcode;
      vars.webinarDate = webinarEnrichment.webinarDate;
      vars.webinarTime = webinarEnrichment.webinarTime;
      vars.recordingUrl = webinarEnrichment.recordingUrl;
      vars.passcodeBlock = webinarEnrichment.passcodeBlockHtml;
      vars.passcodeBlockText = webinarEnrichment.passcodeBlockText;
      vars.recordingBlock = webinarEnrichment.recordingBlockHtml;
      vars.recordingBlockText = webinarEnrichment.recordingBlockText;
    }

    return renderAndWrap(
      tpl,
      vars,
      branding,
      new Set([
        "presentationDetails",
        "organizerSignature",
        "personalMessage",
        "passcodeBlock",
        "recordingBlock",
      ]),
    );
  };

  // ── Send in batches of 25 ──
  const BATCH_SIZE = 25;
  let successCount = 0;
  let failureCount = 0;
  const errors: Array<{ email: string; error: string }> = [];

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.allSettled(
      batch.map(async (recipient) => {
        try {
          const emailContent = await generateEmailForRecipient(recipient);

          // Per-recipient personalized .docx attachment for speaker agreements
          let recipientAttachments: BulkEmailAttachment[] | undefined = attachments;
          if (needsAgreementDocx) {
            const doc = await generateSpeakerAgreementDocx({
              eventId,
              speakerId: recipient.id,
            });
            if (!doc) {
              throw new Error("Failed to generate agreement document");
            }
            const personalizedAttachment: BulkEmailAttachment = {
              name: doc.filename,
              content: doc.buffer.toString("base64"),
              contentType: SPEAKER_AGREEMENT_DOCX_MIME,
            };
            recipientAttachments = attachments
              ? [...attachments, personalizedAttachment]
              : [personalizedAttachment];
          }

          const result = await sendEmail({
            to: [{ email: recipient.email, name: `${recipient.firstName} ${recipient.lastName}` }],
            subject: emailContent.subject,
            htmlContent: emailContent.htmlContent,
            textContent: emailContent.textContent,
            attachments: recipientAttachments,
            from: brandingFrom(branding),
            replyTo:
              (recipientType === "speakers" || recipientType === "reviewers") && organizerEmail
                ? { email: organizerEmail, name: organizerName }
                : undefined,
          });
          return { recipient, result };
        } catch (error) {
          apiLogger.error({
            err: error,
            msg: "Failed to send email to recipient",
            email: recipient.email,
          });
          return {
            recipient,
            result: {
              success: false,
              error: error instanceof Error ? error.message : "Failed to send email",
            },
          };
        }
      })
    );

    for (const r of batchResults) {
      if (r.status === "fulfilled") {
        const { recipient, result: emailResult } = r.value;
        if (emailResult.success) {
          successCount++;
        } else {
          failureCount++;
          errors.push({ email: recipient.email, error: emailResult.error || "Unknown error" });
        }
      } else {
        // Should not normally happen — the inner try/catch returns a fulfilled
        // value for any per-recipient failure. If we land here it means the
        // promise rejected before reaching the inner try (e.g. synchronous
        // throw in generateEmailForRecipient). Surface it loudly.
        failureCount++;
        apiLogger.error({ err: r.reason, msg: "bulk-email:batch-promise-rejected" });
      }
    }
  }

  return {
    total: recipients.length,
    successCount,
    failureCount,
    errors,
  };
}
