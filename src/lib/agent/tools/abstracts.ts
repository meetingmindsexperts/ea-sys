import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { refreshEventStats } from "@/lib/event-stats";
import { notifyAbstractStatusChange } from "@/lib/abstract-notifications";
import {
  computeSubmissionAggregates,
  consolidateReviewNotes,
  readRequiredReviewCount,
  computeWeightedOverallScore,
  type CriterionScore,
} from "@/lib/abstract-review";
import type { ToolExecutor } from "./_shared";

const ABSTRACT_STATUSES = new Set(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED", "WITHDRAWN"]);
const ABSTRACT_UPDATE_STATUSES = new Set(["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"]);

const listAbstractThemes: ToolExecutor = async (_input, ctx) => {
  try {
    const themes = await db.abstractTheme.findMany({
      where: { eventId: ctx.eventId },
      select: { id: true, name: true, sortOrder: true },
      orderBy: { sortOrder: "asc" },
    });
    return { themes, total: themes.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_abstract_themes failed");
    return { error: "Failed to fetch abstract themes" };
  }
};

const createAbstractTheme: ToolExecutor = async (input, ctx) => {
  try {
    const name = String(input.name ?? "").trim();
    if (!name) return { error: "name is required" };

    const existing = await db.abstractTheme.findFirst({
      where: { eventId: ctx.eventId, name: { equals: name, mode: "insensitive" } },
    });
    if (existing) return { alreadyExists: true, theme: existing };

    const count = await db.abstractTheme.count({ where: { eventId: ctx.eventId } });
    const theme = await db.abstractTheme.create({
      data: { eventId: ctx.eventId, name, sortOrder: count },
    });
    return { theme };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_abstract_theme failed");
    return { error: "Failed to create abstract theme" };
  }
};

const listReviewCriteria: ToolExecutor = async (_input, ctx) => {
  try {
    const criteria = await db.reviewCriterion.findMany({
      where: { eventId: ctx.eventId },
      select: { id: true, name: true, weight: true, sortOrder: true },
      orderBy: { sortOrder: "asc" },
    });
    return { criteria, total: criteria.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_review_criteria failed");
    return { error: "Failed to fetch review criteria" };
  }
};

const createReviewCriterion: ToolExecutor = async (input, ctx) => {
  try {
    const name = String(input.name ?? "").trim();
    const weight = Number(input.weight ?? 1);
    if (!name) return { error: "name is required" };
    if (weight < 1 || weight > 10) return { error: "weight must be between 1 and 10" };

    const count = await db.reviewCriterion.count({ where: { eventId: ctx.eventId } });
    const criterion = await db.reviewCriterion.create({
      data: { eventId: ctx.eventId, name, weight, sortOrder: count },
    });
    return { criterion };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_review_criterion failed");
    return { error: "Failed to create review criterion" };
  }
};

const listAbstracts: ToolExecutor = async (input, ctx) => {
  try {
    const limit = Math.min(Number(input.limit ?? 50), 200);
    const statusValue = input.status ? String(input.status) : undefined;
    if (statusValue && !ABSTRACT_STATUSES.has(statusValue)) {
      return { error: `Invalid status. Must be one of: ${[...ABSTRACT_STATUSES].join(", ")}` };
    }
    const abstracts = await db.abstract.findMany({
      where: {
        eventId: ctx.eventId,
        ...(statusValue ? { status: statusValue as never } : {}),
        ...(input.themeId ? { themeId: String(input.themeId) } : {}),
      },
      select: {
        id: true, title: true, status: true, specialty: true, presentationType: true,
        submittedAt: true,
        speaker: { select: { firstName: true, lastName: true, email: true } },
        theme: { select: { name: true } },
        track: { select: { name: true } },
        submissions: {
          select: { overallScore: true },
        },
      },
      take: limit,
      orderBy: { submittedAt: "desc" },
    });
    // Fold a lightweight aggregate onto each row so the list UI + Claude
    // don't have to make a second call just to show scores.
    const enriched = abstracts.map((a) => {
      const overalls = a.submissions
        .map((s) => s.overallScore)
        .filter((s): s is number => s != null);
      const meanOverall = overalls.length
        ? Math.round((overalls.reduce((x, y) => x + y, 0) / overalls.length) * 10) / 10
        : null;
      // Strip the submissions array — agent callers only want the rollup.
      const rest: Omit<typeof a, "submissions"> & { submissions?: typeof a.submissions } = { ...a };
      delete rest.submissions;
      return {
        ...rest,
        reviewCount: a.submissions.length,
        meanOverallScore: meanOverall,
      };
    });
    return { abstracts: enriched, total: enriched.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_abstracts failed");
    return { error: "Failed to fetch abstracts" };
  }
};

const updateAbstractStatus: ToolExecutor = async (input, ctx) => {
  try {
    const abstractId = String(input.abstractId ?? "").trim();
    const status = String(input.status ?? "").trim();
    const force = input.force === true;
    if (!abstractId) return { error: "abstractId is required", code: "MISSING_ABSTRACT_ID" };
    if (!ABSTRACT_UPDATE_STATUSES.has(status)) {
      return {
        error: `Invalid status. Must be one of: ${[...ABSTRACT_UPDATE_STATUSES].join(", ")}`,
        code: "INVALID_STATUS",
      };
    }

    const abstract = await db.abstract.findFirst({
      where: { id: abstractId, eventId: ctx.eventId },
      select: {
        id: true,
        title: true,
        status: true,
        event: { select: { id: true, name: true, slug: true, settings: true } },
        speaker: { select: { email: true, firstName: true, lastName: true } },
      },
    });
    if (!abstract) return { error: `Abstract ${abstractId} not found`, code: "ABSTRACT_NOT_FOUND" };

    // Terminal-state guard: WITHDRAWN is the only truly terminal status.
    // ACCEPTED ↔ REJECTED transitions are allowed (organizer may change mind).
    if (abstract.status === "WITHDRAWN") {
      return {
        error: "Cannot update a withdrawn abstract",
        code: "ABSTRACT_WITHDRAWN",
        currentStatus: abstract.status,
        suggestion: "Withdrawn abstracts are terminal. The submitter must resubmit a new abstract.",
      };
    }

    // Gate ACCEPTED / REJECTED transitions on sufficient review submissions.
    // The requiredReviewCount setting defaults to 1. `force: true` bypasses
    // the gate and is logged as a chair override.
    const aggregate = await computeSubmissionAggregates(abstractId);
    const requiredCount = readRequiredReviewCount(abstract.event.settings);
    const gateRelevant = status === "ACCEPTED" || status === "REJECTED";
    if (gateRelevant && !force && aggregate.aggregates.count < requiredCount) {
      apiLogger.warn(
        { abstractId, currentCount: aggregate.aggregates.count, required: requiredCount },
        "abstract-status:insufficient-reviews",
      );
      return {
        error: `This event requires ${requiredCount} review submission(s) before ${status}. Current: ${aggregate.aggregates.count}.`,
        code: "INSUFFICIENT_REVIEWS",
        currentCount: aggregate.aggregates.count,
        required: requiredCount,
        suggestion: "Assign + collect more reviews, or pass force=true to override (logged as chair override).",
      };
    }

    const previousStatus = abstract.status;

    // DB update is the authoritative state change — succeed or fail loudly here.
    const updated = await db.abstract.update({
      where: { id: abstractId },
      data: {
        status: status as never,
        reviewedAt: new Date(),
      },
      select: { id: true, title: true, status: true },
    });

    apiLogger.info(
      { abstractId, previousStatus, newStatus: status, force, reviewCount: aggregate.aggregates.count },
      "abstract-status:changed",
    );

    await db.auditLog.create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "REVIEW",
        entityType: "Abstract",
        entityId: abstract.id,
        changes: {
          before: { status: previousStatus },
          after: { status },
          source: force ? "chair-override" : "mcp",
          reviewCount: aggregate.aggregates.count,
          meanOverall: aggregate.aggregates.meanOverall,
        },
      },
    }).catch((err) =>
      apiLogger.error({ err, abstractId }, "agent:update_abstract_status audit-log-failed"),
    );

    // Aggregate consolidated notes from all reviewers for the speaker email.
    const consolidatedNotes = consolidateReviewNotes(aggregate.submissions);

    // Notification is isolated: a failing email send must not mask the
    // successful DB update. Surface notificationStatus in the return payload
    // so callers (Claude, dashboards) know whether to follow up manually.
    let notificationStatus: "sent" | "failed" = "sent";
    let notificationError: string | undefined;
    try {
      await notifyAbstractStatusChange({
        eventId: ctx.eventId,
        eventName: abstract.event.name,
        eventSlug: abstract.event.slug,
        abstractId: abstract.id,
        abstractTitle: abstract.title,
        previousStatus,
        newStatus: status,
        reviewNotes: consolidatedNotes,
        reviewScore: aggregate.aggregates.meanOverall,
        speaker: {
          email: abstract.speaker?.email ?? null,
          firstName: abstract.speaker?.firstName ?? "",
          lastName: abstract.speaker?.lastName ?? "",
        },
      });
    } catch (notifyErr) {
      apiLogger.error(
        { err: notifyErr, abstractId },
        "abstract-status:notification-failed",
      );
      notificationStatus = "failed";
      notificationError = notifyErr instanceof Error ? notifyErr.message : "Unknown notification error";
    }

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(ctx.eventId);

    return {
      abstract: updated,
      previousStatus,
      reviewCount: aggregate.aggregates.count,
      meanOverallScore: aggregate.aggregates.meanOverall,
      forcedOverride: force,
      notificationStatus,
      ...(notificationError && { notificationError }),
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:update_abstract_status failed");
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      error: "Failed to update abstract status",
      code: "UNKNOWN",
      details: message,
    };
  }
};

// ─── Sprint B: Reviewer assignment + per-reviewer submissions ─────────────────


const ABSTRACT_REVIEWER_ROLES = new Set(["PRIMARY", "SECONDARY", "CONSULTING"]);
const RECOMMENDED_FORMATS = new Set(["ORAL", "POSTER", "NEITHER"]);


/**
 * Load the event's reviewer pool + review criteria together so
 * `submit_abstract_review` can (a) check the user is a reviewer and (b)
 * auto-compute overallScore from criteriaScores using the same weight
 * calculation as the REST route.
 */
async function loadReviewerGuardAndCriteria(eventId: string) {
  return db.event.findFirst({
    where: { id: eventId },
    select: {
      settings: true,
      reviewCriteria: { select: { id: true, weight: true } },
    },
  });
}

const assignReviewerToAbstract: ToolExecutor = async (input, ctx) => {
  try {
    const abstractId = String(input.abstractId ?? "").trim();
    const userId = String(input.userId ?? "").trim();
    const role = input.role ? String(input.role) : "SECONDARY";
    if (!abstractId) return { error: "abstractId is required", code: "MISSING_ABSTRACT_ID" };
    if (!userId) return { error: "userId is required", code: "MISSING_USER_ID" };
    if (!ABSTRACT_REVIEWER_ROLES.has(role)) {
      return {
        error: `Invalid role. Must be one of: ${[...ABSTRACT_REVIEWER_ROLES].join(", ")}`,
        code: "INVALID_ROLE",
      };
    }

    const [abstract, user] = await Promise.all([
      db.abstract.findFirst({
        where: { id: abstractId, eventId: ctx.eventId },
        select: { id: true, event: { select: { id: true, settings: true } } },
      }),
      db.user.findUnique({ where: { id: userId }, select: { id: true, firstName: true, lastName: true, email: true } }),
    ]);
    if (!abstract) return { error: `Abstract ${abstractId} not found`, code: "ABSTRACT_NOT_FOUND" };
    if (!user) return { error: `User ${userId} not found`, code: "USER_NOT_FOUND" };

    const existing = await db.abstractReviewer.findUnique({
      where: { abstractId_userId: { abstractId, userId } },
      select: { id: true, role: true },
    });
    if (existing) {
      return {
        alreadyAssigned: true,
        existingAssignmentId: existing.id,
        currentRole: existing.role,
        message: `${user.firstName} ${user.lastName} is already assigned to this abstract as ${existing.role}`,
      };
    }

    const assignment = await db.abstractReviewer.create({
      data: {
        abstractId,
        userId,
        assignedById: ctx.userId,
        role: role as never,
      },
      select: { id: true, role: true, assignedAt: true },
    });

    apiLogger.info({ abstractId, userId, role }, "abstract-reviewer:assigned");

    db.auditLog.create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "ASSIGN",
        entityType: "AbstractReviewer",
        entityId: assignment.id,
        changes: { source: "mcp", abstractId, reviewerUserId: userId, role },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:assign_reviewer_to_abstract audit-log-failed"));

    return {
      success: true,
      assignment: {
        ...assignment,
        reviewer: { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email },
      },
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:assign_reviewer_to_abstract failed");
    return {
      error: "Failed to assign reviewer",
      code: "UNKNOWN",
      details: err instanceof Error ? err.message : "Unknown error",
    };
  }
};

const unassignReviewerFromAbstract: ToolExecutor = async (input, ctx) => {
  try {
    const abstractId = String(input.abstractId ?? "").trim();
    const userId = String(input.userId ?? "").trim();
    if (!abstractId) return { error: "abstractId is required", code: "MISSING_ABSTRACT_ID" };
    if (!userId) return { error: "userId is required", code: "MISSING_USER_ID" };

    // Verify abstract belongs to this org scope
    const abstract = await db.abstract.findFirst({
      where: { id: abstractId, eventId: ctx.eventId },
      select: { id: true },
    });
    if (!abstract) return { error: `Abstract ${abstractId} not found`, code: "ABSTRACT_NOT_FOUND" };

    const assignment = await db.abstractReviewer.findUnique({
      where: { abstractId_userId: { abstractId, userId } },
      select: { id: true },
    });
    if (!assignment) {
      return {
        error: `No assignment found for user ${userId} on abstract ${abstractId}`,
        code: "ASSIGNMENT_NOT_FOUND",
      };
    }

    // Deletes the AbstractReviewer row. Any existing AbstractReviewSubmission
    // from this user gets `abstractReviewerId` nulled via SET NULL FK — the
    // submission itself is preserved (it has independent value).
    await db.abstractReviewer.delete({ where: { id: assignment.id } });

    apiLogger.info({ abstractId, userId }, "abstract-reviewer:unassigned");

    db.auditLog.create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "UNASSIGN",
        entityType: "AbstractReviewer",
        entityId: assignment.id,
        changes: { source: "mcp", abstractId, reviewerUserId: userId },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:unassign_reviewer_from_abstract audit-log-failed"));

    return {
      success: true,
      unassignedAssignmentId: assignment.id,
      note: "Assignment removed. Any submission this reviewer made is preserved.",
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:unassign_reviewer_from_abstract failed");
    return {
      error: "Failed to unassign reviewer",
      code: "UNKNOWN",
      details: err instanceof Error ? err.message : "Unknown error",
    };
  }
};

const submitAbstractReview: ToolExecutor = async (input, ctx) => {
  try {
    const abstractId = String(input.abstractId ?? "").trim();
    if (!abstractId) return { error: "abstractId is required", code: "MISSING_ABSTRACT_ID" };

    // API-key / OAuth callers (ctx.userId = SYSTEM_USER_ID "mcp-remote") don't
    // have a real user identity, so they can't be "the reviewer who scored
    // this abstract" — the submission would get attributed to a sentinel.
    // Reject early with a clear error; if you need bulk review ingestion
    // from external systems, the right shape is a separate org-admin-only
    // tool that takes an explicit reviewerUserId. For now, require a real
    // user session (OAuth with per-user grant, or dashboard/in-app agent).
    if (ctx.userId === "mcp-remote") {
      return {
        error:
          "submit_abstract_review requires an authenticated user session. " +
          "It cannot be called via API-key MCP (no user identity to attribute the review to). " +
          "Use the dashboard's /my-reviews portal, the in-app AI agent, or OAuth-based MCP with a per-user grant.",
        code: "MCP_API_KEY_NOT_SUPPORTED",
      };
    }

    // Abstract must exist + belong to this org scope
    const abstract = await db.abstract.findFirst({
      where: { id: abstractId, eventId: ctx.eventId },
      select: { id: true },
    });
    if (!abstract) return { error: `Abstract ${abstractId} not found`, code: "ABSTRACT_NOT_FOUND" };

    // Reviewer auth: the submitting user (ctx.userId) must be EITHER in the
    // event's reviewer pool OR have an explicit AbstractReviewer row.
    const [eventData, existingAssignment] = await Promise.all([
      loadReviewerGuardAndCriteria(ctx.eventId),
      db.abstractReviewer.findUnique({
        where: { abstractId_userId: { abstractId, userId: ctx.userId } },
        select: { id: true },
      }),
    ]);
    const reviewerUserIds = (eventData?.settings as { reviewerUserIds?: string[] } | null)?.reviewerUserIds ?? [];
    const isEventReviewer = reviewerUserIds.includes(ctx.userId);
    if (!isEventReviewer && !existingAssignment) {
      return {
        error: `User ${ctx.userId} is not a reviewer for this event. Assign them to the abstract or add to event.settings.reviewerUserIds first.`,
        code: "NOT_A_REVIEWER",
      };
    }

    // Parse + validate inputs
    const overallScoreInput = input.overallScore != null ? Number(input.overallScore) : undefined;
    if (overallScoreInput !== undefined && (overallScoreInput < 0 || overallScoreInput > 100)) {
      return { error: "overallScore must be between 0 and 100", code: "INVALID_OVERALL_SCORE" };
    }

    const confidence = input.confidence != null ? Number(input.confidence) : undefined;
    if (confidence !== undefined && (confidence < 1 || confidence > 5)) {
      return { error: "confidence must be between 1 and 5", code: "INVALID_CONFIDENCE" };
    }

    const recommendedFormat = input.recommendedFormat ? String(input.recommendedFormat) : undefined;
    if (recommendedFormat && !RECOMMENDED_FORMATS.has(recommendedFormat)) {
      return {
        error: `Invalid recommendedFormat. Must be one of: ${[...RECOMMENDED_FORMATS].join(", ")}`,
        code: "INVALID_RECOMMENDED_FORMAT",
      };
    }

    const reviewNotes = input.reviewNotes ? String(input.reviewNotes).slice(0, 5000) : null;

    const criteriaScoresInput = input.criteriaScores && typeof input.criteriaScores === "object"
      ? (input.criteriaScores as Record<string, unknown>)
      : null;

    // Validate criteria IDs against the event's criteria so callers can't
    // submit scores for criteria that don't exist here.
    let criteriaScoresJson: Record<string, number> | null = null;
    let computedOverall: number | null = null;
    if (criteriaScoresInput) {
      const validIds = new Set((eventData?.reviewCriteria ?? []).map((c) => c.id));
      const weightMap = new Map((eventData?.reviewCriteria ?? []).map((c) => [c.id, c.weight]));
      const cleaned: Record<string, number> = {};
      for (const [id, raw] of Object.entries(criteriaScoresInput)) {
        if (!validIds.has(id)) {
          return { error: `Unknown criterion ID: ${id}`, code: "INVALID_CRITERION_ID" };
        }
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || n > 10) {
          return { error: `Score for criterion ${id} must be 0-10`, code: "INVALID_CRITERION_SCORE" };
        }
        cleaned[id] = n;
      }
      criteriaScoresJson = cleaned;
      // Auto-compute overallScore if the caller didn't set one explicitly
      if (overallScoreInput === undefined) {
        const items: CriterionScore[] = Object.entries(cleaned).map(([critId, score]) => ({
          criterionId: critId,
          score,
          weight: weightMap.get(critId) ?? 0,
        }));
        computedOverall = computeWeightedOverallScore(items);
      }
    }
    const overallScore = overallScoreInput ?? computedOverall;

    // Upsert on (abstractId, reviewerUserId). Link to the AbstractReviewer row
    // if one exists; otherwise leave abstractReviewerId null.
    const submission = await db.abstractReviewSubmission.upsert({
      where: { abstractId_reviewerUserId: { abstractId, reviewerUserId: ctx.userId } },
      create: {
        abstractId,
        reviewerUserId: ctx.userId,
        abstractReviewerId: existingAssignment?.id ?? null,
        criteriaScores: criteriaScoresJson ?? undefined,
        overallScore,
        reviewNotes,
        recommendedFormat: (recommendedFormat as never) ?? null,
        confidence: confidence ?? null,
      },
      update: {
        ...(criteriaScoresJson && { criteriaScores: criteriaScoresJson }),
        ...(overallScore !== null && overallScore !== undefined && { overallScore }),
        ...(reviewNotes !== null && { reviewNotes }),
        ...(recommendedFormat && { recommendedFormat: recommendedFormat as never }),
        ...(confidence !== undefined && { confidence }),
        // Re-link to the current assignment on every write so unassign/
        // re-assign cycles don't leave a stale (null) FK.
        abstractReviewerId: existingAssignment?.id ?? null,
      },
      select: {
        id: true,
        overallScore: true,
        reviewNotes: true,
        recommendedFormat: true,
        confidence: true,
        submittedAt: true,
        updatedAt: true,
      },
    });

    const wasCreate = submission.submittedAt.getTime() === submission.updatedAt.getTime();
    apiLogger.info(
      { abstractId, reviewerUserId: ctx.userId, overallScore },
      wasCreate ? "abstract-submission:created" : "abstract-submission:updated",
    );

    db.auditLog.create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: wasCreate ? "CREATE" : "UPDATE",
        entityType: "AbstractReviewSubmission",
        entityId: submission.id,
        changes: { source: "mcp", abstractId, overallScore, hasCriteriaScores: !!criteriaScoresJson },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:submit_abstract_review audit-log-failed"));

    return { success: true, submission };
  } catch (err) {
    apiLogger.error({ err }, "agent:submit_abstract_review failed");
    return {
      error: "Failed to submit review",
      code: "UNKNOWN",
      details: err instanceof Error ? err.message : "Unknown error",
    };
  }
};

const getAbstractScores: ToolExecutor = async (input, ctx) => {
  try {
    const abstractId = String(input.abstractId ?? "").trim();
    if (!abstractId) return { error: "abstractId is required", code: "MISSING_ABSTRACT_ID" };

    const abstract = await db.abstract.findFirst({
      where: { id: abstractId, eventId: ctx.eventId },
      select: {
        id: true,
        title: true,
        status: true,
        event: { select: { settings: true } },
        reviewers: {
          select: {
            id: true,
            role: true,
            assignedAt: true,
            user: { select: { id: true, firstName: true, lastName: true, email: true } },
          },
        },
      },
    });
    if (!abstract) return { error: `Abstract ${abstractId} not found`, code: "ABSTRACT_NOT_FOUND" };

    const aggregate = await computeSubmissionAggregates(abstractId);
    const requiredCount = readRequiredReviewCount(abstract.event.settings);

    return {
      abstract: { id: abstract.id, title: abstract.title, status: abstract.status },
      assignedReviewers: abstract.reviewers.map((r) => ({
        assignmentId: r.id,
        role: r.role,
        assignedAt: r.assignedAt,
        user: r.user,
      })),
      submissions: aggregate.submissions,
      aggregates: aggregate.aggregates,
      requiredReviewCount: requiredCount,
      meetsThreshold: aggregate.aggregates.count >= requiredCount,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:get_abstract_scores failed");
    return { error: "Failed to fetch abstract scores", code: "UNKNOWN" };
  }
};

// ─── Accommodation Executors ──────────────────────────────────────────────────

const listReviewers: ToolExecutor = async (_input, ctx) => {
  try {
    const event = await db.event.findFirst({
      where: { id: ctx.eventId },
      select: { settings: true },
    });
    const reviewerUserIds = (event?.settings as { reviewerUserIds?: string[] })?.reviewerUserIds ?? [];
    if (reviewerUserIds.length === 0) return { reviewers: [], total: 0 };

    const users = await db.user.findMany({
      where: { id: { in: reviewerUserIds } },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    return { reviewers: users, total: users.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_reviewers failed");
    return { error: "Failed to fetch reviewers" };
  }
};

// ─── Invoice Executor ─────────────────────────────────────────────────────────

export const ABSTRACT_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "list_abstract_themes",
    description: "List abstract themes configured for this event.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "create_abstract_theme",
    description: "Create an abstract theme for this event.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Theme name" },
      },
      required: ["name"],
    },
  },
  {
    name: "list_review_criteria",
    description: "List review criteria configured for this event, including weights.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "create_review_criterion",
    description: "Create a review criterion for this event.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Criterion name (e.g. Originality, Methodology)" },
        weight: { type: "number", description: "Weight for scoring (e.g. 1, 2, 3). Higher = more important" },
      },
      required: ["name", "weight"],
    },
  },
  {
    name: "list_abstracts",
    description: "List abstract submissions for this event. Optionally filter by status or theme.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED", "WITHDRAWN"],
        },
        themeId: { type: "string", description: "Filter by abstract theme ID" },
        limit: { type: "number", description: "Max results (default 50, max 200)" },
      },
      required: [],
    },
  },
  {
    name: "update_abstract_status",
    description: "Update the status of an abstract submission (e.g. accept, reject, request revision).",
    input_schema: {
      type: "object" as const,
      properties: {
        abstractId: { type: "string", description: "Abstract ID" },
        status: {
          type: "string",
          enum: ["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"],
        },
        reviewNotes: { type: "string", description: "Optional notes for the author" },
      },
      required: ["abstractId", "status"],
    },
  },
  {
    name: "list_reviewers",
    description: "List reviewers assigned to this event.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
];

export const ABSTRACT_EXECUTORS: Record<string, ToolExecutor> = {
  list_abstract_themes: listAbstractThemes,
  create_abstract_theme: createAbstractTheme,
  list_review_criteria: listReviewCriteria,
  create_review_criterion: createReviewCriterion,
  list_abstracts: listAbstracts,
  update_abstract_status: updateAbstractStatus,
  list_reviewers: listReviewers,
  assign_reviewer_to_abstract: assignReviewerToAbstract,
  unassign_reviewer_from_abstract: unassignReviewerFromAbstract,
  submit_abstract_review: submitAbstractReview,
  get_abstract_scores: getAbstractScores,
};
