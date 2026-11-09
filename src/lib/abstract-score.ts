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
export function computeWeightedOverallScore(scores: Array<WeightedCriterionScore>): number | null {
  if (!scores.length) return null;
  const weightedOnTen = scores.reduce((sum, c) => sum + (c.score * c.weight) / 100, 0);
  if (!Number.isFinite(weightedOnTen) || weightedOnTen < 0) return null;
  const scaledTo100 = weightedOnTen * 10;
  return Math.max(0, Math.min(100, Math.round(scaledTo100)));
}
