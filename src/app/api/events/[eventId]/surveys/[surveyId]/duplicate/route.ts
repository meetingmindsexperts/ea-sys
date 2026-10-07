/**
 * Duplicate a survey (Oct 7, 2026).
 *
 *   POST /api/events/[eventId]/surveys/[surveyId]/duplicate
 *
 * The copy is always a new extra survey, closed, with no answers, even when
 * the source is the CME survey (content built in the reserved slot by
 * mistake). The rules live in duplicateSurvey (src/services/survey-service.ts).
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { requirePermission } from "@/lib/permissions/require-permission";
import { duplicateSurvey, type SurveyErrorCode } from "@/services/survey-service";

interface RouteParams {
  params: Promise<{ eventId: string; surveyId: string }>;
}

const STATUS: Record<SurveyErrorCode, number> = {
  SURVEY_NOT_FOUND: 404,
  CERTIFICATE_SURVEY_LOCKED: 409,
  SURVEY_HAS_RESPONSES: 409,
  SURVEY_MODE_LOCKED: 409,
  SURVEY_EMPTY: 409,
};

export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, surveyId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "surveys.manage", {
      route: "events/[eventId]/surveys/[surveyId]/duplicate:POST",
      eventId,
    });
    if (!gate.ok) return gate.response;

    const event = await db.event.findFirst({
      where: gate.eventWhere,
      select: { id: true, organizationId: true, surveyConfig: true, surveyIntroHtml: true, surveyThankYouHtml: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "surveys:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const result = await runWithTenant(event.organizationId, () =>
      duplicateSurvey(
        { eventId, organizationId: event.organizationId, userId: session.user.id, source: "rest" },
        surveyId,
        event,
      ),
    );
    if (!result.ok) {
      apiLogger.warn({ msg: "surveys:duplicate-refused", eventId, surveyId, code: result.code });
      return NextResponse.json({ error: result.message, code: result.code }, { status: STATUS[result.code] });
    }
    apiLogger.info({ msg: "surveys:duplicated", eventId, sourceId: surveyId, surveyId: result.surveyId, userId: session.user.id });
    return NextResponse.json({ id: result.surveyId }, { status: 201 });
  } catch (err) {
    apiLogger.error({ err, msg: "surveys:duplicate-failed" });
    return NextResponse.json({ error: "Failed to duplicate the survey" }, { status: 500 });
  }
}
