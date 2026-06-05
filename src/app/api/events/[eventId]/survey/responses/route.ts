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
 * Auth: same shape as other event-scoped admin routes
 * (auth() → denyReviewer → buildEventAccessWhere). No finance
 * implications, but MEMBER is allowed to view (read-only by design).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { denyReviewer } from "@/lib/auth-guards";
import {
  surveyConfigSchema,
  type SurveyConfig,
  type SurveyAnswerValue,
} from "@/lib/survey/schema";
import { aggregateSurvey } from "@/lib/survey/aggregate";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(25).max(200).default(50),
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
    const denied = denyReviewer(session);
    if (denied) return denied;

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
    const { page, pageSize } = queryParsed.data;

    // Confirm caller can access this event AND grab the survey config in
    // one go. surveyConfig is needed to render the column header set
    // (question id → label) on the reporting page.
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, name: true, surveyConfig: true },
    });

    if (!event) {
      apiLogger.warn({
        msg: "survey-responses:event-not-found",
        eventId,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Parse the stored config now; if it doesn't match the current
    // schema (older format), fall back to an empty config so the page
    // still renders the raw response count + identity columns —
    // operator gets SOME visibility instead of a 500.
    let config: SurveyConfig = [];
    if (event.surveyConfig) {
      const parsed = surveyConfigSchema.safeParse(event.surveyConfig);
      if (parsed.success) {
        config = parsed.data;
      } else {
        apiLogger.warn({
          msg: "survey-responses:stored-config-invalid",
          eventId,
          errors: parsed.error.flatten(),
        });
      }
    }

    // Parallelize the three reads we need: count + aggregate over ALL
    // responses (no pagination for the aggregates — they're cheap
    // jsonb scans and the operator needs the full picture) + the
    // page slice for the table view.
    const skip = (page - 1) * pageSize;
    const [totalCount, allResponsesForAggregate, pageResponses] = await Promise.all([
      db.surveyResponse.count({ where: { eventId } }),
      // For aggregates we only need id + submittedAt + answers; avoids
      // dragging registration relations through for the histogram math.
      db.surveyResponse.findMany({
        where: { eventId },
        select: { id: true, submittedAt: true, answers: true },
      }),
      db.surveyResponse.findMany({
        where: { eventId },
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
      config,
      totalCount,
      aggregates,
      page,
      pageSize,
      totalPages,
      responses: pageResponses.map((r) => ({
        id: r.id,
        submittedAt: r.submittedAt,
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
