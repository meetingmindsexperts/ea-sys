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

import { can, principalFromUser } from "@/lib/permissions/can";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { refreshEventStats } from "@/lib/event-stats";
import {
  computeSubmissionAggregates,
  computeWeightedOverallScore,
  consolidateReviewNotes,
  readRequiredReviewCount,
} from "@/lib/abstract-review";
import { notifyAbstractStatusChange } from "@/lib/abstract-notifications";
import { REVIEWABLE_ABSTRACT_STATUSES as REVIEWABLE_STATUS_LIST, isOwnAbstract, mustConfirmEmailToReview, reviewerPoolIds } from "@/lib/abstract-reviewer-access";
import { recommendableFormats, type RecommendedFormatValue } from "@/lib/recommended-formats";

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
  source: "rest" | "mcp" | "agent" | "api";
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
    // tenantTransaction (not db.$transaction): the abstract.updateMany below is a
    // swept-table write, so the SET LOCAL must ride this tx's own pooled backend.
    // Passthrough on master; orgId comes from the caller's runWithTenant store.
    outcome = await tenantTransaction(async (tx): Promise<TxOutcome> => {
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
  //   - "rest" | "mcp" | "agent" | "api" otherwise, from the caller
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

export type ReviewRecommendedFormat = RecommendedFormatValue;

/** Abstract statuses open for review — shared with the assign paths (H6). */
export const REVIEWABLE_ABSTRACT_STATUSES = new Set<string>(REVIEWABLE_STATUS_LIST);

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
    /** The session counter when there is a session (mustConfirmEmailToReview). */
    tokenVersion?: number;
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
  source: "rest" | "mcp" | "agent";
  requestIp?: string | null;
}

export type SubmitAbstractReviewErrorCode =
  | "EVENT_NOT_FOUND"
  | "ABSTRACT_NOT_FOUND"
  | "USER_NOT_FOUND"
  | "NOT_A_REVIEWER"
  | "NOT_REVIEWABLE"
  | "OWN_ABSTRACT"
  | "EMAIL_NOT_CONFIRMED"
  | "INCOMPLETE_CRITERIA"
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

function submissionLogMessage(wasCreate: boolean, onBehalf: boolean): string {
  if (wasCreate) return onBehalf ? "abstract-submission:created-on-behalf-of" : "abstract-submission:created";
  return onBehalf ? "abstract-submission:updated-on-behalf-of" : "abstract-submission:updated";
}

/**
 * What this event offers (Content, Abstracts), or the value already on the
 * review: an organiser narrowing the types must not block re-saving a score.
 * The stored value is read only when the event does not offer the format.
 */
async function isFormatAccepted(
  settings: unknown,
  format: string,
  abstractId: string,
  reviewerUserId: string,
): Promise<boolean> {
  const offered: string[] = recommendableFormats(settings);
  if (offered.includes(format)) return true;
  const existing = await db.abstractReviewSubmission.findUnique({
    where: { abstractId_reviewerUserId: { abstractId, reviewerUserId } },
    select: { recommendedFormat: true },
  });
  return existing?.recommendedFormat === format;
}

/**
 * Create or update one reviewer's submission for an abstract.
 *
 * Authorization (domain rule, owned here):
 *  - the target reviewer must hold an `AbstractReviewer` assignment on this
 *    abstract; the event's reviewer pool alone is not enough (Nov 10, 2026);
 *  - EXCEPT a self-submitting org admin/organizer (role AND org bound to the
 *    event's org — the H3 bind) may score without one;
 *  - the on-behalf path (actor ≠ reviewer) never gets the admin bypass — the
 *    TARGET must be assigned.
 * The account's role does not enter into it (src/lib/abstract-reviewer-access.ts).
 *
 * Nobody scores their own abstract, on any path, admin bypass included.
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
        select: { id: true, status: true, speaker: { select: { userId: true, email: true } } },
      }),
      db.abstractReviewer.findUnique({
        where: { abstractId_userId: { abstractId, userId: reviewerUserId } },
        select: { id: true, conflictFlag: true },
      }),
      db.user.findUnique({
        where: { id: reviewerUserId },
        select: { id: true, firstName: true, lastName: true, email: true, role: true, emailConfirmedAt: true, tokenVersion: true },
      }),
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

    // ── Authorization: assignment OR (self-submit by a bound admin) ──────────
    // The reviewer pool alone grants nothing (abstract-reviewer-access.ts).
    // H3 org-bind lives HERE: role alone is not enough — the actor's org must
    // be the event's org, or an admin of org B could inject a score into org
    // A's peer review.
    const selfSubmitAdminBypass =
      !onBehalf &&
      !!actor.role &&
      // An admin scoring their own review: whoever decides abstracts.
      can(principalFromUser({ id: actor.userId, role: actor.role, organizationId: actor.organizationId }), "abstracts.decide") &&
      !!actor.organizationId &&
      actor.organizationId === event.organizationId;
    if (!assignment && !selfSubmitAdminBypass) {
      apiLogger.warn({
        msg: "abstract-submission:not-a-reviewer",
        eventId, abstractId, reviewerUserId, actorUserId: actor.userId, role: actor.role ?? null, source,
      });
      return {
        ok: false,
        code: "NOT_A_REVIEWER",
        message: onBehalf
          ? `User ${reviewerUserId} is not assigned to this abstract. Assign them to it first.`
          : "You are not assigned to review this abstract",
      };
    }

    // ── An outside account proves its address before it reviews. Recording on
    // someone's behalf is the organiser vouching for them, so it is not asked.
    if (!onBehalf && !selfSubmitAdminBypass && mustConfirmEmailToReview(reviewer, actor.tokenVersion)) {
      apiLogger.warn({ msg: "abstract-submission:email-not-confirmed", eventId, abstractId, reviewerUserId, source });
      return { ok: false, code: "EMAIL_NOT_CONFIRMED", message: "Confirm your email address to review abstracts." };
    }

    // ── Nobody scores their own abstract ─────────────────────────────────────
    if (isOwnAbstract(abstract.speaker, { id: reviewerUserId, email: reviewer?.email })) {
      apiLogger.warn({ msg: "abstract-submission:own-abstract", eventId, abstractId, reviewerUserId, actorUserId: actor.userId, source });
      return {
        ok: false,
        code: "OWN_ABSTRACT",
        message: onBehalf
          ? `User ${reviewerUserId} is the author of this abstract and cannot review it.`
          : "This is your own abstract, so you cannot review it.",
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
    if (recommendedFormat !== undefined && !(await isFormatAccepted(event.settings, recommendedFormat, abstractId, reviewerUserId))) {
      apiLogger.warn({ msg: "abstract-submission:format-not-offered", eventId, abstractId, recommendedFormat, source });
      return {
        ok: false,
        code: "INVALID_RECOMMENDED_FORMAT",
        message: `This event does not offer that format. Choose one of: ${recommendableFormats(event.settings).join(", ")}`,
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
      // The score is computed over the criteria sent, so some of them would
      // average out the ones left out: 10 on a weight-10 criterion alone is not
      // a perfect review. A caller that sets overallScore itself may send a part.
      if (overallInput === undefined && event.reviewCriteria.some((c) => !Object.prototype.hasOwnProperty.call(cleaned, c.id))) {
        apiLogger.warn({ msg: "abstract-submission:incomplete-criteria", eventId, abstractId, reviewerUserId, source });
        return { ok: false, code: "INCOMPLETE_CRITERIA", message: "Score every criterion, or give an overall score." };
      }
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
        organizationId: event.organizationId, // tenancy: the abstract's event's org
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
      submissionLogMessage(wasCreate, onBehalf),
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
  source: "rest" | "mcp" | "agent";
  ip?: string | null;
}

export type AssignReviewerErrorCode =
  | "EVENT_NOT_FOUND"
  | "ABSTRACT_NOT_FOUND"
  | "USER_NOT_FOUND"
  | "NOT_REVIEWABLE"
  | "OWN_ABSTRACT"
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
      /** created = new assignment (no email: My Reviews shows it); updated = role/COI flipped; noop = idempotent re-assign. */
      kind: "created" | "updated" | "noop";
      assignment: ReviewerAssignmentSummary;
      reviewer: AssignedReviewerUser;
    }
  | { ok: false; code: AssignReviewerErrorCode; message: string };

/** Why a reviewer cannot be put on an abstract. */
export type ReviewerAssignmentRefusal = "NOT_REVIEWABLE" | "OWN_ABSTRACT";

/**
 * THE rule for one (abstract, reviewer) pair, asked by the single assign above
 * and the bulk assign below so the two cannot drift (the H6 and H8 class):
 *
 *  1. An abstract that is not up for review (a draft, withdrawn, decided)
 *     takes no reviewer, and an existing assignment on it cannot be edited.
 *  2. A pair that is already assigned is never refused beyond that: the row
 *     exists, so it can still be flagged, changed or left alone.
 *  3. Nobody is NEWLY assigned their own abstract (abstract-reviewer-access.ts):
 *     the portal hides it and the review service refuses it.
 */
export function reviewerAssignmentRefusal(
  abstract: { status: string; speaker?: { userId?: string | null; email?: string | null } | null },
  user: { id: string; email?: string | null },
  alreadyAssigned: boolean,
): ReviewerAssignmentRefusal | null {
  if (!REVIEWABLE_ABSTRACT_STATUSES.has(abstract.status)) return "NOT_REVIEWABLE";
  if (alreadyAssigned) return null;
  return isOwnAbstract(abstract.speaker, { id: user.id, email: user.email }) ? "OWN_ABSTRACT" : null;
}

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
        select: { id: true, title: true, status: true, speaker: { select: { userId: true, email: true } } },
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

    // The pair's rule (reviewerAssignmentRefusal), shared with the bulk path.
    // H6: an abstract that isn't up for review takes no reviewer at all.
    if (reviewerAssignmentRefusal(abstract, user, false) === "NOT_REVIEWABLE") {
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

    // Nobody reviews their own abstract (abstract-reviewer-access.ts), so
    // nobody is newly assigned it either: the portal hides it, the review
    // service refuses it, and the assignment email would list an abstract its
    // reader cannot open. An existing row can still be edited or flagged above.
    if (reviewerAssignmentRefusal(abstract, user, false) === "OWN_ABSTRACT") {
      apiLogger.warn({ msg: "abstract-reviewer:assign-rejected", code: "OWN_ABSTRACT", eventId, abstractId, targetUserId: reviewerUserId, source: input.source });
      return { ok: false, code: "OWN_ABSTRACT", message: "This is their own abstract, so they cannot review it." };
    }

    const assignment = await db.abstractReviewer.create({
      data: {
        abstractId,
        organizationId: input.organizationId, // tenancy: the abstract's event's org
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

    // No email here (owner, Nov 10, 2026): My Reviews shows the reviewer what
    // they hold, and the organiser sends the one Reviewer Invitation from the
    // Reviewers page (sendReviewerInvitation in abstract-reviewer-notify.ts).

    return { ok: true, kind: "created", assignment, reviewer: user };
  } catch (err) {
    apiLogger.error({ err, msg: "assign-reviewer:failed", eventId, abstractId, source: input.source });
    // Static message (review M2) — the raw error is logged above, never surfaced
    // to callers (a Prisma error string in a toast is an info leak).
    return { ok: false, code: "UNKNOWN", message: "Failed to assign reviewer" };
  }
}

export interface UnassignReviewerInput {
  eventId: string;
  organizationId: string;
  abstractId: string;
  reviewerUserId: string;
  actorUserId: string;
  source: "rest" | "mcp" | "agent";
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
    return { ok: false, code: "UNKNOWN", message: "Failed to unassign reviewer" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk reviewer assignment (Nov 12, 2026).
//
// A committee chair says "abstract 012 goes to Dr X" for a few hundred
// abstracts; one by one that was two clicks each. The Abstracts page now sends
// many (abstract, reviewer) pairs at once: from ticked rows, from pasted
// abstract numbers, or from a pasted sheet (src/lib/abstract-reviewer-sheet.ts).
//
// Same rules as the single assign, because both ask reviewerAssignmentRefusal:
// no email, no own abstract, nothing on a draft or a withdrawn abstract, and
// running it twice changes nothing. Two things differ on purpose:
//
//  - Only people on the event's REVIEWER POOL can be bulk assigned. The single
//    assign takes anyone (the agent uses that); in bulk a wrong id would land
//    on hundreds of abstracts, so the pool is the fence.
//  - Bulk never changes an existing assignment's role or conflict flag, and
//    bulk remove never takes an assignment whose reviewer has already
//    submitted a review. Those stay one-by-one decisions.
// ─────────────────────────────────────────────────────────────────────────────

/** One reviewer and the abstracts they are to be put on (or taken off). */
export interface BulkReviewerGroup {
  reviewerUserId: string;
  abstractIds: string[];
}

/** The most pairs one request may carry: 1,500 abstracts with three reviewers each, with room. */
export const MAX_BULK_REVIEWER_PAIRS = 5000;

/** Rows per write statement, well under Postgres's bind-parameter ceiling. */
const BULK_REVIEWER_CHUNK = 500;

export interface BulkReviewerInput {
  eventId: string;
  organizationId: string;
  groups: BulkReviewerGroup[];
  actorUserId: string;
  source: "rest" | "mcp" | "agent";
  ip?: string | null;
}

export type BulkAssignSkipReason = "ABSTRACT_NOT_FOUND" | "NOT_ON_POOL" | ReviewerAssignmentRefusal;
export type BulkUnassignSkipReason = "HAS_REVIEW";

export interface BulkReviewerSkip<Reason extends string> {
  abstractId: string;
  reviewerUserId: string;
  reason: Reason;
}

export type BulkReviewerErrorCode = "EVENT_NOT_FOUND" | "NO_PAIRS" | "TOO_MANY" | "UNKNOWN";

export type BulkAssignReviewersResult =
  | {
      ok: true;
      /** New assignments written by this call. */
      assigned: number;
      /** Pairs that were assigned already: left exactly as they were. */
      alreadyAssigned: number;
      skipped: BulkReviewerSkip<BulkAssignSkipReason>[];
    }
  | { ok: false; code: BulkReviewerErrorCode; message: string };

export type BulkUnassignReviewersResult =
  | {
      ok: true;
      removed: number;
      /** Pairs with no assignment to remove. */
      notAssigned: number;
      skipped: BulkReviewerSkip<BulkUnassignSkipReason>[];
    }
  | { ok: false; code: BulkReviewerErrorCode; message: string };

const pairKey = (abstractId: string, reviewerUserId: string) => `${abstractId}:${reviewerUserId}`;

/** The request as distinct pairs: a pair named twice (two sheet rows) counts once. */
function distinctReviewerPairs(groups: BulkReviewerGroup[]) {
  const byReviewer = new Map<string, Set<string>>();
  for (const group of groups) {
    const ids = byReviewer.get(group.reviewerUserId) ?? new Set<string>();
    for (const abstractId of group.abstractIds) ids.add(abstractId);
    byReviewer.set(group.reviewerUserId, ids);
  }
  const abstractIds = new Set<string>();
  let count = 0;
  for (const ids of byReviewer.values()) {
    count += ids.size;
    for (const id of ids) abstractIds.add(id);
  }
  return { byReviewer, reviewerIds: [...byReviewer.keys()], abstractIds: [...abstractIds], count };
}

/** Refuse a request that names nothing, or more than one request should carry. */
function bulkPairsRefusal(count: number): { ok: false; code: BulkReviewerErrorCode; message: string } | null {
  if (count === 0) return { ok: false, code: "NO_PAIRS", message: "Choose at least one abstract and one reviewer." };
  if (count > MAX_BULK_REVIEWER_PAIRS) {
    return {
      ok: false,
      code: "TOO_MANY",
      message: `That is ${count} assignments in one go; the most is ${MAX_BULK_REVIEWER_PAIRS}. Do it in smaller batches.`,
    };
  }
  return null;
}

function chunksOf<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function countByReason(skipped: { reason: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of skipped) counts[s.reason] = (counts[s.reason] ?? 0) + 1;
  return counts;
}

/** What happens to one pair of a bulk assign. */
function bulkAssignOutcome(
  abstract: { status: string; speaker?: { userId?: string | null; email?: string | null } | null } | undefined,
  poolUser: { id: string; email: string } | undefined,
  alreadyAssigned: boolean,
): BulkAssignSkipReason | "ALREADY" | "CREATE" {
  if (!poolUser) return "NOT_ON_POOL";
  if (!abstract) return "ABSTRACT_NOT_FOUND";
  const refusal = reviewerAssignmentRefusal(abstract, poolUser, alreadyAssigned);
  if (refusal) return refusal;
  return alreadyAssigned ? "ALREADY" : "CREATE";
}

/** One audit row per assignment written or removed, in the single paths' shape plus `bulk`. */
async function auditBulkReviewerRows(
  input: BulkReviewerInput,
  action: "ASSIGN" | "UNASSIGN",
  rows: { id: string; abstractId: string; userId: string }[],
): Promise<void> {
  try {
    for (const chunk of chunksOf(rows, BULK_REVIEWER_CHUNK)) {
      await db.auditLog.createMany({
        data: chunk.map((row) => ({
          eventId: input.eventId,
          userId: input.actorUserId,
          // Explicit: without it the audit stamp looks the event up once per row.
          organizationId: input.organizationId,
          action,
          entityType: "AbstractReviewer",
          entityId: row.id,
          changes: {
            source: input.source,
            bulk: true,
            abstractId: row.abstractId,
            reviewerUserId: row.userId,
            ...(input.ip ? { ip: input.ip } : {}),
          },
        })),
      });
    }
  } catch (err) {
    apiLogger.error({ err, eventId: input.eventId, action, rows: rows.length }, "bulk-reviewers:audit-log-failed");
  }
}

/**
 * Put each group's reviewer on each of its abstracts. Additive and idempotent:
 * an existing assignment is left as it is (role and conflict flag included),
 * and every pair that cannot be assigned comes back in `skipped` with why.
 * All the new rows are written in one transaction, so a failure assigns nothing.
 */
export async function assignReviewersBulk(input: BulkReviewerInput): Promise<BulkAssignReviewersResult> {
  const { eventId } = input;
  try {
    const pairs = distinctReviewerPairs(input.groups);
    const refusal = bulkPairsRefusal(pairs.count);
    if (refusal) {
      apiLogger.warn({ msg: "abstract-reviewer:bulk-assign-rejected", code: refusal.code, eventId, pairs: pairs.count, source: input.source });
      return refusal;
    }

    const [event, abstracts, users, existing] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: input.organizationId },
        select: { id: true, settings: true },
      }),
      db.abstract.findMany({
        where: { eventId, id: { in: pairs.abstractIds } },
        select: { id: true, status: true, speaker: { select: { userId: true, email: true } } },
      }),
      db.user.findMany({
        where: { id: { in: pairs.reviewerIds } },
        select: { id: true, email: true },
      }),
      db.abstractReviewer.findMany({
        where: { abstract: { eventId }, abstractId: { in: pairs.abstractIds }, userId: { in: pairs.reviewerIds } },
        select: { abstractId: true, userId: true },
      }),
    ]);
    if (!event) {
      apiLogger.warn({ msg: "abstract-reviewer:bulk-assign-rejected", code: "EVENT_NOT_FOUND", eventId, source: input.source });
      return { ok: false, code: "EVENT_NOT_FOUND", message: "Event not found" };
    }

    const pool = new Set(reviewerPoolIds(event.settings));
    const poolUsers = new Map(users.filter((u) => pool.has(u.id)).map((u) => [u.id, u]));
    const abstractsById = new Map(abstracts.map((a) => [a.id, a]));
    const assignedKeys = new Set(existing.map((row) => pairKey(row.abstractId, row.userId)));

    const skipped: BulkReviewerSkip<BulkAssignSkipReason>[] = [];
    const toCreate: { abstractId: string; userId: string }[] = [];
    let alreadyAssigned = 0;
    for (const [reviewerUserId, abstractIds] of pairs.byReviewer) {
      const poolUser = poolUsers.get(reviewerUserId);
      for (const abstractId of abstractIds) {
        const outcome = bulkAssignOutcome(
          abstractsById.get(abstractId),
          poolUser,
          assignedKeys.has(pairKey(abstractId, reviewerUserId)),
        );
        if (outcome === "CREATE") toCreate.push({ abstractId, userId: reviewerUserId });
        else if (outcome === "ALREADY") alreadyAssigned++;
        else skipped.push({ abstractId, reviewerUserId, reason: outcome });
      }
    }

    // One transaction: "Failed" then means nothing was assigned. skipDuplicates
    // covers a pair somebody else assigned between the read above and here.
    const created = toCreate.length === 0
      ? []
      : await tenantTransaction(async (tx) => {
          const rows: { id: string; abstractId: string; userId: string }[] = [];
          for (const chunk of chunksOf(toCreate, BULK_REVIEWER_CHUNK)) {
            const written = await tx.abstractReviewer.createManyAndReturn({
              data: chunk.map((pair) => ({
                abstractId: pair.abstractId,
                organizationId: input.organizationId, // tenancy: the abstract's event's org
                userId: pair.userId,
                assignedById: input.actorUserId,
              })),
              skipDuplicates: true,
              select: { id: true, abstractId: true, userId: true },
            });
            rows.push(...written);
          }
          return rows;
        }, { timeout: 30_000 });
    alreadyAssigned += toCreate.length - created.length;

    apiLogger.info({
      msg: "abstract-reviewer:bulk-assigned",
      eventId,
      assigned: created.length,
      alreadyAssigned,
      skipped: skipped.length,
      reviewers: pairs.reviewerIds.length,
      abstracts: pairs.abstractIds.length,
      source: input.source,
    });
    if (skipped.length > 0) {
      apiLogger.warn({ msg: "abstract-reviewer:bulk-assign-skipped", eventId, byReason: countByReason(skipped), source: input.source });
    }
    await auditBulkReviewerRows(input, "ASSIGN", created);

    // No email here, as with the single assign: the organiser sends the
    // Reviewer Invitation from the Reviewers page.
    return { ok: true, assigned: created.length, alreadyAssigned, skipped };
  } catch (err) {
    apiLogger.error({ err, msg: "bulk-assign-reviewers:failed", eventId, source: input.source });
    return { ok: false, code: "UNKNOWN", message: "Failed to assign reviewers" };
  }
}

/**
 * Take each group's reviewer off each of its abstracts: the undo for a wrong
 * bulk assign. An assignment whose reviewer has already submitted a review is
 * never removed here (skipped as HAS_REVIEW); that stays a one-by-one decision
 * on the abstract's own Reviewers card.
 */
export async function unassignReviewersBulk(input: BulkReviewerInput): Promise<BulkUnassignReviewersResult> {
  const { eventId } = input;
  try {
    const pairs = distinctReviewerPairs(input.groups);
    const refusal = bulkPairsRefusal(pairs.count);
    if (refusal) {
      apiLogger.warn({ msg: "abstract-reviewer:bulk-unassign-rejected", code: refusal.code, eventId, pairs: pairs.count, source: input.source });
      return refusal;
    }

    const [event, assignments, reviews] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: input.organizationId },
        select: { id: true },
      }),
      db.abstractReviewer.findMany({
        where: { abstract: { eventId }, abstractId: { in: pairs.abstractIds }, userId: { in: pairs.reviewerIds } },
        select: { id: true, abstractId: true, userId: true },
      }),
      db.abstractReviewSubmission.findMany({
        where: { abstract: { eventId }, abstractId: { in: pairs.abstractIds }, reviewerUserId: { in: pairs.reviewerIds } },
        select: { abstractId: true, reviewerUserId: true },
      }),
    ]);
    if (!event) {
      apiLogger.warn({ msg: "abstract-reviewer:bulk-unassign-rejected", code: "EVENT_NOT_FOUND", eventId, source: input.source });
      return { ok: false, code: "EVENT_NOT_FOUND", message: "Event not found" };
    }

    const assignmentByKey = new Map(assignments.map((row) => [pairKey(row.abstractId, row.userId), row]));
    const reviewedKeys = new Set(reviews.map((row) => pairKey(row.abstractId, row.reviewerUserId)));

    const skipped: BulkReviewerSkip<BulkUnassignSkipReason>[] = [];
    const toRemove: { id: string; abstractId: string; userId: string }[] = [];
    let notAssigned = 0;
    for (const [reviewerUserId, abstractIds] of pairs.byReviewer) {
      for (const abstractId of abstractIds) {
        const key = pairKey(abstractId, reviewerUserId);
        const row = assignmentByKey.get(key);
        if (!row) notAssigned++;
        else if (reviewedKeys.has(key)) skipped.push({ abstractId, reviewerUserId, reason: "HAS_REVIEW" });
        else toRemove.push(row);
      }
    }

    // A review can land between the read above and the delete. The delete
    // itself refuses a row a review hangs on, and whatever survived is
    // reported as skipped, so the count and the audit say what happened.
    const removed = toRemove.length === 0
      ? []
      : await tenantTransaction(async (tx) => {
          const ids = toRemove.map((row) => row.id);
          for (const chunk of chunksOf(ids, BULK_REVIEWER_CHUNK)) {
            await tx.abstractReviewer.deleteMany({ where: { id: { in: chunk }, submissions: { none: {} } } });
          }
          const survivors = new Set(
            (await tx.abstractReviewer.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((row) => row.id),
          );
          return toRemove.filter((row) => !survivors.has(row.id));
        }, { timeout: 30_000 });
    const removedIds = new Set(removed.map((row) => row.id));
    for (const row of toRemove) {
      if (!removedIds.has(row.id)) skipped.push({ abstractId: row.abstractId, reviewerUserId: row.userId, reason: "HAS_REVIEW" });
    }

    apiLogger.info({
      msg: "abstract-reviewer:bulk-unassigned",
      eventId,
      removed: removed.length,
      notAssigned,
      skipped: skipped.length,
      reviewers: pairs.reviewerIds.length,
      abstracts: pairs.abstractIds.length,
      source: input.source,
    });
    if (skipped.length > 0) {
      apiLogger.warn({ msg: "abstract-reviewer:bulk-unassign-skipped", eventId, byReason: countByReason(skipped), source: input.source });
    }
    await auditBulkReviewerRows(input, "UNASSIGN", removed);

    return { ok: true, removed: removed.length, notAssigned, skipped };
  } catch (err) {
    apiLogger.error({ err, msg: "bulk-unassign-reviewers:failed", eventId, source: input.source });
    return { ok: false, code: "UNKNOWN", message: "Failed to remove reviewers" };
  }
}
