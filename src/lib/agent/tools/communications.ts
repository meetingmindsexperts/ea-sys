import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { checkRateLimit } from "@/lib/security";
import { apiLogger } from "@/lib/logger";
import { sanitizeHtml } from "@/lib/sanitize";
import {
  SPEAKER_STATUSES,
  REGISTRATION_STATUSES,
  MAX_EMAIL_RECIPIENTS,
  type ToolExecutor,
} from "./_shared";

const sendBulkEmail: ToolExecutor = async (input, ctx) => {
  try {
    // Rate limit: 10 bulk email sends per event per hour
    const rl = checkRateLimit({
      key: `agent-email-${ctx.eventId}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      return {
        error: `Bulk email rate limit reached. Please wait ${rl.retryAfterSeconds} seconds before sending again.`,
      };
    }

    const subject = String(input.subject ?? "").trim();
    const rawHtmlMessage = String(input.htmlMessage ?? "").trim();
    if (!subject || !rawHtmlMessage) {
      return { error: "subject and htmlMessage are required" };
    }
    const htmlMessage = sanitizeHtml(rawHtmlMessage);

    const recipientType = String(input.recipientType);
    const rawStatusFilter = input.statusFilter ? String(input.statusFilter) : undefined;

    // Validate statusFilter against known enums
    if (rawStatusFilter) {
      const validSet = recipientType === "speakers" ? SPEAKER_STATUSES : REGISTRATION_STATUSES;
      if (!validSet.has(rawStatusFilter)) {
        return { error: `Invalid statusFilter "${rawStatusFilter}". Must be one of: ${[...validSet].join(", ")}` };
      }
    }
    const statusFilter = rawStatusFilter;

    let recipients: { email: string; name: string }[] = [];

    if (recipientType === "speakers") {
      const speakers = await db.speaker.findMany({
        where: {
          eventId: ctx.eventId,
          ...(statusFilter ? { status: statusFilter as never } : {}),
        },
        select: { email: true, firstName: true, lastName: true },
      });
      recipients = speakers.map((s) => ({
        email: s.email,
        name: `${s.firstName} ${s.lastName}`.trim(),
      }));
    } else if (recipientType === "registrations") {
      const registrations = await db.registration.findMany({
        where: {
          eventId: ctx.eventId,
          ...(statusFilter ? { status: statusFilter as never } : {}),
        },
        select: {
          attendee: { select: { email: true, firstName: true, lastName: true } },
        },
      });
      recipients = registrations.map((r) => ({
        email: r.attendee.email,
        name: `${r.attendee.firstName} ${r.attendee.lastName}`.trim(),
      }));
    } else {
      return { error: "recipientType must be 'speakers' or 'registrations'" };
    }

    if (recipients.length === 0) {
      return { error: "No recipients found matching the given filters" };
    }

    if (recipients.length > MAX_EMAIL_RECIPIENTS) {
      return {
        error: `Too many recipients (${recipients.length}). Maximum is ${MAX_EMAIL_RECIPIENTS} per bulk email. Use a statusFilter to narrow the audience.`,
      };
    }

    let sent = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const recipient of recipients) {
      try {
        await sendEmail({
          to: [{ email: recipient.email, name: recipient.name }],
          subject,
          htmlContent: htmlMessage,
        });
        sent++;
      } catch (emailErr) {
        failed++;
        errors.push(`Failed to send to ${recipient.email}`);
        apiLogger.warn({ emailErr, to: recipient.email }, "agent:send_bulk_email individual send failed");
      }
    }

    return {
      success: true,
      sent,
      failed,
      total: recipients.length,
      errors: errors.slice(0, 5),
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:send_bulk_email failed");
    return { error: "Failed to send bulk email" };
  }
};

const listMedia: ToolExecutor = async (input, ctx) => {
  try {
    const limit = Math.min(Number(input.limit ?? 50), 100);
    const files = await db.mediaFile.findMany({
      where: { organizationId: ctx.organizationId },
      select: { id: true, filename: true, url: true, mimeType: true, size: true, createdAt: true },
      take: limit,
      orderBy: { createdAt: "desc" },
    });
    return { files, total: files.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_media failed");
    return { error: "Failed to fetch media files" };
  }
};

// ─── Check-in Executor ────────────────────────────────────────────────────────

const listEmailTemplates: ToolExecutor = async (_input, ctx) => {
  try {
    const templates = await db.emailTemplate.findMany({
      where: { eventId: ctx.eventId },
      select: { id: true, name: true, subject: true, slug: true, isActive: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    return { templates, total: templates.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_email_templates failed");
    return { error: "Failed to fetch email templates" };
  }
};

// ─── Event Stats Executor ─────────────────────────────────────────────────────

const listScheduledEmails: ToolExecutor = async (_input, ctx) => {
  try {
    const event = await db.event.findFirst({
      where: { id: ctx.eventId, organizationId: ctx.organizationId },
      select: { id: true },
    });
    if (!event) return { error: "Event not found or access denied" };

    const rows = await db.scheduledEmail.findMany({
      where: { eventId: ctx.eventId },
      select: {
        id: true,
        recipientType: true,
        emailType: true,
        customSubject: true,
        scheduledFor: true,
        status: true,
        sentAt: true,
        successCount: true,
        failureCount: true,
        totalCount: true,
        lastError: true,
        createdAt: true,
      },
      orderBy: { scheduledFor: "desc" },
      take: 200,
    });

    return { scheduledEmails: rows, total: rows.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_scheduled_emails failed");
    return { error: "Failed to list scheduled emails" };
  }
};

const cancelScheduledEmail: ToolExecutor = async (input, ctx) => {
  try {
    const scheduledEmailId = String(input.scheduledEmailId ?? "").trim();
    if (!scheduledEmailId) return { error: "scheduledEmailId is required" };

    const existing = await db.scheduledEmail.findFirst({
      where: { id: scheduledEmailId, event: { organizationId: ctx.organizationId } },
      select: { id: true, status: true, eventId: true },
    });
    if (!existing) return { error: `Scheduled email ${scheduledEmailId} not found or access denied` };

    if (existing.status !== "PENDING") {
      return { error: `Cannot cancel: status is ${existing.status}. Only PENDING rows can be cancelled.` };
    }

    const updated = await db.scheduledEmail.update({
      where: { id: scheduledEmailId },
      data: { status: "CANCELLED" },
      select: { id: true, status: true, scheduledFor: true },
    });

    await db.auditLog.create({
      data: {
        eventId: existing.eventId,
        userId: ctx.userId,
        action: "CANCEL",
        entityType: "ScheduledEmail",
        entityId: scheduledEmailId,
        changes: { source: "mcp", previousStatus: "PENDING" },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:cancel_scheduled_email audit-log-failed"));

    return { success: true, scheduledEmail: updated };
  } catch (err) {
    apiLogger.error({ err }, "agent:cancel_scheduled_email failed");
    return { error: err instanceof Error ? err.message : "Failed to cancel scheduled email" };
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// Sprint A batch 2 (April 2026) — accommodation CREATE + invoice + email templates
// ═══════════════════════════════════════════════════════════════════════════════

// ─── A3: Accommodation CREATE flow ────────────────────────────────────────────

const updateEmailTemplate: ToolExecutor = async (input, ctx) => {
  try {
    const slug = String(input.slug ?? "").trim();
    if (!slug) return { error: "slug is required (e.g. 'speaker-invitation', 'registration-confirmation')" };

    // Look up the event-specific template by slug. If none exists, we create one
    // (this is how the user "overrides" a default template).
    const existing = await db.emailTemplate.findFirst({
      where: { eventId: ctx.eventId, slug },
      select: { id: true, subject: true, htmlContent: true, textContent: true },
    });

    const subject = input.subject != null ? String(input.subject).slice(0, 500) : undefined;
    const htmlContent = input.htmlContent != null ? String(input.htmlContent).slice(0, 100000) : undefined;
    const textContent = input.textContent != null ? String(input.textContent).slice(0, 50000) : undefined;
    const name = input.name != null ? String(input.name).slice(0, 200) : undefined;

    if (subject === undefined && htmlContent === undefined && textContent === undefined) {
      return { error: "At least one of subject, htmlContent, or textContent must be provided" };
    }

    let updated;
    if (existing) {
      updated = await db.emailTemplate.update({
        where: { id: existing.id },
        data: {
          ...(subject !== undefined && { subject }),
          ...(htmlContent !== undefined && { htmlContent }),
          ...(textContent !== undefined && { textContent }),
          ...(name !== undefined && { name }),
        },
        select: { id: true, slug: true, name: true, subject: true },
      });
    } else {
      // No event-specific override yet — seed one. Pull defaults from email.ts
      // so the missing fields don't end up empty.
      const { getDefaultTemplate } = await import("@/lib/email");
      const defaultTpl = getDefaultTemplate(slug);
      if (!defaultTpl) {
        return { error: `Unknown template slug "${slug}". Check list_email_templates for valid slugs.` };
      }
      updated = await db.emailTemplate.create({
        data: {
          eventId: ctx.eventId,
          slug,
          name: name ?? defaultTpl.name,
          subject: subject ?? defaultTpl.subject,
          htmlContent: htmlContent ?? defaultTpl.htmlContent,
          textContent: textContent ?? defaultTpl.textContent,
          isActive: true,
        },
        select: { id: true, slug: true, name: true, subject: true },
      });
    }

    db.auditLog.create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "UPDATE",
        entityType: "EmailTemplate",
        entityId: updated.id,
        changes: {
          source: "mcp",
          slug,
          fieldsChanged: [
            ...(subject !== undefined ? ["subject"] : []),
            ...(htmlContent !== undefined ? ["htmlContent"] : []),
            ...(textContent !== undefined ? ["textContent"] : []),
          ],
        },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:update_email_template audit-log-failed"));

    return { success: true, template: updated };
  } catch (err) {
    apiLogger.error({ err }, "agent:update_email_template failed");
    return { error: err instanceof Error ? err.message : "Failed to update email template" };
  }
};

const resetEmailTemplate: ToolExecutor = async (input, ctx) => {
  try {
    const slug = String(input.slug ?? "").trim();
    if (!slug) return { error: "slug is required" };

    const existing = await db.emailTemplate.findFirst({
      where: { eventId: ctx.eventId, slug },
      select: { id: true, slug: true },
    });
    if (!existing) {
      return {
        success: true,
        message: `No event-level override exists for "${slug}" — already using default template`,
      };
    }

    await db.emailTemplate.delete({ where: { id: existing.id } });

    db.auditLog.create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "DELETE",
        entityType: "EmailTemplate",
        entityId: existing.id,
        changes: { source: "mcp", slug, note: "Reset to default — event-level override removed" },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:reset_email_template audit-log-failed"));

    return { success: true, slug, message: "Event-level override removed. The default template will be used on next send." };
  } catch (err) {
    apiLogger.error({ err }, "agent:reset_email_template failed");
    return { error: err instanceof Error ? err.message : "Failed to reset email template" };
  }
};

// ─── Tranche 2: bulk creates + update_contact + update_event ─────────────────

export const COMMUNICATION_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "send_bulk_email",
    description:
      "Send a bulk email to speakers or registrants. IMPORTANT: Before calling this tool, inform the user what you plan to send and to how many recipients. Specify recipientType (speakers or registrations), emailType, a subject, and HTML message content.",
    input_schema: {
      type: "object" as const,
      properties: {
        recipientType: {
          type: "string",
          enum: ["speakers", "registrations"],
          description: "Who to send the email to",
        },
        emailType: {
          type: "string",
          enum: ["custom", "invitation", "confirmation", "reminder"],
          description: "Type of email",
        },
        subject: { type: "string", description: "Email subject line" },
        htmlMessage: {
          type: "string",
          description: "HTML content of the email body",
        },
        statusFilter: {
          type: "string",
          description:
            "Optional status filter: e.g. CONFIRMED for registrations, INVITED for speakers",
        },
      },
      required: ["recipientType", "emailType", "subject", "htmlMessage"],
    },
  },
  {
    name: "list_media",
    description: "List media files in the organization library. Optionally filter by event.",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max results (default 50)" },
      },
      required: [],
    },
  },
  {
    name: "list_email_templates",
    description: "List email templates configured for this event.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
];

export const COMMUNICATION_EXECUTORS: Record<string, ToolExecutor> = {
  send_bulk_email: sendBulkEmail,
  list_email_templates: listEmailTemplates,
  update_email_template: updateEmailTemplate,
  reset_email_template: resetEmailTemplate,
  list_scheduled_emails: listScheduledEmails,
  cancel_scheduled_email: cancelScheduledEmail,
  list_media: listMedia,
};
