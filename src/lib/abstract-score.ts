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
 * Compute a weighted overall score (0-100) from per-criterion scores.
 *
 * Each criterion `score` is 0-10 and each `weight` 1-100. The weighted average
 * divides by the weights actually present: the review-criteria route checks
 * each weight, not that they total 100, and two criteria at weight 10 would
 * otherwise store a perfect review as 20/100. We multiply by 10 to project onto
 * the 0-100 `overallScore` scale.
 *
 * Returns `null` if input is empty, weightless or non-finite.
 */
export function computeWeightedOverallScore(scores: Array<WeightedCriterionScore>): number | null {
  if (!scores.length) return null;
  const totalWeight = scores.reduce((sum, c) => sum + c.weight, 0);
  if (totalWeight <= 0) return null;
  const weightedOnTen = scores.reduce((sum, c) => sum + c.score * c.weight, 0) / totalWeight;
  if (!Number.isFinite(weightedOnTen) || weightedOnTen < 0) return null;
  const scaledTo100 = weightedOnTen * 10;
  return Math.max(0, Math.min(100, Math.round(scaledTo100)));
}
