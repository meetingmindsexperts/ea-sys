import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
import { denyReviewer, WEBINAR_STAFF_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { duplicateEmailTemplate } from "@/lib/email-template-create";

interface RouteParams {
  params: Promise<{ eventId: string; templateId: string }>;
}

/**
 * Duplicate an email template (September 25, 2026): the dashboard's Duplicate
 * button. The copy is a custom template with its own slug, starts DISABLED
 * (not offered in the send dialog until someone switches it on) and keeps the
 * source's subject and bodies. The copy itself is `duplicateEmailTemplate`,
 * shared with the agent's duplicate_email_template tool.
 *
 * Its own route file because the `[templateId]` route already uses POST for
 * the test send. The body is optional: `{ name }` names the copy, otherwise it
 * is "<source name> (copy)".
 */
const duplicateSchema = z.object({ name: z.string().trim().min(1).max(200).optional() });

const ROUTE = "events/[eventId]/email-templates/[templateId]/duplicate:POST";

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, templateId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: ROUTE, eventId });
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session, { allow: WEBINAR_STAFF_ALLOW, route: ROUTE, eventId });
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "email-template-duplicate:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // An empty body is the common case (the button sends none).
    const text = await req.text();
    let raw: unknown = {};
    if (text.trim()) {
      try {
        raw = JSON.parse(text);
      } catch {
        apiLogger.warn({ msg: "email-template-duplicate:invalid-json", eventId, templateId, userId: session.user.id });
        return NextResponse.json({ error: "Invalid JSON body", code: "INVALID_JSON" }, { status: 400 });
      }
    }
    const parsed = duplicateSchema.safeParse(raw);
    if (!parsed.success) {
      return zodErrorResponse(parsed, { route: ROUTE, eventId, templateId, userId: session.user.id });
    }

    const result = await duplicateEmailTemplate({ eventId, sourceId: templateId, name: parsed.data.name });
    if (!result.ok) {
      const status = result.code === "SOURCE_NOT_FOUND" ? 404 : result.code === "NO_FREE_SLUG" ? 409 : 400;
      apiLogger.warn({ msg: "email-template-duplicate:refused", code: result.code, eventId, templateId, userId: session.user.id });
      return NextResponse.json({ error: result.message, code: result.code }, { status });
    }

    const { template, source, unknownTokens } = result;
    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "CREATE",
          entityType: "EmailTemplate",
          entityId: template.id,
          changes: { source: "rest", slug: template.slug, name: template.name, duplicatedFrom: { id: source.id, slug: source.slug } },
        },
      })
      .catch((err) => apiLogger.error({ err, msg: "email-template-duplicate:audit-log-failed", eventId, templateId: template.id }));

    return NextResponse.json({ ...template, unfillableTokens: unknownTokens }, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "email-template-duplicate:failed" });
    return NextResponse.json({ error: "Failed to duplicate email template" }, { status: 500 });
  }
}
