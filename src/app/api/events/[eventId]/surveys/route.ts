/**
 * An event's surveys (Oct 6, 2026; docs/MULTI_SURVEY_PLAN.md §14 step 2).
 *
 *   GET  /api/events/[eventId]/surveys   list, with each survey's answer count
 *   POST /api/events/[eventId]/surveys   create an extra (never certificate) survey
 *
 * The CME survey is reserved and locked (./certificate); the rules live in
 * src/services/survey-service.ts; this route authorises, validates
 * and maps results to HTTP.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { requirePermission } from "@/lib/permissions/require-permission";
import { surveyConfigSchema } from "@/lib/survey/schema";
import { createSurvey, listSurveys } from "@/services/survey-service";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

// .strict(): a request carrying a certificate flag (or anything else) is
// refused, not silently ignored. Extra surveys are never certificate surveys;
// the CME survey has its own reserved route (./certificate).
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    config: surveyConfigSchema,
    introHtml: z.string().max(50000).nullable().optional(),
    thankYouHtml: z.string().max(50000).nullable().optional(),
    isActive: z.boolean().optional(),
    // Phase 4: how often one person may answer (never the CME survey, which
    // this route cannot create).
    responseMode: z.enum(["ONCE", "ONCE_PER_DAY"]).optional(),
  })
  .strict();

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "surveys.read", { route: "events/[eventId]/surveys:GET", eventId });
    if (!gate.ok) return gate.response;

    const event = await db.event.findFirst({
      where: gate.eventWhere,
      select: { id: true, name: true, slug: true, organizationId: true, surveyConfig: true, surveyIntroHtml: true, surveyThankYouHtml: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "surveys:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    const surveys = await runWithTenant(event.organizationId, () => listSurveys(eventId, event));
    return NextResponse.json({ event: { id: event.id, name: event.name, slug: event.slug }, surveys });
  } catch (err) {
    apiLogger.error({ err, msg: "surveys:list-failed" });
    return NextResponse.json({ error: "Failed to load surveys" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "surveys.manage", { route: "events/[eventId]/surveys:POST", eventId });
    if (!gate.ok) return gate.response;

    const body = await req.json().catch(() => null);
    const validated = createSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ msg: "surveys:create-invalid", eventId, errors: validated.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true, organizationId: true } });
    if (!event) {
      apiLogger.warn({ msg: "surveys:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const d = validated.data;
    const result = await runWithTenant(event.organizationId, () =>
      createSurvey(
        { eventId, organizationId: event.organizationId, userId: session.user.id, source: "rest" },
        {
          name: d.name,
          config: d.config,
          introHtml: d.introHtml ?? null,
          thankYouHtml: d.thankYouHtml ?? null,
          isActive: d.isActive ?? true,
          responseMode: d.responseMode ?? "ONCE",
        },
      ),
    );
    return NextResponse.json({ id: result.ok ? result.surveyId : null }, { status: 201 });
  } catch (err) {
    apiLogger.error({ err, msg: "surveys:create-failed" });
    return NextResponse.json({ error: "Failed to create the survey" }, { status: 500 });
  }
}
