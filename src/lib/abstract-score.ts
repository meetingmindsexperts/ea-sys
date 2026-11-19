/**
 * The review score sum, on its own so the review form can show the same number
 * the server will store (abstract-review.ts imports the database, which a
 * client component cannot).
 */
export interface WeightedCriterionScore {
  score: number;
  weight: number;
}

/**
 * THE scale a reviewer scores each criterion on (Nov 19, 2026): 0 to 5, 0 to 10
 * or 0 to 100, chosen per event by the organiser (`Event.settings.reviewScoreScale`,
 * Settings, Abstracts). It was fixed at 10 until then, and 10 is what an event
 * with no choice saved still uses.
 *
 * Only the criterion scores are on this scale. The overall score is always
 * projected onto 0 to 100 (computeWeightedOverallScore), so the calculation, the
 * averages and every stored `overallScore` mean the same whatever the scale.
 *
 * The scale is FIXED once the first review is submitted on the event
 * (owner): stored criterion scores are raw numbers on the scale they were given
 * on, and nothing converts them. The one writer is PUT review-criteria/scale.
 * **Never write a criterion-score range (`max(10)`, "0-10") anywhere else**:
 * read it here.
 */
export const REVIEW_SCORE_SCALES = [5, 10, 100] as const;
export type ReviewScoreScale = (typeof REVIEW_SCORE_SCALES)[number];
export const DEFAULT_REVIEW_SCORE_SCALE: ReviewScoreScale = 10;
/** The largest criterion score any scale allows: what a schema may check before the event is known. */
export const MAX_REVIEW_SCORE_SCALE = 100;

export function isReviewScoreScale(value: unknown): value is ReviewScoreScale {
  return (REVIEW_SCORE_SCALES as readonly unknown[]).includes(value);
}

/** The event's criterion scale, from its `settings` JSON; 10 when none is saved or the value is not one of ours. */
export function readReviewScoreScale(settings: unknown): ReviewScoreScale {
  const raw = (settings as { reviewScoreScale?: unknown } | null | undefined)?.reviewScoreScale;
  return isReviewScoreScale(raw) ? raw : DEFAULT_REVIEW_SCORE_SCALE;
}

/**
 * Compute a weighted overall score (0-100) from per-criterion scores.
 *
 * Each criterion `score` is 0 to `scale` and each `weight` 1-100. The weighted
 * average divides by the weights actually present: the review-criteria route
 * checks each weight, not that they total 100, and two criteria at weight 10
 * would otherwise store a perfect review as 20/100. The average is then
 * projected from the event's scale onto the 0-100 `overallScore` scale.
 *
 * Returns `null` if input is empty, weightless or non-finite.
 */
export function computeWeightedOverallScore(
  scores: Array<WeightedCriterionScore>,
  scale: ReviewScoreScale = DEFAULT_REVIEW_SCORE_SCALE,
): number | null {
  if (!scores.length) return null;
  const totalWeight = scores.reduce((sum, c) => sum + c.weight, 0);
  if (totalWeight <= 0) return null;
  const weightedOnScale = scores.reduce((sum, c) => sum + c.score * c.weight, 0) / totalWeight;
  if (!Number.isFinite(weightedOnScale) || weightedOnScale < 0) return null;
  const scaledTo100 = (weightedOnScale / scale) * 100;
  return Math.max(0, Math.min(100, Math.round(scaledTo100)));
}
