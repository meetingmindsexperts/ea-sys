import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import {
  computeSubmissionAggregates,
  computeWeightedOverallScore,
  type CriterionScore,
} from "@/lib/abstract-review";

/**
 * Per-reviewer abstract review submissions.
 *
 * GET — list all submissions for an abstract + computed aggregates. Anyone
 * with event access can read (reviewers see their own + others' for context,
 * organizers see all to make the final call).
 *
 * POST — upsert the CURRENT USER's submission. Auth requires the user to
 * be either in `event.settings.reviewerUserIds` OR have an explicit
 * `AbstractReviewer` row. Upserts on `(abstractId, reviewerUserId)` so
 * reviewers can edit their own scores without creating duplicates.
 */

interface RouteParams {
  params: Promise<{ eventId: string; abstractId: string }>;
}

const criterionScoreSchema = z.object({
  criterionId: z.string(),
  score: z.number().int().min(0).max(10),
});

const submissionSchema = z.object({
  criteriaScores: z.array(criterionScoreSchema).max(50).optional(),
  overallScore: z.number().int().min(0).max(100).optional(),
  reviewNotes: z.string().max(5000).optional(),
  recommendedFormat: z.enum(["ORAL", "POSTER", "NEITHER"]).optional(),
  confidence: z.number().int().min(1).max(5).optional(),
});

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, abstractId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [event, abstract] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId },
        select: { id: true, organizationId: true, settings: true },
      }),
      db.abstract.findFirst({
        where: { id: abstractId, eventId },
        select: { id: true },
      }),
    ]);
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    if (!abstract) return NextResponse.json({ error: "Abstract not found" }, { status: 404 });

    // REVIEWER role users aren't org-bound, so use reviewerUserIds check;
    // everyone else must be in the same org
    const reviewerUserIds = (event.settings as { reviewerUserIds?: string[] } | null)?.reviewerUserIds ?? [];
    const isEventReviewer = reviewerUserIds.includes(session.user.id);
    const isOrgMember = event.organizationId === session.user.organizationId;
    if (!isOrgMember && !isEventReviewer) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const aggregate = await computeSubmissionAggregates(abstractId);

    return NextResponse.json({
      submissions: aggregate.submissions,
      aggregates: aggregate.aggregates,
    });
  } catch (err) {
    apiLogger.error({ err, msg: "list-submissions:failed" });
    return NextResponse.json(
      { error: "Failed to list submissions", code: "LIST_SUBMISSIONS_FAILED" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, abstractId }, session, body] = await Promise.all([
      params,
      auth(),
      req.json().catch(() => null),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // REGISTRANT / SUBMITTER roles can't review. Everyone else can (if they're
    // in the reviewer pool OR assigned to this abstract).
    if (session.user.role === "REGISTRANT" || session.user.role === "SUBMITTER") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!body) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const validated = submissionSchema.safeParse(body);
    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 },
      );
    }

    const [event, abstract, existingAssignment] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId },
        select: {
          id: true,
          organizationId: true,
          settings: true,
          reviewCriteria: { select: { id: true, weight: true } },
        },
      }),
      db.abstract.findFirst({
        where: { id: abstractId, eventId },
        select: { id: true },
      }),
      db.abstractReviewer.findUnique({
        where: { abstractId_userId: { abstractId, userId: session.user.id } },
        select: { id: true },
      }),
    ]);
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    if (!abstract) return NextResponse.json({ error: "Abstract not found" }, { status: 404 });

    // Reviewer auth: must be in event pool OR have explicit assignment
    const reviewerUserIds = (event.settings as { reviewerUserIds?: string[] } | null)?.reviewerUserIds ?? [];
    const isEventReviewer = reviewerUserIds.includes(session.user.id);
    const isAdmin = session.user.role === "ADMIN" || session.user.role === "SUPER_ADMIN" || session.user.role === "ORGANIZER";
    if (!isEventReviewer && !existingAssignment && !isAdmin) {
      return NextResponse.json(
        {
          error: "You are not a reviewer for this event",
          code: "NOT_A_REVIEWER",
        },
        { status: 403 },
      );
    }

    const data = validated.data;

    // Validate criteria IDs against the event's configured criteria
    const validCriteriaIds = new Set(event.reviewCriteria.map((c) => c.id));
    const weightMap = new Map(event.reviewCriteria.map((c) => [c.id, c.weight]));
    let criteriaScoresJson: Record<string, number> | null = null;
    let computedOverall: number | null = null;
    if (data.criteriaScores && data.criteriaScores.length > 0) {
      const cleaned: Record<string, number> = {};
      for (const { criterionId, score } of data.criteriaScores) {
        if (!validCriteriaIds.has(criterionId)) {
          return NextResponse.json(
            { error: `Unknown criterion ID: ${criterionId}`, code: "INVALID_CRITERION_ID" },
            { status: 400 },
          );
        }
        cleaned[criterionId] = score;
      }
      criteriaScoresJson = cleaned;
      if (data.overallScore === undefined) {
        const items: CriterionScore[] = Object.entries(cleaned).map(([id, score]) => ({
          criterionId: id,
          score,
          weight: weightMap.get(id) ?? 0,
        }));
        computedOverall = computeWeightedOverallScore(items);
      }
    }
    const overallScore = data.overallScore ?? computedOverall;

    const submission = await db.abstractReviewSubmission.upsert({
      where: { abstractId_reviewerUserId: { abstractId, reviewerUserId: session.user.id } },
      create: {
        abstractId,
        reviewerUserId: session.user.id,
        abstractReviewerId: existingAssignment?.id ?? null,
        criteriaScores: criteriaScoresJson ?? undefined,
        overallScore,
        reviewNotes: data.reviewNotes ?? null,
        recommendedFormat: data.recommendedFormat ?? null,
        confidence: data.confidence ?? null,
      },
      update: {
        ...(criteriaScoresJson && { criteriaScores: criteriaScoresJson }),
        ...(overallScore !== null && overallScore !== undefined && { overallScore }),
        ...(data.reviewNotes !== undefined && { reviewNotes: data.reviewNotes || null }),
        ...(data.recommendedFormat !== undefined && { recommendedFormat: data.recommendedFormat }),
        ...(data.confidence !== undefined && { confidence: data.confidence }),
      },
      select: {
        id: true,
        overallScore: true,
        reviewNotes: true,
        recommendedFormat: true,
        confidence: true,
        submittedAt: true,
        updatedAt: true,
        criteriaScores: true,
      },
    });

    const wasCreate = submission.submittedAt.getTime() === submission.updatedAt.getTime();
    apiLogger.info(
      { eventId, abstractId, reviewerUserId: session.user.id, overallScore },
      wasCreate ? "abstract-submission:created" : "abstract-submission:updated",
    );

    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: wasCreate ? "CREATE" : "UPDATE",
        entityType: "AbstractReviewSubmission",
        entityId: submission.id,
        changes: {
          source: "api",
          abstractId,
          overallScore,
          hasCriteriaScores: !!criteriaScoresJson,
          ip: getClientIp(req),
        },
      },
    }).catch((err) => apiLogger.error({ err, eventId, abstractId }, "submit-review:audit-log-failed"));

    return NextResponse.json({ success: true, submission }, { status: wasCreate ? 201 : 200 });
  } catch (err) {
    apiLogger.error({ err, msg: "submit-review:failed" });
    return NextResponse.json(
      {
        error: "Failed to submit review",
        code: "SUBMIT_REVIEW_FAILED",
        details: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
