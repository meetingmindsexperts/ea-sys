/**
 * The reserved certificate (CME) survey (owner, Oct 6, 2026: "cme survey should
 * be unaffected by all means, even if you have to keep it reserved or lock it").
 *
 *   PUT /api/events/[eventId]/surveys/certificate
 *     Creates the event's certificate survey when it has none, otherwise edits
 *     it (questions, intro, thank-you, open/closed). The only route that writes
 *     the certificate survey; it can never be deleted or lose its flag.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { requirePermission } from "@/lib/permissions/require-permission";
import { surveyConfigSchema } from "@/lib/survey/schema";
import { saveCertificateSurvey } from "@/services/survey-service";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const schema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    config: surveyConfigSchema,
    introHtml: z.string().max(50000).nullable(),
    thankYouHtml: z.string().max(50000).nullable(),
    isActive: z.boolean().optional(),
  })
  .strict();

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "surveys.manage", { route: "events/[eventId]/surveys/certificate:PUT", eventId });
    if (!gate.ok) return gate.response;

    const body = await req.json().catch(() => null);
    const validated = schema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ msg: "surveys:certificate-invalid", eventId, errors: validated.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }
    const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true, organizationId: true } });
    if (!event) {
      apiLogger.warn({ msg: "surveys:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    const d = validated.data;
    const result = await runWithTenant(event.organizationId, () =>
      saveCertificateSurvey(
        { eventId, organizationId: event.organizationId, userId: session.user.id, source: "rest" },
        { name: d.name, config: d.config, introHtml: d.introHtml, thankYouHtml: d.thankYouHtml, isActive: d.isActive ?? true },
      ),
    );
    return NextResponse.json({ id: result.ok ? result.surveyId : null });
  } catch (err) {
    apiLogger.error({ err, msg: "surveys:certificate-save-failed" });
    return NextResponse.json({ error: "Failed to save the certificate survey" }, { status: 500 });
  }
}
