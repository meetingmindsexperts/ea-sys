import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { computeSubmissionAggregates } from "@/lib/abstract-review";
import {
  submitAbstractReview,
  type SubmitAbstractReviewErrorCode,
} from "@/services/abstract-service";

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
        select: { id: true, speaker: { select: { userId: true } } },
      }),
    ]);
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    if (!abstract) return NextResponse.json({ error: "Abstract not found" }, { status: 404 });

    // Access matrix for reading reviewer feedback (tightened July 13 — review H9):
    //   - org STAFF (ADMIN/SUPER_ADMIN/ORGANIZER) → full per-reviewer view
    //   - event-pool reviewers (REVIEWER role, org-independent) → full view
    //   - the abstract's submitter → anonymized view: notes + overall
    //     aggregates only, no per-reviewer identity (the "Reviewer Feedback"
    //     card on /abstracts/[id]/edit is the one place a SUBMITTER sees this)
    //   - other org-attached roles (MEMBER — read-only, documented as
    //     sponsor-side stakeholders — and ONSITE) → the SAME anonymized view.
    //     They used to get the full per-reviewer identities/notes/criteria via
    //     the bare isOrgMember check, which broke blind review sideways.
    //   - everyone else → 403
    const reviewerUserIds = (event.settings as { reviewerUserIds?: string[] } | null)?.reviewerUserIds ?? [];
    const isEventReviewer = reviewerUserIds.includes(session.user.id);
    const isOrgMember = event.organizationId === session.user.organizationId;
    const isOrgStaff =
      isOrgMember &&
      (session.user.role === "ADMIN" || session.user.role === "SUPER_ADMIN" || session.user.role === "ORGANIZER");
    const isAbstractSpeaker = abstract.speaker?.userId === session.user.id;
    if (!isOrgMember && !isEventReviewer && !isAbstractSpeaker) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const aggregate = await computeSubmissionAggregates(abstractId);

    // Anonymized view (submitter + non-staff org roles): strip reviewer
    // identity + per-criterion detail so the reader sees consolidated feedback
    // without learning who-said-what.
    if (!isOrgStaff && !isEventReviewer) {
      return NextResponse.json({
        submissions: aggregate.submissions.map((s) => ({
          id: s.id,
          overallScore: s.overallScore,
          reviewNotes: s.reviewNotes,
          recommendedFormat: s.recommendedFormat,
          submittedAt: s.submittedAt,
          updatedAt: s.updatedAt,
        })),
        aggregates: {
          count: aggregate.aggregates.count,
          meanOverall: aggregate.aggregates.meanOverall,
          medianOverall: aggregate.aggregates.medianOverall,
          minOverall: aggregate.aggregates.minOverall,
          maxOverall: aggregate.aggregates.maxOverall,
          // perCriterion intentionally omitted — could reveal which criteria
          // drove a low score in a way that identifies individual reviewers.
        },
      });
    }

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

/** Map submitAbstractReview error codes to HTTP statuses. */
const HTTP_STATUS_FOR_SUBMIT_CODE: Record<SubmitAbstractReviewErrorCode, number> = {
  EVENT_NOT_FOUND: 404,
  ABSTRACT_NOT_FOUND: 404,
  USER_NOT_FOUND: 404,
  NOT_A_REVIEWER: 403,
  NOT_REVIEWABLE: 409,
  CONFLICT_OF_INTEREST: 403,
  EMPTY_REVIEW: 400,
  INVALID_OVERALL_SCORE: 400,
  INVALID_CRITERION_ID: 400,
  DUPLICATE_CRITERION_ID: 400,
  INVALID_CRITERION_SCORE: 400,
  INVALID_RECOMMENDED_FORMAT: 400,
  INVALID_CONFIDENCE: 400,
  INVALID_REVIEW_NOTES: 400,
  UNKNOWN: 500,
};

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
        apiLogger.warn({ msg: "events/abstracts/submissions:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 },
      );
    }
    const data = validated.data;

    // Domain logic — auth matrix (pool / assignment / H3 org-bound admin),
    // the H6 reviewable-status + COI + empty-payload gates, criteria
    // validation, the upsert, and the audit row — lives in
    // abstract-service.submitAbstractReview (review H7: this route + two MCP
    // executors used to carry three drifting copies). This route keeps
    // session auth, Zod shape validation, and HTTP mapping.
    const result = await submitAbstractReview({
      eventId,
      abstractId,
      reviewerUserId: session.user.id,
      actor: {
        userId: session.user.id,
        role: session.user.role,
        organizationId: session.user.organizationId,
      },
      overallScore: data.overallScore,
      criteriaScores: data.criteriaScores,
      reviewNotes: data.reviewNotes,
      recommendedFormat: data.recommendedFormat,
      confidence: data.confidence,
      source: "rest",
      requestIp: getClientIp(req),
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.message, code: result.code },
        { status: HTTP_STATUS_FOR_SUBMIT_CODE[result.code] },
      );
    }

    return NextResponse.json(
      { success: true, submission: result.submission },
      { status: result.wasCreate ? 201 : 200 },
    );
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
