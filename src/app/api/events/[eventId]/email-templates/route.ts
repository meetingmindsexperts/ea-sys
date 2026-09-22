import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
import { denyReviewer, WEBINAR_STAFF_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { DEFAULT_TEMPLATES, allTemplateVariables } from "@/lib/email";
import { isWebinarTemplateSlug } from "@/lib/email-template-slugs";
import {
  EMAIL_TEMPLATE_SLUG_MAX,
  EMAIL_TEMPLATE_SLUG_RE,
  createCustomEmailTemplate,
} from "@/lib/email-template-create";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

/**
 * Create a custom email template (Sep 21, 2026 security review, finding #5).
 *
 * This used to be a truthiness check on the destructured body, which is not a
 * type check: `slug: 12345` is truthy, reached Prisma, and surfaced as a raw
 * PrismaClientValidationError — a 500 reading "Failed to create email
 * template", which tells the organiser nothing and puts nothing useful in
 * /logs either. The required set below is byte-identical to the old check
 * (`.min(1)` rejects the empty string exactly as falsiness did), so the happy
 * path is unchanged; the difference is that a malformed request is now a
 * logged 400 naming the field instead of an opaque 500.
 *
 * The slug format matches what the only client already sends: the templates
 * page slugifies the typed name to `[a-z0-9-]` before POSTing. It is a KEY,
 * not a label — `eventId_slug` is unique, `isCustomTemplateSlug` classifies on
 * it, and the bulk-email dialog sends by it — so it is worth pinning. The
 * rule itself lives in email-template-create.ts, which the agent's
 * create_email_template tool shares (September 22, 2026).
 */
const createTemplateSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(EMAIL_TEMPLATE_SLUG_MAX)
    .regex(EMAIL_TEMPLATE_SLUG_RE, "Slug may contain only lowercase letters, numbers and hyphens"),
  name: z.string().min(1).max(200),
  subject: z.string().min(1).max(500),
  // No size cap on the two content fields: the columns are @db.Text and the
  // middleware already bounds every API body at 1 MB (src/lib/body-limits.ts),
  // so a cap here could only ever be a NEW restriction the column never had.
  htmlContent: z.string().min(1),
  // Kept nullish rather than defaulted: the write below preserves null vs
  // undefined vs "" exactly as it did before, and callers rely on that.
  textContent: z.string().nullish(),
});

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "email-templates:list", eventId });
    if ("error" in orgGuard) return orgGuard.error;

    // Scope by role, not org: reviewers + submitters are org-independent
    // (organizationId = null), so an `organizationId!` filter threw a Prisma
    // validation error ("must not be null") when a reviewer opened the
    // abstracts page (which mounts BulkEmailDialog → fetches this endpoint via
    // useEmailTemplates). For ADMIN/ORGANIZER this returns the identical
    // org-scoped query — no behavior change for staff.
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, eventType: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // The auto-webinar email templates only apply to WEBINAR events. On a
    // conference (or any non-webinar) event they're never sent, so we neither
    // seed them nor return them — keeping them out of the Email Templates list
    // and every surface that reads this endpoint.
    const isWebinarEvent = event.eventType === "WEBINAR";
    const isVisible = (slug: string) => isWebinarEvent || !isWebinarTemplateSlug(slug);

    let templates = await db.emailTemplate.findMany({
      where: { eventId },
      orderBy: { createdAt: "asc" },
    });

    // Seed missing templates — covers both fresh events and newly added
    // templates. Skip webinar templates on non-webinar events.
    const existingSlugs = new Set(templates.map((t) => t.slug));
    const missing = DEFAULT_TEMPLATES.filter(
      (t) => !existingSlugs.has(t.slug) && isVisible(t.slug),
    );

    if (missing.length > 0) {
      await db.emailTemplate.createMany({
        data: missing.map((t) => ({
          eventId,
          slug: t.slug,
          name: t.name,
          subject: t.subject,
          htmlContent: t.htmlContent,
          textContent: t.textContent,
        })),
        skipDuplicates: true,
      });

      // Re-fetch with the newly added templates
      templates = await db.emailTemplate.findMany({
        where: { eventId },
        orderBy: { createdAt: "asc" },
      });
    }

    return NextResponse.json({
      // Hide webinar templates on non-webinar events even if they were seeded
      // by an earlier build (before this filter existed).
      //
      // Sorted by name (Aug 11, 2026, organizer request). The query orders by
      // createdAt, which is SEED order: an event seeded in one go lists in
      // DEFAULT_TEMPLATES order, while one that picked up templates as they
      // shipped lists them in release order, so no two events read the same.
      //
      // Sorted here rather than in the query so every consumer inherits it —
      // the templates page, the bulk-email dialog's saved-template picker and
      // the Communications "Your templates" tiles all read this endpoint.
      // `localeCompare` rather than a DB sort: it is case-insensitive and
      // locale-aware, where Postgres ordering depends on the column collation.
      templates: templates
        .filter((t) => isVisible(t.slug))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
      variables: allTemplateVariables(),
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching email templates" });
    return NextResponse.json({ error: "Failed to fetch email templates" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "email-templates:create", eventId });
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session, { allow: WEBINAR_STAFF_ALLOW, route: "email-templates:create", eventId });
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Unparseable JSON is a client error, not a server fault: without this it
    // fell to the catch below and reported a 500.
    const raw = await req.json().catch(() => null);
    if (raw === null) {
      apiLogger.warn({ msg: "email-templates:create-invalid-json", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Invalid JSON body", code: "INVALID_JSON" }, { status: 400 });
    }

    const parsed = createTemplateSchema.safeParse(raw);
    if (!parsed.success) {
      return zodErrorResponse(parsed, {
        route: "email-templates:create",
        eventId,
        userId: session.user.id,
      });
    }
    const { slug, name, subject, htmlContent, textContent } = parsed.data;

    // ONE create for this route and the agent's create_email_template
    // (existence check, token normalisation, the P2002 race answered as
    // taken rather than a 500). The 201 body is the row, as before.
    const result = await createCustomEmailTemplate({ eventId, slug, name, subject, htmlContent, textContent });
    if (!result.ok) {
      const status = result.code === "SLUG_TAKEN" ? 409 : 400;
      const error = result.code === "SLUG_TAKEN" ? "Template with this slug already exists" : result.message;
      return NextResponse.json({ error, code: result.code }, { status });
    }

    return NextResponse.json(result.template, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating email template" });
    return NextResponse.json({ error: "Failed to create email template" }, { status: 500 });
  }
}
