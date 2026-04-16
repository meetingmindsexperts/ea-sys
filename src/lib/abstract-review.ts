import { db } from "./db";

/**
 * Helpers for abstract review aggregation + gate-checking.
 *
 * The review data model: `Abstract` no longer carries review fields directly.
 * Each reviewer submits a row in `AbstractReviewSubmission`. Aggregates (mean,
 * median, range, per-criterion) are computed on-demand from those rows.
 *
 * Used by:
 *   - Dashboard abstract detail + list (display aggregates)
 *   - PUT /abstracts/[id] status transitions (gate on requiredReviewCount)
 *   - MCP get_abstract_scores tool
 *   - Abstract status change email (populates {{reviewNotes}} + {{reviewScore}})
 */

export const DEFAULT_REQUIRED_REVIEW_COUNT = 1;

export interface CriterionScore {
  criterionId: string;
  score: number;
  weight: number;
}

/**
 * Compute a weighted overall score (0-100) from per-criterion scores.
 *
 * Scale convention (Sprint B):
 *   - Each criterion `score` is 0-10 (enforced by the submission Zod schema).
 *   - Each criterion `weight` is 1-100 and should sum to 100 across the
 *     event's criteria (enforced by the review-criteria route schema).
 *
 * Weighted average on the 0-10 scale = Σ(score × weight) / 100. We multiply
 * by 10 to project onto the 0-100 `overallScore` scale so reviewers who omit
 * `overallScore` still get a meaningful integer.
 *
 * Returns `null` if input is empty or non-finite.
 */
export function computeWeightedOverallScore(
  scores: Array<CriterionScore>,
): number | null {
  if (!scores.length) return null;
  const weightedOnTen = scores.reduce(
    (sum, c) => sum + (c.score * c.weight) / 100,
    0,
  );
  if (!Number.isFinite(weightedOnTen) || weightedOnTen < 0) return null;
  const scaledTo100 = weightedOnTen * 10;
  return Math.max(0, Math.min(100, Math.round(scaledTo100)));
}

/**
 * Read an event's `requiredReviewCount` from settings JSON, falling back to the
 * default. Enforced at the application layer on ACCEPTED / REJECTED transitions.
 */
export function readRequiredReviewCount(settings: unknown): number {
  if (!settings || typeof settings !== "object") return DEFAULT_REQUIRED_REVIEW_COUNT;
  const raw = (settings as Record<string, unknown>).requiredReviewCount;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return DEFAULT_REQUIRED_REVIEW_COUNT;
}

export interface SubmissionAggregates {
  count: number;
  meanOverall: number | null;
  medianOverall: number | null;
  minOverall: number | null;
  maxOverall: number | null;
  /** Per-criterion stats keyed by criterionId */
  perCriterion: Record<string, { count: number; mean: number; min: number; max: number }>;
}

export interface SubmissionSummary {
  id: string;
  reviewerUserId: string;
  reviewerName: string;
  overallScore: number | null;
  reviewNotes: string | null;
  recommendedFormat: string | null;
  confidence: number | null;
  submittedAt: Date;
  updatedAt: Date;
  criteriaScores: Record<string, number> | null;
}

export interface AggregateResult {
  submissions: SubmissionSummary[];
  aggregates: SubmissionAggregates;
}

/**
 * Load all submissions for an abstract and compute aggregates.
 *
 * Used by the chair view, the MCP `get_abstract_scores` tool, and the PUT
 * status-transition gate. Accepts an optional Prisma transaction client so
 * callers inside `db.$transaction` can use a consistent read.
 */
export async function computeSubmissionAggregates(
  abstractId: string,
  tx?: Parameters<Parameters<typeof db.$transaction>[0]>[0],
): Promise<AggregateResult> {
  const client = tx ?? db;
  const rows = await client.abstractReviewSubmission.findMany({
    where: { abstractId },
    select: {
      id: true,
      reviewerUserId: true,
      overallScore: true,
      reviewNotes: true,
      recommendedFormat: true,
      confidence: true,
      criteriaScores: true,
      submittedAt: true,
      updatedAt: true,
      reviewer: { select: { firstName: true, lastName: true } },
    },
    orderBy: { submittedAt: "asc" },
  });

  const submissions: SubmissionSummary[] = rows.map((r) => ({
    id: r.id,
    reviewerUserId: r.reviewerUserId,
    reviewerName: `${r.reviewer.firstName} ${r.reviewer.lastName}`.trim() || r.reviewerUserId,
    overallScore: r.overallScore,
    reviewNotes: r.reviewNotes,
    recommendedFormat: r.recommendedFormat,
    confidence: r.confidence,
    submittedAt: r.submittedAt,
    updatedAt: r.updatedAt,
    criteriaScores: (r.criteriaScores as Record<string, number> | null) ?? null,
  }));

  const overalls = submissions
    .map((s) => s.overallScore)
    .filter((s): s is number => s != null);

  // Per-criterion aggregation — collect all numeric scores under each criterionId
  const perCriterionBuckets: Record<string, number[]> = {};
  for (const s of submissions) {
    if (!s.criteriaScores) continue;
    for (const [critId, score] of Object.entries(s.criteriaScores)) {
      if (typeof score !== "number" || !Number.isFinite(score)) continue;
      if (!perCriterionBuckets[critId]) perCriterionBuckets[critId] = [];
      perCriterionBuckets[critId].push(score);
    }
  }
  const perCriterion: SubmissionAggregates["perCriterion"] = {};
  for (const [critId, values] of Object.entries(perCriterionBuckets)) {
    perCriterion[critId] = {
      count: values.length,
      mean: mean(values),
      min: Math.min(...values),
      max: Math.max(...values),
    };
  }

  return {
    submissions,
    aggregates: {
      count: submissions.length,
      meanOverall: overalls.length ? roundHalf(mean(overalls)) : null,
      medianOverall: overalls.length ? roundHalf(median(overalls)) : null,
      minOverall: overalls.length ? Math.min(...overalls) : null,
      maxOverall: overalls.length ? Math.max(...overalls) : null,
      perCriterion,
    },
  };
}

/**
 * Collapse multiple reviewer notes into a single human-readable block for the
 * `{{reviewNotes}}` email template variable. Preserves attribution so the
 * speaker can see whose feedback is whose.
 */
export function consolidateReviewNotes(submissions: SubmissionSummary[]): string | null {
  const withNotes = submissions.filter((s) => s.reviewNotes?.trim());
  if (!withNotes.length) return null;
  if (withNotes.length === 1) return withNotes[0].reviewNotes;
  return withNotes
    .map((s) => `— ${s.reviewerName}:\n${s.reviewNotes}`)
    .join("\n\n");
}

// ── tiny stats helpers ─────────────────────────────────────────────────────

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function roundHalf(v: number): number {
  return Math.round(v * 10) / 10;
}
