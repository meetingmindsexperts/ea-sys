/**
 * Create a CUSTOM per-event email template: ONE implementation for the REST
 * POST (Communications, Email Templates, New) and the `create_email_template`
 * tool on both agent doors (September 22, 2026).
 *
 * A custom template is one an organiser writes for their own purpose (joining
 * instructions, a faculty welcome, a sponsor briefing). It has no built-in
 * default, its slug is its own, and it is sent as a saved template from the
 * bulk-email dialog (any audience) or the per-speaker Send Email menu. The
 * system templates (`speaker-invitation`, `registration-confirmation`, ...)
 * are never created here: an event's own copy of one of those is made by
 * editing it, which is `update_email_template` on the agent doors and the
 * templates list on the dashboard.
 *
 * Why one: the REST route carried the create inline (existence check, then
 * create; a race between two creates surfaced as a raw P2002 500), and the
 * agent had no way to create a template at all, only to overwrite a system
 * one. Both paths now call this, so the slug rule, the token normalisation
 * and the taken-slug answer cannot drift.
 *
 * Server-only (reads and writes the database).
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { normalizeTemplateTokens, unknownTemplateTokens } from "@/lib/template-tokens";
import { templateAllowedTokenKeys } from "@/lib/email-template-registry";
import { getDefaultTemplate } from "@/lib/email";
import { isCustomTemplateSlug } from "@/lib/email-template-slugs";

/**
 * A slug is a KEY, not a label: `eventId_slug` is unique, `isCustomTemplateSlug`
 * classifies on it and the bulk-email dialog sends by it. The rule matches
 * what the templates page produces from a typed name.
 */
export const EMAIL_TEMPLATE_SLUG_RE = /^[a-z0-9-]+$/;
export const EMAIL_TEMPLATE_SLUG_MAX = 100;

/** The templates page's rule for turning a typed name into a slug, byte for byte. */
export function slugifyTemplateName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, EMAIL_TEMPLATE_SLUG_MAX);
}

export type CreatedEmailTemplate = {
  id: string;
  eventId: string;
  slug: string;
  name: string;
  subject: string;
  htmlContent: string;
  textContent: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateEmailTemplateResult =
  | {
      ok: true;
      template: CreatedEmailTemplate;
      /**
       * Tokens in the saved text that no sender fills on a custom template.
       * Reported, never refused, to match the dashboard: the send itself is
       * refused later by the unresolved-token guard, and the caller is told
       * here so it can fix the text first.
       */
      unknownTokens: string[];
    }
  | { ok: false; code: "INVALID_SLUG" | "SLUG_TAKEN"; message: string }
  | {
      ok: false;
      code: "UNKNOWN_TOKENS";
      message: string;
      unknownTokens: string[];
      /** Every token a custom template's senders fill, for the caller to choose from. */
      allowedTokens: string[];
    };

export async function createCustomEmailTemplate(args: {
  eventId: string;
  slug: string;
  name: string;
  subject: string;
  htmlContent: string;
  textContent?: string | null;
  /**
   * Refuse a token no sender fills instead of reporting it. The agent doors
   * pass this (owner, September 22, 2026: "an AI agent should not create new
   * variables, it should use existing variables"); the dashboard keeps the
   * September 18 behaviour, a warning beside the editor, because an
   * organiser typing a token may be about to fix it.
   */
  refuseUnknownTokens?: boolean;
  /** Whether the new template can be sent right away. Default true; a duplicate starts false. */
  isActive?: boolean;
}): Promise<CreateEmailTemplateResult> {
  const { eventId, slug, name } = args;

  if (!slug || slug.length > EMAIL_TEMPLATE_SLUG_MAX || !EMAIL_TEMPLATE_SLUG_RE.test(slug)) {
    apiLogger.warn({ msg: "email-template-create:invalid-slug", eventId, slug });
    return {
      ok: false,
      code: "INVALID_SLUG",
      message: "Slug may contain only lowercase letters, numbers and hyphens (at most 100 characters).",
    };
  }

  const subject = normalizeTemplateTokens(args.subject);
  const htmlContent = normalizeTemplateTokens(args.htmlContent);
  // null and undefined are preserved as they came (the REST callers rely on
  // the distinction); only a non-empty string is normalised.
  const textContent = args.textContent ? normalizeTemplateTokens(args.textContent) : args.textContent;

  const allowedTokens = templateAllowedTokenKeys(slug);
  const unknownTokens = unknownTemplateTokens(allowedTokens, subject, htmlContent, textContent);
  if (args.refuseUnknownTokens && unknownTokens.length > 0) {
    apiLogger.warn({ msg: "email-template-create:unknown-tokens-refused", eventId, slug, unknownTokens });
    return {
      ok: false,
      code: "UNKNOWN_TOKENS",
      unknownTokens,
      allowedTokens,
      message:
        `The text uses tokens no sender fills: ${unknownTokens.map((t) => `{{${t}}}`).join(", ")}. ` +
        "Only existing tokens can be used; write the value out in words instead, or pick from the tokens the send fills.",
    };
  }

  const existing = await db.emailTemplate.findUnique({
    where: { eventId_slug: { eventId, slug } },
    select: { id: true },
  });
  if (existing) {
    apiLogger.warn({ msg: "email-template-create:slug-taken", eventId, slug });
    return { ok: false, code: "SLUG_TAKEN", message: `A template with the slug "${slug}" already exists on this event.` };
  }

  try {
    const template = await db.emailTemplate.create({
      data: { eventId, slug, name, subject, htmlContent, textContent, ...(args.isActive === false && { isActive: false }) },
    });
    apiLogger.info({ msg: "email-template-create:created", eventId, slug, templateId: template.id, unknownTokens });
    return { ok: true, template, unknownTokens };
  } catch (err) {
    // Two creates racing past the existence check: the unique index decides,
    // and the loser is told the slug is taken rather than shown a 500.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      apiLogger.warn({ msg: "email-template-create:slug-taken-race", eventId, slug });
      return { ok: false, code: "SLUG_TAKEN", message: `A template with the slug "${slug}" already exists on this event.` };
    }
    throw err;
  }
}

// ── Duplicate (September 25, 2026) ────────────────────────────────────────────
//
// Owner: "give an option to clone or duplicate a template manually and for the
// AI agent; starting state is disabled, set active, slug will be different."
// The agent could not do it: nothing returned a template's body. The copy is a
// CUSTOM template (its own slug, never a built-in one), starts disabled so it
// cannot be sent until someone switches it on, and keeps the source's text as
// is: its tokens are reported, never refused, because they were copied rather
// than invented. Plan: docs/EMAIL_TEMPLATE_DUPLICATE_PLAN.md.

/** How many numbered names a duplicate tries before giving up ("-copy" … "-copy-50"). */
const MAX_COPY_NUMBER = 50;

/** "<base>-copy" for the first copy, "<base>-copy-<n>" after; trimmed to the slug limit. */
export function copySlug(base: string, n: number): string {
  const suffix = n === 1 ? "-copy" : `-copy-${n}`;
  const head = base.slice(0, EMAIL_TEMPLATE_SLUG_MAX - suffix.length).replace(/-+$/, "");
  return `${head}${suffix}`;
}

/** "<name> (copy)" for the first copy, "<name> (copy <n>)" after; trimmed to the 200-character name limit. */
export function copyName(base: string, n: number): string {
  const suffix = n === 1 ? " (copy)" : ` (copy ${n})`;
  return `${base.slice(0, 200 - suffix.length).trimEnd()}${suffix}`;
}

export type DuplicateEmailTemplateResult =
  | { ok: true; template: CreatedEmailTemplate; source: { id: string | null; slug: string; name: string }; unknownTokens: string[] }
  | { ok: false; code: "SOURCE_NOT_FOUND" | "NO_FREE_SLUG" | "INVALID_NAME"; message: string };

export async function duplicateEmailTemplate(args: {
  eventId: string;
  /** Exactly one of the two: the dashboard sends the row id, the agent the slug. */
  sourceId?: string;
  sourceSlug?: string;
  /** Optional name for the copy; its slug is derived from it. Default "<source name> (copy)". */
  name?: string;
}): Promise<DuplicateEmailTemplateResult> {
  const { eventId } = args;
  const source = await resolveSource(args);
  if (!source) {
    apiLogger.warn({ msg: "email-template-duplicate:source-not-found", eventId, sourceId: args.sourceId, sourceSlug: args.sourceSlug });
    return { ok: false, code: "SOURCE_NOT_FOUND", message: "The template to copy was not found on this event." };
  }

  const typedName = args.name?.trim().slice(0, 200);
  const baseSlug = typedName ? slugifyTemplateName(typedName) : source.slug;
  if (!baseSlug) {
    apiLogger.warn({ msg: "email-template-duplicate:invalid-name", eventId, name: typedName });
    return { ok: false, code: "INVALID_NAME", message: "The name must contain at least one letter or digit." };
  }

  // A typed name is used as is for the first try (its slug is new); otherwise
  // every try is numbered. The slug decides: a SLUG_TAKEN, from the check or
  // the race, moves to the next number.
  for (let n = 1; n <= MAX_COPY_NUMBER; n++) {
    const slug = typedName && n === 1 ? baseSlug : copySlug(baseSlug, n);
    if (!isCustomTemplateSlug(slug)) continue;
    const name = typedName ? (n === 1 ? typedName : copyName(typedName, n)) : copyName(source.name, n);
    const result = await createCustomEmailTemplate({
      eventId, slug, name,
      subject: source.subject, htmlContent: source.htmlContent, textContent: source.textContent,
      isActive: false,
    });
    if (result.ok) {
      apiLogger.info({ msg: "email-template-duplicate:created", eventId, sourceSlug: source.slug, slug, templateId: result.template.id });
      return { ok: true, template: result.template, source: { id: source.id, slug: source.slug, name: source.name }, unknownTokens: result.unknownTokens };
    }
    if (result.code !== "SLUG_TAKEN") {
      // Cannot happen for a slug built from a valid base, but a refusal is
      // never swallowed: report it as the dead end it is.
      apiLogger.warn({ msg: "email-template-duplicate:create-refused", eventId, slug, code: result.code });
      return { ok: false, code: "NO_FREE_SLUG", message: result.message };
    }
  }
  apiLogger.warn({ msg: "email-template-duplicate:no-free-slug", eventId, baseSlug });
  return { ok: false, code: "NO_FREE_SLUG", message: `Every name from "${baseSlug}-copy" to "${baseSlug}-copy-${MAX_COPY_NUMBER}" is taken; delete an old copy or give this one a name.` };
}

type TemplateSource = { id: string | null; slug: string; name: string; subject: string; htmlContent: string; textContent: string | null };

/** The event's row by id or slug; for a built-in slug with no row yet, the built-in default text. */
async function resolveSource(args: { eventId: string; sourceId?: string; sourceSlug?: string }): Promise<TemplateSource | null> {
  const select = { id: true, slug: true, name: true, subject: true, htmlContent: true, textContent: true } as const;
  if (args.sourceId) {
    return db.emailTemplate.findFirst({ where: { id: args.sourceId, eventId: args.eventId }, select });
  }
  const slug = args.sourceSlug?.trim();
  if (!slug) return null;
  const row = await db.emailTemplate.findUnique({ where: { eventId_slug: { eventId: args.eventId, slug } }, select });
  if (row) return row;
  const builtIn = getDefaultTemplate(slug);
  return builtIn ? { id: null, ...builtIn } : null;
}
