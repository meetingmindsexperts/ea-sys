import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit } from "@/lib/security";
import { apiLogger } from "@/lib/logger";
import { sanitizeHtml } from "@/lib/sanitize";
import { executeBulkEmail, BulkEmailError } from "@/lib/bulk-email";
import { resetEmailTemplateToDefault } from "@/lib/email-template-reset";
import {
  MAX_EMAIL_RECIPIENTS,
  type ToolExecutor,
} from "./_shared";

// Routes through the SHARED executeBulkEmail pipeline (cross-caller parity,
// July 13 2026): this executor used to carry its own inline recipient
// resolution + send loop, which silently missed everything the shared
// pipeline gained — the send-viability precheck, the INVALID_FILTER guard
// (a bad filter can no longer widen the audience to everyone), per-event
// branding + CSS inlining via the custom-notification template, and the
// unified per-recipient EmailLog threading. Still sends INLINE (the JSON-RPC
// return contract for n8n/claude.ai is sync — jobifying stays deferred).
const sendBulkEmail: ToolExecutor = async (input, ctx) => {
  try {
    // Rate limit: 10 bulk email sends per event per hour
    const BULK_EMAIL_LIMIT = 10;
    const BULK_EMAIL_WINDOW_MS = 60 * 60 * 1000;
    const rl = checkRateLimit({
      key: `agent-email-${ctx.eventId}`,
      limit: BULK_EMAIL_LIMIT,
      windowMs: BULK_EMAIL_WINDOW_MS,
    });
    if (!rl.allowed) {
      return {
        error: `Rate limit exceeded: ${BULK_EMAIL_LIMIT} bulk email sends per event per hour. Retry after ${rl.retryAfterSeconds}s.`,
        code: "RATE_LIMITED",
        retryAfterSeconds: rl.retryAfterSeconds,
        limit: BULK_EMAIL_LIMIT,
        windowSeconds: Math.floor(BULK_EMAIL_WINDOW_MS / 1000),
      };
    }

    const subject = String(input.subject ?? "").trim();
    const rawHtmlMessage = String(input.htmlMessage ?? "").trim();
    if (!subject || !rawHtmlMessage) {
      return { error: "subject and htmlMessage are required" };
    }
    const htmlMessage = sanitizeHtml(rawHtmlMessage);

    const recipientType = String(input.recipientType);
    if (recipientType !== "speakers" && recipientType !== "registrations") {
      return { error: "recipientType must be 'speakers' or 'registrations'" };
    }
    const statusFilter = input.statusFilter ? String(input.statusFilter) : undefined;
    const paymentStatusFilter = input.paymentStatusFilter ? String(input.paymentStatusFilter) : undefined;
    // paymentStatusFilter is only meaningful for registrations — reject early
    // rather than silently ignoring it on the speakers branch (W2-F4).
    if (paymentStatusFilter && recipientType !== "registrations") {
      return { error: "paymentStatusFilter is only valid when recipientType is 'registrations'." };
    }
    const filters = {
      ...(statusFilter && { status: statusFilter }),
      ...(paymentStatusFilter && { paymentStatus: paymentStatusFilter }),
    };

    // Tenancy (Certificates-sweep review H2): the count reads below hit swept
    // Registration/Speaker, and executeBulkEmail reads swept recipients + (for
    // certificate sends) swept cert tables — all must run in the caller's org.
    return await runWithTenant(ctx.organizationId, async () => {
    // Inline-send size cap (the shared pipeline itself is uncapped — the REST
    // path is drained by the worker; this JSON-RPC call blocks until done).
    // MCP exposes exactly the two filters below, so this count == the send.
    const recipientCount =
      recipientType === "speakers"
        ? await db.speaker.count({
            where: { eventId: ctx.eventId, ...(statusFilter ? { status: statusFilter as never } : {}) },
          })
        : await db.registration.count({
            where: {
              eventId: ctx.eventId,
              ...(statusFilter ? { status: statusFilter as never } : {}),
              ...(paymentStatusFilter ? { paymentStatus: paymentStatusFilter as never } : {}),
            },
          });
    if (recipientCount > MAX_EMAIL_RECIPIENTS) {
      return {
        error: `Too many recipients (${recipientCount}). Maximum is ${MAX_EMAIL_RECIPIENTS} per bulk email. Use a statusFilter to narrow the audience.`,
      };
    }

    // Organizer identity for the {{organizerName}}/signature template vars —
    // the triggering user when it's a real session, else the event's sender.
    const [user, event] = await Promise.all([
      ctx.userId && ctx.userId !== "mcp-remote"
        ? db.user.findUnique({
            where: { id: ctx.userId },
            select: { firstName: true, lastName: true, email: true, emailSignature: true },
          })
        : Promise.resolve(null),
      db.event.findUnique({
        where: { id: ctx.eventId },
        select: { name: true, emailFromAddress: true, emailFromName: true },
      }),
    ]);
    const organizerName =
      (user && `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim()) ||
      event?.emailFromName ||
      event?.name ||
      "Event Team";
    const organizerEmail = user?.email || event?.emailFromAddress || "";

    const result = await executeBulkEmail({
      eventId: ctx.eventId,
      recipientType,
      emailType: "custom",
      customSubject: subject,
      customMessage: htmlMessage,
      // The tool contract is an HTML body (sanitized above via sanitizeHtml).
      // Without this flag the shared pipeline escapes {{message}} and the
      // whole audience receives literal markup (review A1 — regression in
      // the 6f5f6e9 pipeline rewire).
      customMessageIsHtml: true,
      filters,
      organizerName,
      organizerEmail,
      organizerSignature: user?.emailSignature ?? undefined,
      organizationId: ctx.organizationId,
      triggeredByUserId: ctx.userId && ctx.userId !== "mcp-remote" ? ctx.userId : null,
    });

    return {
      success: true,
      sent: result.successCount,
      failed: result.failureCount,
      total: result.total,
      errors: result.errors.slice(0, 5).map((e) => `Failed to send to ${e.email}`),
    };
    });
  } catch (err) {
    // Business rejections from the shared pipeline (no recipients, invalid
    // filter, missing viability prerequisite) come back coded, not opaque.
    if (err instanceof BulkEmailError) {
      apiLogger.warn({ msg: "agent:send_bulk_email rejected", eventId: ctx.eventId, code: err.code, error: err.message });
      return { error: err.message, ...(err.code ? { code: err.code } : {}) };
    }
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
    // Tenancy (Domain #18): swept ScheduledEmail read on the caller's org lane.
    return await runWithTenant(ctx.organizationId, async () => {
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
    });
  } catch (err) {
    apiLogger.error({ err }, "agent:list_scheduled_emails failed");
    return { error: "Failed to list scheduled emails" };
  }
};

const cancelScheduledEmail: ToolExecutor = async (input, ctx) => {
  try {
    const scheduledEmailId = String(input.scheduledEmailId ?? "").trim();
    if (!scheduledEmailId) return { error: "scheduledEmailId is required" };

    // Tenancy (Domain #18): swept ScheduledEmail cancel on the caller's org
    // lane; the update also org-binds atomically (defence #1 — the bare
    // update-by-id after a findFirst was the compound-where class).
    return await runWithTenant(ctx.organizationId, async () => {
    const existing = await db.scheduledEmail.findFirst({
      where: { id: scheduledEmailId, event: { organizationId: ctx.organizationId } },
      select: { id: true, status: true, eventId: true },
    });
    if (!existing) return { error: `Scheduled email ${scheduledEmailId} not found or access denied` };

    if (existing.status !== "PENDING") {
      return { error: `Cannot cancel: status is ${existing.status}. Only PENDING rows can be cancelled.` };
    }

    const updated = await db.scheduledEmail.update({
      where: { id: scheduledEmailId, organizationId: ctx.organizationId },
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
        changes: { source: ctx.source, previousStatus: "PENDING" },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:cancel_scheduled_email audit-log-failed"));

    return { success: true, scheduledEmail: updated };
    });
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
          source: ctx.source,
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

    // The SAME reset the dashboard runs (src/lib/email-template-reset.ts):
    // overwrite a system template with its default, refuse a custom slug.
    // This tool used to DELETE the row for any slug, which destroyed the
    // only copy of an organizer-created template (September 18, 2026).
    const result = await resetEmailTemplateToDefault({ eventId: ctx.eventId, slug });
    if (!result.ok) return { error: result.message, code: result.code };
    if (!result.template) {
      return {
        success: true,
        slug,
        message: `No saved copy of "${slug}" exists for this event; the default template is already what sends.`,
      };
    }

    db.auditLog.create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "UPDATE",
        entityType: "EmailTemplate",
        entityId: result.template.id,
        changes: { source: ctx.source, slug, note: "Reset to default (content overwritten in place, template re-enabled)" },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:reset_email_template audit-log-failed"));

    return { success: true, slug, template: result.template, message: "Template reset to the built-in default." };
  } catch (err) {
    apiLogger.error({ err }, "agent:reset_email_template failed");
    return { error: err instanceof Error ? err.message : "Failed to reset email template" };
  }
};

// ─── Tranche 2: bulk creates + update_contact + update_event ─────────────────

export const COMMUNICATION_EXECUTORS: Record<string, ToolExecutor> = {
  send_bulk_email: sendBulkEmail,
  list_email_templates: listEmailTemplates,
  update_email_template: updateEmailTemplate,
  reset_email_template: resetEmailTemplate,
  list_scheduled_emails: listScheduledEmails,
  cancel_scheduled_email: cancelScheduledEmail,
  list_media: listMedia,
};
