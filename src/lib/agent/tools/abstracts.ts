import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { AbstractStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { abstractListStatusFilter } from "@/lib/abstract-draft-visibility";
import {
  computeSubmissionAggregates,
  meanOverallScore,
  readRequiredReviewCount,
} from "@/lib/abstract-review";
import {
  assignReviewer as assignReviewerService,
  changeAbstractStatus,
  submitAbstractReview,
  unassignReviewer as unassignReviewerService,
  type AbstractTransitionStatus,
} from "@/services/abstract-service";
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
    // Weights are meant to sum to 100 across the event's criteria — match
    // the REST route's 1–100 range (was wrongly capped at 10 here).
    if (!Number.isInteger(weight) || weight < 1 || weight > 100) {
      return { error: "weight must be an integer between 1 and 100" };
    }

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

const updateReviewCriterion: ToolExecutor = async (input, ctx) => {
  try {
    const criterionId = String(input.criterionId ?? "").trim();
    if (!criterionId) return { error: "criterionId is required" };

    const existing = await db.reviewCriterion.findFirst({
      where: { id: criterionId, eventId: ctx.eventId },
      select: { id: true },
    });
    if (!existing) return { error: `Review criterion ${criterionId} not found in this event` };

    const data: { name?: string; weight?: number; sortOrder?: number } = {};
    if (input.name != null) {
      const name = String(input.name).trim();
      if (!name) return { error: "name cannot be empty" };
      data.name = name.slice(0, 200);
    }
    if (input.weight != null) {
      const weight = Number(input.weight);
      if (!Number.isInteger(weight) || weight < 1 || weight > 100) {
        return { error: "weight must be an integer between 1 and 100" };
      }
      data.weight = weight;
    }
    if (input.sortOrder != null) {
      const sortOrder = Number(input.sortOrder);
      if (!Number.isInteger(sortOrder) || sortOrder < 0) {
        return { error: "sortOrder must be a non-negative integer" };
      }
      data.sortOrder = sortOrder;
    }
    if (Object.keys(data).length === 0) {
      return { error: "Provide at least one of name, weight, sortOrder" };
    }

    const criterion = await db.reviewCriterion.update({
      where: { id: criterionId },
      data,
      select: { id: true, name: true, weight: true, sortOrder: true },
    });
    return { success: true, criterion };
  } catch (err) {
    apiLogger.error({ err }, "agent:update_review_criterion failed");
    return { error: "Failed to update review criterion" };
  }
};

const deleteReviewCriterion: ToolExecutor = async (input, ctx) => {
  try {
    const criterionId = String(input.criterionId ?? "").trim();
    if (!criterionId) return { error: "criterionId is required" };

    const existing = await db.reviewCriterion.findFirst({
      where: { id: criterionId, eventId: ctx.eventId },
      select: { id: true },
    });
    if (!existing) return { error: `Review criterion ${criterionId} not found in this event` };

    await db.reviewCriterion.delete({ where: { id: criterionId } });
    return { success: true };
  } catch (err) {
    apiLogger.error({ err }, "agent:delete_review_criterion failed");
    return { error: "Failed to delete review criterion" };
  }
};

const listAbstracts: ToolExecutor = async (input, ctx) => {
  try {
    const limit = Math.min(Number(input.limit ?? 50), 200);
    const statusValue = input.status ? String(input.status) : undefined;
    if (statusValue && !ABSTRACT_STATUSES.has(statusValue)) {
      return { error: `Invalid status. Must be one of: ${[...ABSTRACT_STATUSES].join(", ")}` };
    }
    // DRAFT is the submitter's private work-in-progress. The MCP surface is
    // org-facing (API key / agent) — never a submitter — so drafts are never
    // exposed here (an explicit status=DRAFT yields an empty set, not a leak).
    const statusFilter = abstractListStatusFilter({
      canSeeDrafts: false,
      requestedStatus: (statusValue as AbstractStatus | undefined) ?? null,
    });
    const abstracts = await db.abstract.findMany({
      where: {
        eventId: ctx.eventId,
        status: statusFilter as never,
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
      // Strip the submissions array — agent callers only want the rollup.
      const rest: Omit<typeof a, "submissions"> & { submissions?: typeof a.submissions } = { ...a };
      delete rest.submissions;
      return {
        ...rest,
        reviewCount: a.submissions.length,
        // Shared rounding — identical to the detail aggregate + REST list.
        meanOverallScore: meanOverallScore(a.submissions.map((s) => s.overallScore)),
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

    // Delegate to the service. It owns: terminal-state guard, required-review
    // gate, DB update, audit log, notification, stats refresh. MCP callers
    // are always admin-authorized (ctx.organizationId came from the API key
    // / OAuth token scope), so forceStatus is safe to forward as-is.
    const result = await changeAbstractStatus({
      eventId: ctx.eventId,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      abstractId,
      newStatus: status as AbstractTransitionStatus,
      forceStatus: force,
      source: "mcp",
    });

    if (!result.ok) {
      // Preserve the MCP-specific suggestion hints so Claude knows the
      // actionable next step instead of retrying the same call.
      if (result.code === "ABSTRACT_WITHDRAWN") {
        return {
          error: "Cannot update a withdrawn abstract",
          code: "ABSTRACT_WITHDRAWN",
          currentStatus: result.meta?.currentStatus,
          suggestion: "Withdrawn abstracts are terminal. The submitter must resubmit a new abstract.",
        };
      }
      if (result.code === "INSUFFICIENT_REVIEWS") {
        return {
          error: result.message,
          code: "INSUFFICIENT_REVIEWS",
          currentCount: result.meta?.currentCount,
          required: result.meta?.required,
          suggestion: "Assign + collect more reviews, or pass force=true to override (logged as chair override).",
        };
      }
      return { error: result.message, code: result.code, ...(result.meta ?? {}) };
    }

    return {
      abstract: result.abstract,
      previousStatus: result.previousStatus,
      reviewCount: result.reviewCount,
      meanOverallScore: result.meanOverallScore,
      forcedOverride: result.forcedOverride,
      notificationStatus: result.notificationStatus,
      ...(result.notificationError && { notificationError: result.notificationError }),
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

// Thin MCP wrappers — the assignment domain logic (H6 reviewable-status gate,
// upsert role/COI semantics incl. the H8 conflictFlag fix, audit, reviewer
// notification) lives in abstract-service.assignReviewer / unassignReviewer,
// shared with the REST reviewers routes (duplication-audit finding 3: the two
// surfaces used to carry ~130 mirrored lines that drifted twice). This
// boundary keeps loose-input parsing + the MCP response/message shapes.
const assignReviewerToAbstract: ToolExecutor = async (input, ctx) => {
  try {
    const abstractId = String(input.abstractId ?? "").trim();
    const userId = String(input.userId ?? "").trim();
    if (!abstractId) return { error: "abstractId is required", code: "MISSING_ABSTRACT_ID" };
    if (!userId) return { error: "userId is required", code: "MISSING_USER_ID" };
    if (input.role !== undefined && !ABSTRACT_REVIEWER_ROLES.has(String(input.role))) {
      return {
        error: `Invalid role. Must be one of: ${[...ABSTRACT_REVIEWER_ROLES].join(", ")}`,
        code: "INVALID_ROLE",
      };
    }

    const result = await assignReviewerService({
      eventId: ctx.eventId,
      organizationId: ctx.organizationId,
      abstractId,
      reviewerUserId: userId,
      role: input.role !== undefined ? (String(input.role) as "PRIMARY" | "SECONDARY" | "CONSULTING") : undefined,
      conflictFlag: input.conflictFlag === undefined ? undefined : input.conflictFlag === true,
      actorUserId: ctx.userId,
      source: "mcp",
    });

    if (!result.ok) {
      const message =
        result.code === "ABSTRACT_NOT_FOUND" ? `Abstract ${abstractId} not found`
        : result.code === "USER_NOT_FOUND" ? `User ${userId} not found`
        : result.message;
      return { error: message, code: result.code };
    }

    const { assignment, reviewer } = result;
    if (result.kind === "noop") {
      return {
        alreadyAssigned: true,
        existingAssignmentId: assignment.id,
        currentRole: assignment.role,
        conflictFlag: assignment.conflictFlag,
        message: `${reviewer.firstName} ${reviewer.lastName} is already assigned to this abstract as ${assignment.role}${assignment.conflictFlag ? " (conflict flagged)" : ""}`,
      };
    }
    return {
      success: true,
      ...(result.kind === "updated" ? { updated: true } : {}),
      assignment: { ...assignment, reviewer },
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

    const result = await unassignReviewerService({
      eventId: ctx.eventId,
      organizationId: ctx.organizationId,
      abstractId,
      reviewerUserId: userId,
      actorUserId: ctx.userId,
      source: "mcp",
    });

    if (!result.ok) {
      const message =
        result.code === "ABSTRACT_NOT_FOUND" ? `Abstract ${abstractId} not found`
        : result.code === "ASSIGNMENT_NOT_FOUND" ? `No assignment found for user ${userId} on abstract ${abstractId}`
        : result.message;
      return { error: message, code: result.code };
    }

    return {
      success: true,
      unassignedAssignmentId: result.unassignedAssignmentId,
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

// Thin MCP wrapper — the review-submission domain logic (auth matrix, H6
// reviewable-status + COI + empty-payload gates, criteria validation, upsert,
// audit) lives in abstract-service.submitAbstractReview (review H7: this
// executor, its on-behalf sibling, and the REST route used to carry three
// drifting ~120-line copies). The boundary keeps MCP identity rules + input
// parsing; note two unified semantics changes vs the old copy: scores must be
// INTEGERS, and reviewNotes: "" now CLEARS the notes (absent still keeps them).
const submitAbstractReviewTool: ToolExecutor = async (input, ctx) => {
  try {
    const abstractId = String(input.abstractId ?? "").trim();
    if (!abstractId) return { error: "abstractId is required", code: "MISSING_ABSTRACT_ID" };

    // API-key / OAuth callers (ctx.userId = SYSTEM_USER_ID "mcp-remote") don't
    // have a real user identity, so they can't be "the reviewer who scored
    // this abstract" — the submission would get attributed to a sentinel.
    // Reject early with a clear error; bulk/external ingestion should use
    // admin_submit_review_on_behalf with an explicit reviewerUserId.
    if (ctx.userId === "mcp-remote") {
      return {
        error:
          "submit_abstract_review requires an authenticated user session. " +
          "It cannot be called via API-key MCP (no user identity to attribute the review to). " +
          "Use the dashboard's /my-reviews portal, the in-app AI agent, or OAuth-based MCP with a per-user grant.",
        code: "MCP_API_KEY_NOT_SUPPORTED",
      };
    }

    const result = await submitAbstractReview({
      eventId: ctx.eventId,
      abstractId,
      reviewerUserId: ctx.userId,
      // No session role on AgentContext — the org-admin self-submit bypass is
      // deliberately unavailable via MCP (unchanged from the old copy).
      actor: { userId: ctx.userId },
      ...parseReviewFields(input),
      source: "mcp",
    });
    if (!result.ok) return { error: result.message, code: result.code };
    return { success: true, submission: result.submission };
  } catch (err) {
    apiLogger.error({ err }, "agent:submit_abstract_review failed");
    return {
      error: "Failed to submit review",
      code: "UNKNOWN",
      details: err instanceof Error ? err.message : "Unknown error",
    };
  }
};

/** Parse the loosely-typed MCP review fields into the service's typed input. */
function parseReviewFields(input: Record<string, unknown>): {
  overallScore?: number;
  criteriaScores?: Array<{ criterionId: string; score: number }>;
  reviewNotes?: string;
  recommendedFormat?: string;
  confidence?: number;
} {
  const criteriaScoresInput =
    input.criteriaScores && typeof input.criteriaScores === "object"
      ? (input.criteriaScores as Record<string, unknown>)
      : null;
  return {
    ...(input.overallScore != null && { overallScore: Number(input.overallScore) }),
    ...(criteriaScoresInput && {
      criteriaScores: Object.entries(criteriaScoresInput).map(([criterionId, raw]) => ({
        criterionId,
        score: Number(raw),
      })),
    }),
    // null/undefined = keep existing notes; "" = clear them (unified REST semantics).
    ...(input.reviewNotes != null && { reviewNotes: String(input.reviewNotes) }),
    ...(input.recommendedFormat != null && input.recommendedFormat !== "" && { recommendedFormat: String(input.recommendedFormat) }),
    ...(input.confidence != null && { confidence: Number(input.confidence) }),
  };
}

// Org-admin-only sibling of submit_abstract_review. Takes an explicit
// reviewerUserId so API-key / OAuth-less callers can record a submission
// attributed to a specific human. Same shared service; the on-behalf path
// requires the TARGET reviewer to be pool/assigned (no admin bypass) and the
// audit row flags source "mcp-on-behalf-of".
const adminSubmitReviewOnBehalf: ToolExecutor = async (input, ctx) => {
  try {
    const abstractId = String(input.abstractId ?? "").trim();
    const reviewerUserId = String(input.reviewerUserId ?? "").trim();
    if (!abstractId) return { error: "abstractId is required", code: "MISSING_ABSTRACT_ID" };
    if (!reviewerUserId) return { error: "reviewerUserId is required", code: "MISSING_REVIEWER_USER_ID" };

    const result = await submitAbstractReview({
      eventId: ctx.eventId,
      abstractId,
      reviewerUserId,
      actor: { userId: ctx.userId },
      ...parseReviewFields(input),
      source: "mcp",
    });
    if (!result.ok) return { error: result.message, code: result.code };
    return {
      success: true,
      submission: result.submission,
      onBehalfOf: {
        userId: reviewerUserId,
        name: `${result.reviewer?.firstName ?? ""} ${result.reviewer?.lastName ?? ""}`.trim(),
        email: result.reviewer?.email ?? null,
      },
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:admin_submit_review_on_behalf failed");
    return {
      error: "Failed to submit review on behalf",
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
      // Match the real decision gate (review H5): SCORED submissions, not
      // total rows — an all-null review no longer looks like it meets the bar.
      meetsThreshold: aggregate.aggregates.scoredCount >= requiredCount,
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
        weight: { type: "number", description: "Integer weight 1–100 for scoring; weights are meant to sum to 100 across the event's criteria. Higher = more important." },
      },
      required: ["name", "weight"],
    },
  },
  {
    name: "update_review_criterion",
    description: "Update a review criterion (name, weight, and/or sortOrder). Provide at least one field to change.",
    input_schema: {
      type: "object" as const,
      properties: {
        criterionId: { type: "string", description: "ID of the criterion to update" },
        name: { type: "string" },
        weight: { type: "number", description: "Integer weight 1–100 (weights are meant to sum to 100 across criteria)" },
        sortOrder: { type: "number", description: "Display order (non-negative integer)" },
      },
      required: ["criterionId"],
    },
  },
  {
    name: "delete_review_criterion",
    description: "Delete a review criterion from this event.",
    input_schema: {
      type: "object" as const,
      properties: {
        criterionId: { type: "string", description: "ID of the criterion to delete" },
      },
      required: ["criterionId"],
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
  update_review_criterion: updateReviewCriterion,
  delete_review_criterion: deleteReviewCriterion,
  list_abstracts: listAbstracts,
  update_abstract_status: updateAbstractStatus,
  list_reviewers: listReviewers,
  assign_reviewer_to_abstract: assignReviewerToAbstract,
  unassign_reviewer_from_abstract: unassignReviewerFromAbstract,
  submit_abstract_review: submitAbstractReviewTool,
  admin_submit_review_on_behalf: adminSubmitReviewOnBehalf,
  get_abstract_scores: getAbstractScores,
};
