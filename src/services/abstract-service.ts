/**
 * Abstract service — domain logic for review-status transitions on abstract
 * submissions. Shared by the REST dashboard route (for organizer + reviewer
 * actions) and the MCP agent tool (for admin-driven bulk actions via Claude).
 *
 * Scope of this service is **status changes only** (UNDER_REVIEW, ACCEPTED,
 * REJECTED, REVISION_REQUESTED, WITHDRAWN). Field updates on an abstract
 * (title, content, trackId, themeId, specialty, presentationType) stay in
 * the REST handler — they're not called from MCP, have no drift risk, and
 * are tightly coupled to submitter role flow.
 *
 * Two helpers are already extracted and reused:
 *   - src/lib/abstract-review.ts: aggregate computation (reviewer counts,
 *     weighted overall scores, required-review-count gate).
 *   - src/lib/abstract-notifications.ts: speaker status-change email +
 *     admin notification.
 *
 * This service wraps them inside one call so the full flow (gate check →
 * update → audit → notify → stats refresh) runs identically from every
 * entry point.
 *
 * See src/services/README.md for conventions (result-type shape, typed
 * inputs, caller identity via `source`).
 */

import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { refreshEventStats } from "@/lib/event-stats";
import {
  computeSubmissionAggregates,
  computeWeightedOverallScore,
  consolidateReviewNotes,
  readRequiredReviewCount,
} from "@/lib/abstract-review";
import { notifyAbstractStatusChange } from "@/lib/abstract-notifications";
import { notifyReviewerAssigned } from "@/lib/abstract-reviewer-notify";

// ── Input / Result types ─────────────────────────────────────────────────────

// Status values the service accepts as a transition target. Matches the
// existing ABSTRACT_UPDATE_STATUSES set used by the MCP tool and the REST
// Zod schema. DRAFT / SUBMITTED are intentionally excluded — those go
// through the REST field-update path, not through this service.
export const ABSTRACT_TRANSITION_STATUSES = [
  "UNDER_REVIEW",
  "ACCEPTED",
  "REJECTED",
  "REVISION_REQUESTED",
  "WITHDRAWN",
] as const;
export type AbstractTransitionStatus = (typeof ABSTRACT_TRANSITION_STATUSES)[number];

export interface ChangeAbstractStatusInput {
  eventId: string;
  organizationId: string;
  userId: string;
  abstractId: string;
  newStatus: AbstractTransitionStatus;
  /**
   * Organizer/chair override: bypass the `requiredReviewCount` gate on
   * ACCEPTED / REJECTED transitions. Caller is responsible for verifying
   * the user has admin authority before setting this to true; the service
   * only records it in the audit trail.
   */
  forceStatus?: boolean;
  source: "rest" | "mcp" | "api";
  requestIp?: string;
}

export type ChangeAbstractStatusErrorCode =
  | "ABSTRACT_NOT_FOUND"
  | "ABSTRACT_WITHDRAWN"
  | "INSUFFICIENT_REVIEWS"
  | "INVALID_STATUS"
  | "STATUS_CHANGED"
  | "UNKNOWN";

export type ChangeAbstractStatusResult =
  | {
      ok: true;
      abstract: { id: string; title: string; status: string };
      previousStatus: string;
      reviewCount: number;
      meanOverallScore: number | null;
      forcedOverride: boolean;
      /**
       * "sent" — email + admin notification fired without error.
       * "skipped" — notification intentionally not fired (e.g., terminal
       *   transition to WITHDRAWN, no status delta vs previousStatus).
       * "failed" — send errored out; `notificationError` has the detail.
       *   The DB update still succeeded — callers should still treat
       *   ok: true as the state-change having landed.
       */
      notificationStatus: "sent" | "failed" | "skipped";
      notificationError?: string;
    }
  | {
      ok: false;
      code: ChangeAbstractStatusErrorCode;
      message: string;
      meta?: Record<string, unknown>;
    };

// ── Service ──────────────────────────────────────────────────────────────────

export async function changeAbstractStatus(
  input: ChangeAbstractStatusInput,
): Promise<ChangeAbstractStatusResult> {
  const { eventId, organizationId, userId, abstractId, newStatus, source, requestIp } = input;
  const forceStatus = input.forceStatus === true;

  if (!ABSTRACT_TRANSITION_STATUSES.includes(newStatus)) {
    return {
      ok: false,
      code: "INVALID_STATUS",
      message: `Invalid status. Must be one of: ${ABSTRACT_TRANSITION_STATUSES.join(", ")}`,
    };
  }

  // Load abstract + event in one query via relation — also scopes to org so
  // cross-org access returns ABSTRACT_NOT_FOUND (no existence leak).
  const abstract = await db.abstract.findFirst({
    where: { id: abstractId, eventId, event: { organizationId } },
    select: {
      id: true,
      title: true,
      status: true,
      event: { select: { id: true, organizationId: true, name: true, slug: true, settings: true } },
      speaker: { select: { id: true, email: true, additionalEmail: true, firstName: true, lastName: true, title: true } },
    },
  });
  if (!abstract) {
    return {
      ok: false,
      code: "ABSTRACT_NOT_FOUND",
      message: `Abstract ${abstractId} not found`,
    };
  }

  // Terminal-state guard — WITHDRAWN is final. MCP previously enforced this;
  // REST PUT did not (relied on Zod allowing the transition). Centralizing
  // here closes that gap on the REST path too.
  if (abstract.status === "WITHDRAWN" && newStatus !== "WITHDRAWN") {
    return {
      ok: false,
      code: "ABSTRACT_WITHDRAWN",
      message: "Cannot transition out of WITHDRAWN — terminal state",
      meta: { currentStatus: abstract.status },
    };
  }

  const previousStatus = abstract.status;
  const gateRelevant = newStatus === "ACCEPTED" || newStatus === "REJECTED";
  const requiredCount = readRequiredReviewCount(abstract.event.settings);
  const isReview =
    newStatus === "UNDER_REVIEW" ||
    newStatus === "ACCEPTED" ||
    newStatus === "REJECTED" ||
    newStatus === "REVISION_REQUESTED";

  // ── Atomic gate + write (review H4/H5/M4) ───────────────────────────────
  // The gate read, and the status write, run in ONE transaction with a
  // CONDITIONAL claim (`status: previousStatus`). This closes three races:
  //   - H4: two concurrent decisions (ACCEPT vs WITHDRAW, or ACCEPT vs REJECT)
  //     can no longer both commit — the loser's claim matches 0 rows because
  //     the winner already moved status off `previousStatus`. Contradictory
  //     speaker emails / resurrected terminal states are eliminated.
  //   - M4: the review-count read is tx-consistent (a submission cascade-
  //     deleted mid-decision can't let an under-gated ACCEPT slip through).
  //   - H5 (gate half): the gate counts SCORED submissions, not rows, so an
  //     all-null "review" never satisfies requiredReviewCount.
  type TxOutcome =
    | { kind: "ok"; scoredCount: number | null; aggregates: Awaited<ReturnType<typeof computeSubmissionAggregates>> | null }
    | { kind: "insufficient"; currentCount: number; required: number }
    | { kind: "lost-race" };

  let outcome: TxOutcome;
  try {
    outcome = await db.$transaction(async (tx): Promise<TxOutcome> => {
      let aggregates: Awaited<ReturnType<typeof computeSubmissionAggregates>> | null = null;
      let scoredCount: number | null = null;
      if (gateRelevant) {
        aggregates = await computeSubmissionAggregates(abstractId, tx);
        scoredCount = aggregates.aggregates.scoredCount;
        if (!forceStatus && scoredCount < requiredCount) {
          return { kind: "insufficient", currentCount: scoredCount, required: requiredCount };
        }
      }
      const claim = await tx.abstract.updateMany({
        where: { id: abstractId, status: previousStatus },
        data: { status: newStatus, ...(isReview && { reviewedAt: new Date() }) },
      });
      if (claim.count === 0) return { kind: "lost-race" };
      return { kind: "ok", scoredCount, aggregates };
    });
  } catch (err) {
    apiLogger.error({ err, abstractId }, "abstract-service:update-failed");
    return {
      ok: false,
      code: "UNKNOWN",
      message: err instanceof Error ? err.message : "Failed to update abstract status",
    };
  }

  if (outcome.kind === "insufficient") {
    apiLogger.warn(
      { abstractId, currentCount: outcome.currentCount, required: outcome.required, userId },
      "abstract-status:insufficient-reviews",
    );
    return {
      ok: false,
      code: "INSUFFICIENT_REVIEWS",
      message: `This event requires ${outcome.required} scored review(s) before ${newStatus}. Current: ${outcome.currentCount}.`,
      meta: { currentCount: outcome.currentCount, required: outcome.required },
    };
  }
  if (outcome.kind === "lost-race") {
    // Someone else changed the status between our load and our claim.
    apiLogger.warn({ abstractId, previousStatus, newStatus, userId }, "abstract-status:lost-race");
    return {
      ok: false,
      code: "STATUS_CHANGED",
      message: "This abstract's status was changed by someone else. Reload and try again.",
    };
  }

  const aggregateResult = outcome.aggregates;
  const updated = { id: abstract.id, title: abstract.title, status: newStatus };

  apiLogger.info(
    { abstractId, previousStatus, newStatus, forceStatus, reviewCount: aggregateResult?.aggregates.count ?? null },
    "abstract-status:changed",
  );

  // Fire-and-forget audit log. `changes.source` reflects caller:
  //   - "chair-override" when forceStatus=true (takes precedence; matches
  //     pre-existing audit convention)
  //   - "rest" | "mcp" | "api" otherwise, from the caller
  db.auditLog
    .create({
      data: {
        eventId,
        userId,
        action: isReview ? "REVIEW" : "UPDATE",
        entityType: "Abstract",
        entityId: abstract.id,
        changes: {
          before: { status: previousStatus },
          after: { status: newStatus },
          source: forceStatus ? "chair-override" : source,
          reviewCount: aggregateResult?.aggregates.count ?? null,
          meanOverall: aggregateResult?.aggregates.meanOverall ?? null,
          ...(requestIp ? { ip: requestIp } : {}),
        },
      },
    })
    .catch((err) => apiLogger.error({ err, abstractId }, "abstract-service:audit-log-failed"));

  // Refresh denormalized event stats (fire-and-forget).
  refreshEventStats(eventId);

  // Notification gating:
  //   - Only fires on transition into a review status (UNDER_REVIEW / ACCEPTED
  //     / REJECTED / REVISION_REQUESTED) AND newStatus !== previousStatus.
  //   - WITHDRAWN transitions do not email the speaker (they initiated it).
  //   - No-op transitions (e.g. ACCEPTED → ACCEPTED) are also skipped.
  // Notification failures don't mask DB success — we surface
  // notificationStatus so callers can follow up if the email dropped.
  const shouldNotify = isReview && newStatus !== previousStatus;
  let notificationStatus: "sent" | "failed" | "skipped" = "skipped";
  let notificationError: string | undefined;
  if (shouldNotify) {
    try {
      const notifyAggregate = aggregateResult ?? (await computeSubmissionAggregates(abstractId));
      await notifyAbstractStatusChange({
        eventId,
        organizationId: abstract.event.organizationId,
        eventName: abstract.event.name,
        eventSlug: abstract.event.slug,
        abstractId: abstract.id,
        abstractTitle: abstract.title,
        previousStatus,
        newStatus,
        reviewNotes: consolidateReviewNotes(notifyAggregate.submissions),
        reviewScore: notifyAggregate.aggregates.meanOverall,
        speaker: {
          id: abstract.speaker?.id,
          email: abstract.speaker?.email ?? null,
          additionalEmail: abstract.speaker?.additionalEmail ?? null,
          firstName: abstract.speaker?.firstName ?? "",
          lastName: abstract.speaker?.lastName ?? "",
          title: abstract.speaker?.title ?? null,
        },
      });
      notificationStatus = "sent";
    } catch (err) {
      apiLogger.error({ err, abstractId }, "abstract-status:notification-failed");
      notificationStatus = "failed";
      notificationError = err instanceof Error ? err.message : "Unknown notification error";
    }
  }

  const finalAggregate = aggregateResult ?? (shouldNotify ? await computeSubmissionAggregates(abstractId) : null);

  return {
    ok: true,
    abstract: updated,
    previousStatus,
    reviewCount: finalAggregate?.aggregates.count ?? 0,
    meanOverallScore: finalAggregate?.aggregates.meanOverall ?? null,
    forcedOverride: forceStatus,
    notificationStatus,
    ...(notificationError && { notificationError }),
  };
}

// ── submitAbstractReview ─────────────────────────────────────────────────────
//
// Review H7 (July 13, 2026): the review-submission pipeline was implemented
// THREE times (~120 lines each) — the REST submissions POST, MCP
// `submit_abstract_review`, and MCP `admin_submit_review_on_behalf` — with
// live drift between them: REST let org admins score without pool/assignment
// (MCP didn't), REST cleared notes with an empty string (MCP kept the old
// ones), REST required integer scores (the executors accepted floats), and
// the MCP paths never rejected an empty payload. This is the ONE
// implementation all three delegate to (see src/services/README.md "THE RULE");
// it also owns the H3 org-bind (the admin bypass is computed HERE against the
// event's organizationId, not per-caller).
//
// Unification decisions (REST semantics win):
//  - scores are INTEGERS (overall 0-100, per-criterion 0-10, confidence 1-5);
//  - `reviewNotes: undefined` keeps the existing notes, `""` clears them;
//  - a completely empty payload is rejected (EMPTY_REVIEW) on every path;
//  - notes over 5000 chars are rejected (was: MCP silently truncated).

export type ReviewRecommendedFormat = "ORAL" | "POSTER" | "NEITHER";
const RECOMMENDED_FORMAT_VALUES = new Set<string>(["ORAL", "POSTER", "NEITHER"]);

/** Abstract statuses open for review — shared with the assign paths (H6). */
export const REVIEWABLE_ABSTRACT_STATUSES = new Set<string>([
  "SUBMITTED",
  "UNDER_REVIEW",
  "REVISION_REQUESTED",
]);

export interface SubmitAbstractReviewInput {
  eventId: string;
  abstractId: string;
  /** Whose submission row this is (the reviewer being scored as). */
  reviewerUserId: string;
  /**
   * Who is performing the write. Equal to `reviewerUserId` for a self-submit;
   * different for the admin on-behalf path (audited as such).
   */
  actor: {
    userId: string;
    /** Session role when the caller has one (REST). MCP callers omit it —
     *  the admin bypass is then simply unavailable, as before. */
    role?: string | null;
    organizationId?: string | null;
  };
  overallScore?: number;
  criteriaScores?: Array<{ criterionId: string; score: number }>;
  /** `undefined` = keep existing notes; `""` = clear them. */
  reviewNotes?: string;
  recommendedFormat?: string;
  confidence?: number;
  source: "rest" | "mcp";
  requestIp?: string | null;
}

export type SubmitAbstractReviewErrorCode =
  | "EVENT_NOT_FOUND"
  | "ABSTRACT_NOT_FOUND"
  | "USER_NOT_FOUND"
  | "NOT_A_REVIEWER"
  | "NOT_REVIEWABLE"
  | "CONFLICT_OF_INTEREST"
  | "EMPTY_REVIEW"
  | "INVALID_OVERALL_SCORE"
  | "INVALID_CRITERION_ID"
  | "DUPLICATE_CRITERION_ID"
  | "INVALID_CRITERION_SCORE"
  | "INVALID_RECOMMENDED_FORMAT"
  | "INVALID_CONFIDENCE"
  | "INVALID_REVIEW_NOTES"
  | "UNKNOWN";

export interface SubmittedReviewSummary {
  id: string;
  overallScore: number | null;
  reviewNotes: string | null;
  recommendedFormat: string | null;
  confidence: number | null;
  submittedAt: Date;
  updatedAt: Date;
  criteriaScores: unknown;
}

export type SubmitAbstractReviewResult =
  | {
      ok: true;
      submission: SubmittedReviewSummary;
      wasCreate: boolean;
      onBehalf: boolean;
      /** Present on the on-behalf path — the target reviewer's identity. */
      reviewer?: { id: string; firstName: string | null; lastName: string | null; email: string };
    }
  | { ok: false; code: SubmitAbstractReviewErrorCode; message: string };

const ORG_ADMIN_ROLES = new Set(["ADMIN", "SUPER_ADMIN", "ORGANIZER"]);

/**
 * Create or update one reviewer's submission for an abstract.
 *
 * Authorization (domain rule, owned here):
 *  - the target reviewer must be in the event's reviewer pool OR hold an
 *    explicit `AbstractReviewer` assignment;
 *  - EXCEPT a self-submitting org admin/organizer (role AND org bound to the
 *    event's org — the H3 bind) may score without either;
 *  - the on-behalf path (actor ≠ reviewer) never gets the admin bypass — the
 *    TARGET must be pool/assigned, exactly as before.
 *
 * Gates: reviewable status (H6), COI (a flagged reviewer's score must never
 * count — enforced for self AND on-behalf), non-empty payload (H5 route-half).
 * Side effects owned here: the upsert, the audit row (fire-and-forget), and
 * the structured logs. Callers keep session auth, input parsing, and
 * HTTP/MCP response shaping.
 */
export async function submitAbstractReview(
  input: SubmitAbstractReviewInput,
): Promise<SubmitAbstractReviewResult> {
  const { eventId, abstractId, reviewerUserId, actor, source } = input;
  const onBehalf = actor.userId !== reviewerUserId;

  try {
    // ── Load event (settings + criteria), abstract, assignment, target user ──
    const [event, abstract, assignment, reviewer] = await Promise.all([
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
        select: { id: true, status: true },
      }),
      db.abstractReviewer.findUnique({
        where: { abstractId_userId: { abstractId, userId: reviewerUserId } },
        select: { id: true, conflictFlag: true },
      }),
      onBehalf
        ? db.user.findUnique({
            where: { id: reviewerUserId },
            select: { id: true, firstName: true, lastName: true, email: true },
          })
        : Promise.resolve(null),
    ]);

    if (!event) {
      apiLogger.warn({ msg: "abstract-submission:event-not-found", eventId, reviewerUserId, source });
      return { ok: false, code: "EVENT_NOT_FOUND", message: "Event not found" };
    }
    if (!abstract) {
      apiLogger.warn({ msg: "abstract-submission:abstract-not-found", eventId, abstractId, reviewerUserId, source });
      return { ok: false, code: "ABSTRACT_NOT_FOUND", message: "Abstract not found" };
    }
    if (onBehalf && !reviewer) {
      apiLogger.warn({ msg: "abstract-submission:target-user-not-found", eventId, abstractId, reviewerUserId, source });
      return { ok: false, code: "USER_NOT_FOUND", message: `User ${reviewerUserId} not found` };
    }

    // ── Authorization: pool OR assignment OR (self-submit by a bound admin) ──
    const reviewerUserIds =
      (event.settings as { reviewerUserIds?: string[] } | null)?.reviewerUserIds ?? [];
    const isPoolReviewer = reviewerUserIds.includes(reviewerUserId);
    // H3 org-bind lives HERE: role alone is not enough — the actor's org must
    // be the event's org, or an admin of org B could inject a score into org
    // A's peer review.
    const selfSubmitAdminBypass =
      !onBehalf &&
      !!actor.role &&
      ORG_ADMIN_ROLES.has(actor.role) &&
      !!actor.organizationId &&
      actor.organizationId === event.organizationId;
    if (!isPoolReviewer && !assignment && !selfSubmitAdminBypass) {
      apiLogger.warn({
        msg: "abstract-submission:not-a-reviewer",
        eventId, abstractId, reviewerUserId, actorUserId: actor.userId, role: actor.role ?? null, source,
      });
      return {
        ok: false,
        code: "NOT_A_REVIEWER",
        message: onBehalf
          ? `User ${reviewerUserId} is not a reviewer for this event. Assign them to the abstract or add to event.settings.reviewerUserIds first.`
          : "You are not a reviewer for this event",
      };
    }

    // ── H6: only a reviewable abstract can be scored ─────────────────────────
    if (!REVIEWABLE_ABSTRACT_STATUSES.has(abstract.status)) {
      apiLogger.warn({ msg: "abstract-submission:not-reviewable-status", eventId, abstractId, status: abstract.status, reviewerUserId, source });
      return {
        ok: false,
        code: "NOT_REVIEWABLE",
        message: `This abstract is ${abstract.status.toLowerCase()} and is not open for review.`,
      };
    }

    // ── COI: a conflicted reviewer's score must never count — self OR recorded ─
    if (assignment?.conflictFlag) {
      apiLogger.warn({ msg: "abstract-submission:coi-blocked", eventId, abstractId, reviewerUserId, onBehalfOf: onBehalf, source });
      return {
        ok: false,
        code: "CONFLICT_OF_INTEREST",
        message: onBehalf
          ? `Reviewer ${reviewerUserId} has a declared conflict of interest on this abstract; their review cannot be recorded.`
          : "You have a declared conflict of interest on this abstract and cannot submit a review for it. Contact the event organizer if this is incorrect.",
      };
    }

    // ── Payload validation (unified: REST semantics — integers everywhere) ───
    const { overallScore: overallInput, criteriaScores, reviewNotes, recommendedFormat, confidence } = input;

    const payloadIsEmpty =
      overallInput === undefined &&
      (criteriaScores === undefined || criteriaScores.length === 0) &&
      reviewNotes === undefined &&
      recommendedFormat === undefined &&
      confidence === undefined;
    if (payloadIsEmpty) {
      apiLogger.warn({ msg: "abstract-submission:empty-payload", eventId, abstractId, reviewerUserId, source });
      return { ok: false, code: "EMPTY_REVIEW", message: "A review must include a score, notes, or a recommendation." };
    }

    if (overallInput !== undefined && (!Number.isInteger(overallInput) || overallInput < 0 || overallInput > 100)) {
      return { ok: false, code: "INVALID_OVERALL_SCORE", message: "overallScore must be an integer between 0 and 100" };
    }
    if (confidence !== undefined && (!Number.isInteger(confidence) || confidence < 1 || confidence > 5)) {
      return { ok: false, code: "INVALID_CONFIDENCE", message: "confidence must be an integer between 1 and 5" };
    }
    if (recommendedFormat !== undefined && !RECOMMENDED_FORMAT_VALUES.has(recommendedFormat)) {
      return {
        ok: false,
        code: "INVALID_RECOMMENDED_FORMAT",
        message: `Invalid recommendedFormat. Must be one of: ${[...RECOMMENDED_FORMAT_VALUES].join(", ")}`,
      };
    }
    if (reviewNotes !== undefined && reviewNotes.length > 5000) {
      return { ok: false, code: "INVALID_REVIEW_NOTES", message: "reviewNotes must be at most 5000 characters" };
    }

    // Criteria: every id must exist on this event, no duplicates, integer 0-10.
    let criteriaScoresJson: Record<string, number> | null = null;
    let computedOverall: number | null = null;
    if (criteriaScores && criteriaScores.length > 0) {
      const validIds = new Set(event.reviewCriteria.map((c) => c.id));
      const weightMap = new Map(event.reviewCriteria.map((c) => [c.id, c.weight]));
      const cleaned: Record<string, number> = {};
      for (const { criterionId, score } of criteriaScores) {
        if (!validIds.has(criterionId)) {
          return { ok: false, code: "INVALID_CRITERION_ID", message: `Unknown criterion ID: ${criterionId}` };
        }
        if (Object.prototype.hasOwnProperty.call(cleaned, criterionId)) {
          return { ok: false, code: "DUPLICATE_CRITERION_ID", message: `Duplicate criterion ID: ${criterionId}` };
        }
        if (!Number.isInteger(score) || score < 0 || score > 10) {
          return { ok: false, code: "INVALID_CRITERION_SCORE", message: `Score for criterion ${criterionId} must be an integer 0-10` };
        }
        cleaned[criterionId] = score;
      }
      criteriaScoresJson = cleaned;
      if (overallInput === undefined) {
        computedOverall = computeWeightedOverallScore(
          Object.entries(cleaned).map(([id, score]) => ({ criterionId: id, score, weight: weightMap.get(id) ?? 0 })),
        );
      }
    }
    const overallScore = overallInput ?? computedOverall;

    // ── Upsert on (abstractId, reviewerUserId) ───────────────────────────────
    const submission = await db.abstractReviewSubmission.upsert({
      where: { abstractId_reviewerUserId: { abstractId, reviewerUserId } },
      create: {
        abstractId,
        reviewerUserId,
        abstractReviewerId: assignment?.id ?? null,
        criteriaScores: criteriaScoresJson ?? undefined,
        overallScore,
        reviewNotes: reviewNotes || null,
        recommendedFormat: (recommendedFormat as never) ?? null,
        confidence: confidence ?? null,
      },
      update: {
        ...(criteriaScoresJson && { criteriaScores: criteriaScoresJson }),
        ...(overallScore !== null && overallScore !== undefined && { overallScore }),
        // undefined = keep; "" = clear (REST semantics, now on every path).
        ...(reviewNotes !== undefined && { reviewNotes: reviewNotes || null }),
        ...(recommendedFormat !== undefined && { recommendedFormat: recommendedFormat as never }),
        ...(confidence !== undefined && { confidence }),
        // Re-link to the current assignment row (or clear if pool-only now) so
        // unassign → re-assign cycles don't leave a stale null FK.
        abstractReviewerId: assignment?.id ?? null,
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
      { eventId, abstractId, reviewerUserId, overallScore, ...(onBehalf && { onBehalfOf: true, actorUserId: actor.userId }) },
      wasCreate
        ? onBehalf ? "abstract-submission:created-on-behalf-of" : "abstract-submission:created"
        : onBehalf ? "abstract-submission:updated-on-behalf-of" : "abstract-submission:updated",
    );

    db.auditLog
      .create({
        data: {
          eventId,
          userId: actor.userId,
          action: wasCreate ? "CREATE" : "UPDATE",
          entityType: "AbstractReviewSubmission",
          entityId: submission.id,
          changes: {
            source: onBehalf ? `${source}-on-behalf-of` : source,
            abstractId,
            ...(onBehalf && { reviewerUserId, actorUserId: actor.userId }),
            overallScore,
            hasCriteriaScores: !!criteriaScoresJson,
            ...(input.requestIp ? { ip: input.requestIp } : {}),
          },
        },
      })
      .catch((err) => apiLogger.error({ err, eventId, abstractId }, "submit-review:audit-log-failed"));

    return {
      ok: true,
      submission,
      wasCreate,
      onBehalf,
      ...(onBehalf && reviewer ? { reviewer } : {}),
    };
  } catch (err) {
    apiLogger.error({ err, msg: "submitAbstractReview:unknown-failure", eventId, abstractId, reviewerUserId, source });
    return { ok: false, code: "UNKNOWN", message: "Failed to submit review" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reviewer assignment (duplication-audit finding 3, July 21, 2026).
//
// The REST POST .../abstracts/[abstractId]/reviewers + DELETE .../[userId] and
// the MCP assign_reviewer_to_abstract / unassign_reviewer_from_abstract tools
// used to carry ~130 mirrored lines that had drifted TWICE (H6: the
// reviewable-status gate was missing on one side; H8: the MCP executor silently
// dropped conflictFlag, letting a conflicted reviewer's score count). Every fix
// shipped as a hand-copied "parity with REST" patch. This is now the ONE
// implementation; both callers keep only parsing + response shaping.
// ─────────────────────────────────────────────────────────────────────────────

export type AbstractReviewerRole = "PRIMARY" | "SECONDARY" | "CONSULTING";

export interface AssignReviewerInput {
  eventId: string;
  organizationId: string;
  abstractId: string;
  reviewerUserId: string;
  /** undefined = keep the current role on an upsert / default SECONDARY on create. */
  role?: AbstractReviewerRole;
  /** undefined = keep the current flag on an upsert / default false on create. */
  conflictFlag?: boolean;
  /** Required — AbstractReviewer.assignedById is a non-nullable FK. */
  actorUserId: string;
  source: "rest" | "mcp";
  ip?: string | null;
}

export type AssignReviewerErrorCode =
  | "EVENT_NOT_FOUND"
  | "ABSTRACT_NOT_FOUND"
  | "USER_NOT_FOUND"
  | "NOT_REVIEWABLE"
  | "UNKNOWN";

export interface ReviewerAssignmentSummary {
  id: string;
  role: string;
  conflictFlag: boolean;
  assignedAt: Date | null;
}

export interface AssignedReviewerUser {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
}

export type AssignReviewerResult =
  | {
      ok: true;
      /** created = new assignment (notification sent); updated = role/COI flipped; noop = idempotent re-assign. */
      kind: "created" | "updated" | "noop";
      assignment: ReviewerAssignmentSummary;
      reviewer: AssignedReviewerUser;
    }
  | { ok: false; code: AssignReviewerErrorCode; message: string };

export async function assignReviewer(input: AssignReviewerInput): Promise<AssignReviewerResult> {
  const { eventId, abstractId, reviewerUserId } = input;
  try {
    const [event, abstract, user] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: input.organizationId },
        select: { id: true, name: true },
      }),
      db.abstract.findFirst({
        where: { id: abstractId, eventId },
        select: { id: true, title: true, status: true },
      }),
      db.user.findUnique({
        where: { id: reviewerUserId },
        select: { id: true, firstName: true, lastName: true, email: true },
      }),
    ]);

    if (!event) {
      apiLogger.warn({ msg: "abstract-reviewer:assign-rejected", code: "EVENT_NOT_FOUND", eventId, abstractId, source: input.source });
      return { ok: false, code: "EVENT_NOT_FOUND", message: "Event not found" };
    }
    if (!abstract) {
      apiLogger.warn({ msg: "abstract-reviewer:assign-rejected", code: "ABSTRACT_NOT_FOUND", eventId, abstractId, source: input.source });
      return { ok: false, code: "ABSTRACT_NOT_FOUND", message: "Abstract not found" };
    }
    if (!user) {
      apiLogger.warn({ msg: "abstract-reviewer:assign-rejected", code: "USER_NOT_FOUND", eventId, abstractId, targetUserId: reviewerUserId, source: input.source });
      return { ok: false, code: "USER_NOT_FOUND", message: "User not found" };
    }

    // H6: don't assign a reviewer onto an abstract that isn't up for review —
    // a DRAFT (author's private WIP), a WITHDRAWN, or an already-decided
    // abstract. Assignment + its notification email only make sense while the
    // abstract can actually be scored (parity with the scoring gate).
    if (!REVIEWABLE_ABSTRACT_STATUSES.has(abstract.status)) {
      apiLogger.warn({ msg: "abstract-reviewer:assign-rejected", code: "NOT_REVIEWABLE", eventId, abstractId, status: abstract.status, source: input.source });
      return {
        ok: false,
        code: "NOT_REVIEWABLE",
        message: `This abstract is ${abstract.status.toLowerCase()} and can't have reviewers assigned.`,
      };
    }

    // Upsert: if already assigned, update role/conflictFlag when the caller
    // passed a changed value (lets the UI/agent flip Primary↔Secondary or
    // toggle COI without an unassign+reassign round-trip). Nothing changed →
    // idempotent no-op reporting the current state.
    const existing = await db.abstractReviewer.findUnique({
      where: { abstractId_userId: { abstractId, userId: reviewerUserId } },
      select: { id: true, role: true, conflictFlag: true, assignedAt: true },
    });
    if (existing) {
      const roleChanged = input.role !== undefined && input.role !== existing.role;
      const conflictChanged = input.conflictFlag !== undefined && input.conflictFlag !== existing.conflictFlag;

      if (!roleChanged && !conflictChanged) {
        return { ok: true, kind: "noop", assignment: existing, reviewer: user };
      }

      const updated = await db.abstractReviewer.update({
        where: { abstractId_userId: { abstractId, userId: reviewerUserId } },
        data: {
          ...(roleChanged && { role: input.role }),
          ...(conflictChanged && { conflictFlag: input.conflictFlag }),
        },
        select: { id: true, role: true, assignedAt: true, conflictFlag: true },
      });

      apiLogger.info({
        msg: "abstract-reviewer:updated",
        eventId,
        abstractId,
        reviewerUserId,
        role: updated.role,
        previousRole: existing.role,
        conflictFlag: updated.conflictFlag,
        source: input.source,
      });
      db.auditLog
        .create({
          data: {
            eventId,
            userId: input.actorUserId,
            action: "UPDATE",
            entityType: "AbstractReviewer",
            entityId: updated.id,
            changes: {
              source: input.source,
              abstractId,
              reviewerUserId,
              role: updated.role,
              previousRole: existing.role,
              conflictFlag: updated.conflictFlag,
              previousConflictFlag: existing.conflictFlag,
              ...(input.ip ? { ip: input.ip } : {}),
            },
          },
        })
        .catch((err) => apiLogger.error({ err, eventId, abstractId }, "update-reviewer:audit-log-failed"));

      return { ok: true, kind: "updated", assignment: updated, reviewer: user };
    }

    const assignment = await db.abstractReviewer.create({
      data: {
        abstractId,
        userId: reviewerUserId,
        assignedById: input.actorUserId,
        role: input.role ?? "SECONDARY",
        conflictFlag: input.conflictFlag ?? false,
      },
      select: { id: true, role: true, assignedAt: true, conflictFlag: true },
    });

    apiLogger.info({ msg: "abstract-reviewer:assigned", eventId, abstractId, reviewerUserId, role: assignment.role, source: input.source });
    db.auditLog
      .create({
        data: {
          eventId,
          userId: input.actorUserId,
          action: "ASSIGN",
          entityType: "AbstractReviewer",
          entityId: assignment.id,
          changes: {
            source: input.source,
            abstractId,
            reviewerUserId,
            role: assignment.role,
            conflictFlag: assignment.conflictFlag,
            ...(input.ip ? { ip: input.ip } : {}),
          },
        },
      })
      .catch((err) => apiLogger.error({ err, eventId, abstractId }, "assign-reviewer:audit-log-failed"));

    // Tell the reviewer they have an abstract to review — only on a NEW
    // assignment (role/COI flips return above). Failure-isolated inside the
    // helper; never breaks the assignment.
    await notifyReviewerAssigned({
      eventId,
      organizationId: input.organizationId,
      reviewer: user,
      eventName: event.name,
      abstractTitle: abstract.title,
      role: assignment.role,
      source: input.source,
      triggeredByUserId: input.actorUserId,
    });

    return { ok: true, kind: "created", assignment, reviewer: user };
  } catch (err) {
    apiLogger.error({ err, msg: "assign-reviewer:failed", eventId, abstractId, source: input.source });
    return {
      ok: false,
      code: "UNKNOWN",
      message: err instanceof Error ? err.message : "Failed to assign reviewer",
    };
  }
}

export interface UnassignReviewerInput {
  eventId: string;
  organizationId: string;
  abstractId: string;
  reviewerUserId: string;
  actorUserId: string;
  source: "rest" | "mcp";
  ip?: string | null;
}

export type UnassignReviewerErrorCode =
  | "EVENT_NOT_FOUND"
  | "ABSTRACT_NOT_FOUND"
  | "ASSIGNMENT_NOT_FOUND"
  | "UNKNOWN";

export type UnassignReviewerResult =
  | { ok: true; unassignedAssignmentId: string }
  | { ok: false; code: UnassignReviewerErrorCode; message: string };

/**
 * Removes the AbstractReviewer row. Any existing AbstractReviewSubmission from
 * this user gets `abstractReviewerId` nulled via SET NULL FK — the submission
 * itself is preserved (scores/notes have independent value).
 */
export async function unassignReviewer(input: UnassignReviewerInput): Promise<UnassignReviewerResult> {
  const { eventId, abstractId, reviewerUserId } = input;
  try {
    const [event, abstract, assignment] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: input.organizationId },
        select: { id: true },
      }),
      db.abstract.findFirst({
        where: { id: abstractId, eventId },
        select: { id: true },
      }),
      db.abstractReviewer.findUnique({
        where: { abstractId_userId: { abstractId, userId: reviewerUserId } },
        select: { id: true },
      }),
    ]);
    if (!event) {
      apiLogger.warn({ msg: "abstract-reviewer:unassign-rejected", code: "EVENT_NOT_FOUND", eventId, abstractId, source: input.source });
      return { ok: false, code: "EVENT_NOT_FOUND", message: "Event not found" };
    }
    if (!abstract) {
      apiLogger.warn({ msg: "abstract-reviewer:unassign-rejected", code: "ABSTRACT_NOT_FOUND", eventId, abstractId, source: input.source });
      return { ok: false, code: "ABSTRACT_NOT_FOUND", message: "Abstract not found" };
    }
    if (!assignment) {
      apiLogger.warn({ msg: "abstract-reviewer:unassign-rejected", code: "ASSIGNMENT_NOT_FOUND", eventId, abstractId, reviewerUserId, source: input.source });
      return { ok: false, code: "ASSIGNMENT_NOT_FOUND", message: "Assignment not found" };
    }

    await db.abstractReviewer.delete({ where: { id: assignment.id } });

    apiLogger.info({ msg: "abstract-reviewer:unassigned", eventId, abstractId, reviewerUserId, source: input.source });
    db.auditLog
      .create({
        data: {
          eventId,
          userId: input.actorUserId,
          action: "UNASSIGN",
          entityType: "AbstractReviewer",
          entityId: assignment.id,
          changes: {
            source: input.source,
            abstractId,
            reviewerUserId,
            ...(input.ip ? { ip: input.ip } : {}),
          },
        },
      })
      .catch((err) => apiLogger.error({ err, eventId, abstractId }, "unassign-reviewer:audit-log-failed"));

    return { ok: true, unassignedAssignmentId: assignment.id };
  } catch (err) {
    apiLogger.error({ err, msg: "unassign-reviewer:failed", eventId, abstractId, source: input.source });
    return {
      ok: false,
      code: "UNKNOWN",
      message: err instanceof Error ? err.message : "Failed to unassign reviewer",
    };
  }
}
