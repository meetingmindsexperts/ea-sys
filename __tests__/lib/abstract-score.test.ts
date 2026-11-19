/**
 * The criterion scoring scale (Nov 19, 2026): 0 to 5, 10 or 100, chosen per
 * event. Only the criterion scores are on it; the overall score is always out
 * of 100, so the same judgement gives the same overall score on any scale.
 */
import { describe, it, expect } from "vitest";
import {
  computeWeightedOverallScore,
  DEFAULT_REVIEW_SCORE_SCALE,
  isReviewScoreScale,
  MAX_REVIEW_SCORE_SCALE,
  readReviewScoreScale,
  REVIEW_SCORE_SCALES,
} from "@/lib/abstract-score";

describe("readReviewScoreScale", () => {
  it("is the event's saved scale", () => {
    expect(readReviewScoreScale({ reviewScoreScale: 5 })).toBe(5);
    expect(readReviewScoreScale({ reviewScoreScale: 100 })).toBe(100);
  });

  it("is 10 for an event that never chose, and for anything that is not one of the scales", () => {
    expect(DEFAULT_REVIEW_SCORE_SCALE).toBe(10);
    for (const settings of [null, undefined, {}, "x", { reviewScoreScale: 7 }, { reviewScoreScale: "5" }, { reviewScoreScale: 0 }, { reviewScoreScale: null }]) {
      expect(readReviewScoreScale(settings)).toBe(10);
    }
  });

  it("offers 5, 10 and 100, and a schema may bound a score by the largest", () => {
    expect([...REVIEW_SCORE_SCALES]).toEqual([5, 10, 100]);
    expect(MAX_REVIEW_SCORE_SCALE).toBe(Math.max(...REVIEW_SCORE_SCALES));
    expect(isReviewScoreScale(10)).toBe(true);
    expect(isReviewScoreScale(50)).toBe(false);
  });
});

describe("computeWeightedOverallScore", () => {
  it("with no scale given it is the calculation it always was: out of 10, projected onto 100", () => {
    expect(computeWeightedOverallScore([{ score: 8, weight: 60 }, { score: 6, weight: 40 }])).toBe(72);
    expect(computeWeightedOverallScore([{ score: 10, weight: 10 }, { score: 10, weight: 10 }])).toBe(100);
  });

  it("the same judgement gives the same overall score on every scale", () => {
    // Four fifths on the first criterion, three fifths on the second.
    expect(computeWeightedOverallScore([{ score: 4, weight: 60 }, { score: 3, weight: 40 }], 5)).toBe(72);
    expect(computeWeightedOverallScore([{ score: 8, weight: 60 }, { score: 6, weight: 40 }], 10)).toBe(72);
    expect(computeWeightedOverallScore([{ score: 80, weight: 60 }, { score: 60, weight: 40 }], 100)).toBe(72);
  });

  it("a perfect and an empty review are 100 and 0 on every scale", () => {
    for (const scale of REVIEW_SCORE_SCALES) {
      expect(computeWeightedOverallScore([{ score: scale, weight: 30 }, { score: scale, weight: 70 }], scale)).toBe(100);
      expect(computeWeightedOverallScore([{ score: 0, weight: 30 }, { score: 0, weight: 70 }], scale)).toBe(0);
    }
  });

  it("never leaves 0 to 100, and is null with nothing to compute", () => {
    expect(computeWeightedOverallScore([{ score: 10, weight: 50 }], 5)).toBe(100);
    expect(computeWeightedOverallScore([], 5)).toBeNull();
    expect(computeWeightedOverallScore([{ score: 3, weight: 0 }], 5)).toBeNull();
  });
});
