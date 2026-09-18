/**
 * Reset a per-event SYSTEM email template to the built-in default: ONE
 * implementation for the REST PATCH (Communications, Email Templates, "Reset
 * to Default") and the MCP `reset_email_template` tool.
 *
 * Why one: the two used to differ in a way that lost data. REST overwrote
 * the row in place and refused a custom slug; MCP found the row by slug and
 * DELETED it for any slug, with a message saying "the default will be used".
 * A custom template (one an organizer created, such as joining
 * instructions) has no default, so the MCP path destroyed the only copy
 * (September 18, 2026 review). Both paths now call this.
 *
 * Server-only (reads the database). Never deletes a row: a system template
 * is overwritten with the default text and re-enabled, so its id, its audit
 * history and its place in the list survive.
 */
import { db } from "@/lib/db";
import { getDefaultTemplate } from "@/lib/email";
import { isCustomTemplateSlug } from "@/lib/email-template-slugs";
import { apiLogger } from "@/lib/logger";

export type ResetEmailTemplateResult =
  | { ok: true; template: { id: string; slug: string; name: string; subject: string; isActive: boolean } | null }
  | { ok: false; code: "CUSTOM_SLUG" | "NO_DEFAULT"; message: string };

export async function resetEmailTemplateToDefault(args: {
  eventId: string;
  slug: string;
}): Promise<ResetEmailTemplateResult> {
  const { eventId, slug } = args;

  if (isCustomTemplateSlug(slug)) {
    apiLogger.warn({ msg: "email-template-reset:custom-slug-refused", eventId, slug });
    return {
      ok: false,
      code: "CUSTOM_SLUG",
      message: `"${slug}" is a template you created; it has no built-in default to reset to. Edit or delete it instead.`,
    };
  }

  const defaultTpl = getDefaultTemplate(slug);
  if (!defaultTpl) {
    apiLogger.warn({ msg: "email-template-reset:no-default", eventId, slug });
    return { ok: false, code: "NO_DEFAULT", message: `No default template exists for "${slug}".` };
  }

  const existing = await db.emailTemplate.findFirst({
    where: { eventId, slug },
    select: { id: true },
  });
  if (!existing) {
    // Nothing saved for this event yet: the default is what sends already.
    return { ok: true, template: null };
  }

  const template = await db.emailTemplate.update({
    where: { id: existing.id },
    data: {
      subject: defaultTpl.subject,
      htmlContent: defaultTpl.htmlContent,
      textContent: defaultTpl.textContent,
      name: defaultTpl.name,
      isActive: true,
    },
    select: { id: true, slug: true, name: true, subject: true, isActive: true },
  });
  apiLogger.info({ msg: "email-template-reset:applied", eventId, slug, templateId: template.id });
  return { ok: true, template };
}
