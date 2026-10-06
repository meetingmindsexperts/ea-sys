/**
 * GET /api/events/[eventId]/survey/responses
 *
 * Admin-only. Returns survey response aggregates + a paginated list
 * of individual responses for the reporting view at
 * /events/[eventId]/survey/responses.
 *
 * Response shape:
 *   {
 *     totalCount,             // total SurveyResponse rows for this event
 *     aggregates,             // per-question (rating / single_select / text)
 *     responses: [            // paginated raw responses
 *       { id, submittedAt, registrant: { firstName, lastName, email },
 *         answers: { [questionId]: value } }
 *     ],
 *     page, pageSize, totalPages,
 *   }
 *
 * Query params:
 *   page     — 1-indexed page number (default 1)
 *   pageSize — 25..200 (default 50)
 *
 * Auth: `surveys.read`, which MEMBER holds: it reads the answers, read-only
 * (owner, Oct 2, 2026; it was refused before despite this comment).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { type SurveyConfig, type SurveyAnswerValue } from "@/lib/survey/schema";
import { parseStoredSurveyConfig, resolveReportSurvey } from "@/services/survey-service";
import { aggregateSurvey } from "@/lib/survey/aggregate";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(25).max(200).default(50),
  // Which survey (Oct 6, 2026). Absent = the certificate survey, as before.
  surveyId: z.string().min(1).max(64).optional(),
});

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session, url] = await Promise.all([
      params,
      auth(),
      Promise.resolve(new URL(req.url)),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const gate = requirePermission(session, "surveys.read", { route: "events/[eventId]/survey/responses:GET", eventId });
    if (!gate.ok) return gate.response;

    const queryParsed = querySchema.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    );
    if (!queryParsed.success) {
      apiLogger.warn({
        msg: "survey-responses:invalid-query",
        eventId,
        errors: queryParsed.error.flatten(),
      });
      return NextResponse.json(
        { error: "Invalid query", details: queryParsed.error.flatten() },
        { status: 400 },
      );
    }
    const { page, pageSize, surveyId } = queryParsed.data;

    // Confirm caller can access this event AND grab the survey config in
    // one go. surveyConfig is needed to render the column header set
    // (question id → label) on the reporting page.
    const event = await db.event.findFirst({
      where: gate.eventWhere,
      select: { id: true, name: true, surveyConfig: true, surveyIntroHtml: true, surveyThankYouHtml: true, organizationId: true },
    });

    if (!event) {
      apiLogger.warn({
        msg: "survey-responses:event-not-found",
        eventId,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const skip = (page - 1) * pageSize;
    // Tenancy (Domain #16): SurveyResponse (+ the nested swept
    // Registration/Attendee selects) and Survey read in the RESOURCE org —
    // this route authorizes via gate.eventWhere, so an org-null SUPER_ADMIN
    // legitimately reaches it and a session-org wrap would fail-close.
    const loaded = await runWithTenant(event.organizationId, async () => {
      const report = await resolveReportSurvey(event, surveyId);
      if (!report) return null;
      const reads = await Promise.all([
        db.surveyResponse.count({ where: report.where }),
        // For aggregates we only need id + submittedAt + answers; avoids
        // dragging registration relations through for the histogram math.
        db.surveyResponse.findMany({
          where: report.where,
          select: { id: true, submittedAt: true, answers: true },
        }),
        db.surveyResponse.findMany({
          where: report.where,
          orderBy: { submittedAt: "desc" },
          skip,
          take: pageSize,
          select: {
            id: true,
            submittedAt: true,
            answers: true,
            registration: {
              select: {
                id: true,
                attendee: {
                  select: {
                    firstName: true,
                    lastName: true,
                    email: true,
                  },
                },
              },
            },
          },
        }),
      ]);
      return { report, reads };
    });
    if (!loaded) {
      apiLogger.warn({ msg: "survey-responses:survey-not-found", eventId, surveyId });
      return NextResponse.json({ error: "Survey not found" }, { status: 404 });
    }
    const [totalCount, allResponsesForAggregate, pageResponses] = loaded.reads;

    // Parse the stored config; an older shape falls back to an empty config
    // so the page still renders the count + identity columns.
    const config: SurveyConfig =
      parseStoredSurveyConfig(loaded.report.rawConfig, { eventId, surveyId: loaded.report.survey?.id }) ?? [];

    // Aggregate input: SurveyResponseLike[]. `answers` comes back as
    // Prisma's JsonValue — cast through unknown to our Record type;
    // the per-question aggregators defensively re-check types so a
    // bad row can't poison the math.
    const aggregates = aggregateSurvey(
      config,
      allResponsesForAggregate.map((r) => ({
        id: r.id,
        submittedAt: r.submittedAt,
        answers: (r.answers ?? {}) as Record<string, SurveyAnswerValue>,
      })),
    );

    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

    return NextResponse.json({
      event: { id: event.id, name: event.name },
      survey: loaded.report.survey,
      config,
      totalCount,
      aggregates,
      page,
      pageSize,
      totalPages,
      responses: pageResponses.map((r) => ({
        id: r.id,
        submittedAt: r.submittedAt,
        // Lets the page reset this person's survey (registrations/[id]/survey).
        registrationId: r.registration?.id ?? null,
        registrant: r.registration?.attendee
          ? {
              firstName: r.registration.attendee.firstName,
              lastName: r.registration.attendee.lastName,
              email: r.registration.attendee.email,
            }
          : null,
        answers: r.answers as Record<string, SurveyAnswerValue>,
      })),
    });
  } catch (err) {
    apiLogger.error({ err, msg: "survey-responses:unhandled" });
    return NextResponse.json(
      { error: "Failed to load survey responses" },
      { status: 500 },
    );
  }
}
