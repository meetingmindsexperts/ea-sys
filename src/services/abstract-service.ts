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
  consolidateReviewNotes,
  readRequiredReviewCount,
} from "@/lib/abstract-review";
import { notifyAbstractStatusChange } from "@/lib/abstract-notifications";

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
      event: { select: { id: true, name: true, slug: true, settings: true } },
      speaker: { select: { id: true, email: true, additionalEmail: true, firstName: true, lastName: true } },
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

  // Gate ACCEPTED / REJECTED transitions on sufficient review submissions
  // unless the caller passed forceStatus (which must be admin-authorized
  // at the caller's boundary — service doesn't re-check authz here).
  const gateRelevant = newStatus === "ACCEPTED" || newStatus === "REJECTED";
  let aggregateResult: Awaited<ReturnType<typeof computeSubmissionAggregates>> | null = null;
  if (gateRelevant) {
    aggregateResult = await computeSubmissionAggregates(abstractId);
    const requiredCount = readRequiredReviewCount(abstract.event.settings);
    if (!forceStatus && aggregateResult.aggregates.count < requiredCount) {
      apiLogger.warn(
        { abstractId, currentCount: aggregateResult.aggregates.count, required: requiredCount, userId },
        "abstract-status:insufficient-reviews",
      );
      return {
        ok: false,
        code: "INSUFFICIENT_REVIEWS",
        message: `This event requires ${requiredCount} review submission(s) before ${newStatus}. Current: ${aggregateResult.aggregates.count}.`,
        meta: { currentCount: aggregateResult.aggregates.count, required: requiredCount },
      };
    }
  }

  const previousStatus = abstract.status;
  const isReview =
    newStatus === "UNDER_REVIEW" ||
    newStatus === "ACCEPTED" ||
    newStatus === "REJECTED" ||
    newStatus === "REVISION_REQUESTED";

  // DB update is the authoritative state change. Fail loudly here.
  let updated: { id: string; title: string; status: string };
  try {
    updated = await db.abstract.update({
      where: { id: abstractId },
      data: {
        status: newStatus,
        ...(isReview && { reviewedAt: new Date() }),
      },
      select: { id: true, title: true, status: true },
    });
  } catch (err) {
    apiLogger.error({ err, abstractId }, "abstract-service:update-failed");
    return {
      ok: false,
      code: "UNKNOWN",
      message: err instanceof Error ? err.message : "Failed to update abstract status",
    };
  }

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
