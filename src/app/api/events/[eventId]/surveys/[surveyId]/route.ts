/**
 * One survey (Oct 6, 2026; docs/MULTI_SURVEY_PLAN.md §14 step 2).
 *
 *   GET    read (with its answer count)
 *   PUT    update name, questions, intro, thank-you, open/closed (never the
 *          certificate flag)
 *   DELETE refused for the CME survey, and for any survey with answers
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { requirePermission } from "@/lib/permissions/require-permission";
import { surveyConfigSchema } from "@/lib/survey/schema";
import {
  deleteSurvey,
  getSurvey,
  responseWhereForSurvey,
  updateSurvey,
  type SurveyErrorCode,
} from "@/services/survey-service";

interface RouteParams {
  params: Promise<{ eventId: string; surveyId: string }>;
}

// .strict(): the certificate flag is not editable here (or anywhere); a
// request that sends it is refused rather than silently ignored.
const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    config: surveyConfigSchema,
    introHtml: z.string().max(50000).nullable(),
    thankYouHtml: z.string().max(50000).nullable(),
    isActive: z.boolean(),
    // Phase 4; refused for the CME survey (updateSurvey refuses any CME edit)
    // and once anyone answered (SURVEY_MODE_LOCKED).
    responseMode: z.enum(["ONCE", "ONCE_PER_DAY"]),
  })
  .partial()
  .strict();

const STATUS: Record<SurveyErrorCode, number> = {
  SURVEY_NOT_FOUND: 404,
  CERTIFICATE_SURVEY_LOCKED: 409,
  SURVEY_HAS_RESPONSES: 409,
  SURVEY_MODE_LOCKED: 409,
};

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, surveyId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "surveys.read", { route: "events/[eventId]/surveys/[surveyId]:GET", eventId });
    if (!gate.ok) return gate.response;

    const event = await db.event.findFirst({
      where: gate.eventWhere,
      select: { id: true, name: true, slug: true, organizationId: true, surveyConfig: true, surveyIntroHtml: true, surveyThankYouHtml: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "surveys:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    return await runWithTenant(event.organizationId, async () => {
      const survey = await getSurvey(eventId, surveyId, event);
      if (!survey) {
        apiLogger.warn({ msg: "surveys:not-found", eventId, surveyId });
        return NextResponse.json({ error: "Survey not found" }, { status: 404 });
      }
      const responseCount = await db.surveyResponse.count({ where: responseWhereForSurvey(survey) });
      return NextResponse.json({ event: { id: event.id, name: event.name, slug: event.slug }, survey: { ...survey, responseCount } });
    });
  } catch (err) {
    apiLogger.error({ err, msg: "surveys:get-failed" });
    return NextResponse.json({ error: "Failed to load the survey" }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, surveyId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "surveys.manage", { route: "events/[eventId]/surveys/[surveyId]:PUT", eventId });
    if (!gate.ok) return gate.response;

    const body = await req.json().catch(() => null);
    const validated = updateSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ msg: "surveys:update-invalid", eventId, surveyId, errors: validated.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true, organizationId: true } });
    if (!event) {
      apiLogger.warn({ msg: "surveys:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    const result = await runWithTenant(event.organizationId, () =>
      updateSurvey(
        { eventId, organizationId: event.organizationId, userId: session.user.id, source: "rest" },
        surveyId,
        validated.data,
      ),
    );
    if (!result.ok) {
      apiLogger.warn({ msg: "surveys:update-refused", eventId, surveyId, code: result.code });
      return NextResponse.json({ error: result.message, code: result.code }, { status: STATUS[result.code] });
    }
    return NextResponse.json({ id: result.surveyId });
  } catch (err) {
    apiLogger.error({ err, msg: "surveys:update-failed" });
    return NextResponse.json({ error: "Failed to save the survey" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, surveyId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "surveys.manage", { route: "events/[eventId]/surveys/[surveyId]:DELETE", eventId });
    if (!gate.ok) return gate.response;

    const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true, organizationId: true } });
    if (!event) {
      apiLogger.warn({ msg: "surveys:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    const result = await runWithTenant(event.organizationId, () =>
      deleteSurvey({ eventId, organizationId: event.organizationId, userId: session.user.id, source: "rest" }, surveyId),
    );
    if (!result.ok) {
      apiLogger.warn({ msg: "surveys:delete-refused", eventId, surveyId, code: result.code });
      return NextResponse.json({ error: result.message, code: result.code }, { status: STATUS[result.code] });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    apiLogger.error({ err, msg: "surveys:delete-failed" });
    return NextResponse.json({ error: "Failed to delete the survey" }, { status: 500 });
  }
}
