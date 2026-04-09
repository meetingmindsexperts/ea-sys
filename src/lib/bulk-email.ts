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
  | "abstract-reminder";

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
  } = input;

  // Validate attachment size
  if (attachments?.length) {
    const totalSize = attachments.reduce((sum, a) => sum + a.content.length, 0);
    if (totalSize > MAX_ATTACHMENT_SIZE) {
      throw new BulkEmailError("Total attachment size exceeds 10MB limit", 400);
    }
  }

  // Only fetch the columns we render into the email — avoids dragging back HTML
  // template fields, banner image, terms HTML, etc.
  const event = await db.event.findFirst({
    where: { id: eventId },
    select: {
      id: true,
      name: true,
      startDate: true,
      venue: true,
      address: true,
      settings: true,
    },
  });
  if (!event) {
    throw new BulkEmailError("Event not found", 404);
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

  const branding: EmailBranding =
    "branding" in tpl ? (tpl as { branding: EmailBranding }).branding : { eventName: event.name };

  const generateEmailForRecipient = (recipient: ResolvedRecipient) => {
    const vars: Record<string, string | number> = {
      firstName: recipient.firstName,
      lastName: recipient.lastName,
      eventName: event.name,
      eventDate,
      eventVenue,
      eventAddress: event.address || "",
      organizerName,
      organizerEmail,
      personalMessage: customMessage || "",
      ticketType: recipient.ticketType || "General Admission",
      registrationId:
        recipient.serialId != null
          ? String(recipient.serialId).padStart(3, "0")
          : recipient.id.slice(-8).toUpperCase(),
      daysUntilEvent: daysUntil,
    };

    if (emailType === "custom") {
      if (!customSubject || !customMessage) {
        throw new BulkEmailError("Custom emails require subject and message", 400);
      }
      vars.subject = customSubject;
      vars.message = customMessage;
    }

    return renderAndWrap(tpl, vars, branding);
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
          const emailContent = generateEmailForRecipient(recipient);
          const result = await sendEmail({
            to: [{ email: recipient.email, name: `${recipient.firstName} ${recipient.lastName}` }],
            subject: emailContent.subject,
            htmlContent: emailContent.htmlContent,
            textContent: emailContent.textContent,
            attachments,
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
          return { recipient, result: { success: false, error: "Failed to send email" } };
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
