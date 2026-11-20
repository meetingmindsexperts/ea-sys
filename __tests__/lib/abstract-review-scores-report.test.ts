/**
 * The review scores report (owner, Nov 20, 2026): one row per reviewer per
 * abstract, a column per criterion.
 *
 * MUTATIONS: read a criterion's score by position instead of by id and "each
 * score under its own criterion" fails; drop the assignments loop and "who
 * still owes a review" fails; drop the deleted-criterion columns and the last
 * test fails.
 */
import { describe, it, expect } from "vitest";
import { buildReviewScoresCsv, NOT_REVIEWED, REVIEWED, type ReviewScoresInput } from "@/lib/abstract-review-scores-report";

const CRITERIA = [
  { id: "c-orig", name: "Originality", weight: 60 },
  { id: "c-meth", name: "Methods", weight: 40 },
];
const PEOPLE = new Map([
  ["u1", { firstName: "Rana", lastName: "Aziz", email: "rana@x.org" }],
  ["u2", { firstName: "Omar", lastName: "Said", email: "omar@x.org" }],
]);
const review = (over: Record<string, unknown> = {}) => ({
  reviewerUserId: "u1",
  criteriaScores: { "c-meth": 6, "c-orig": 9 },
  overallScore: 78,
  recommendedFormat: "ORAL",
  confidence: 4,
  reviewNotes: "Clear, =SUM(1) aside",
  updatedAt: new Date("2026-11-20T08:00:00.000Z"),
  ...over,
});
const abstract = (over: Record<string, unknown> = {}) => ({
  serialId: 4,
  title: "HF in women",
  status: "REJECTED",
  presentationType: "ORAL",
  themeName: "Outcomes",
  author: { title: "DR", firstName: "Hadi", lastName: "Skouri" },
  assigned: [{ userId: "u1", role: "PRIMARY" }, { userId: "u2", role: "SECONDARY" }],
  reviews: [review()],
  ...over,
});
const build = (abstracts: ReviewScoresInput["abstracts"], extra: Partial<ReviewScoresInput> = {}) =>
  buildReviewScoresCsv({ scale: 10, criteria: CRITERIA, people: PEOPLE, abstracts, ...extra });
const lines = (csv: string) => csv.split("\n");

describe("buildReviewScoresCsv", () => {
  it("names each criterion with its scale and weight, and puts each score under its own criterion whatever order the review stored them in", () => {
    const { csv } = build([abstract()]);
    const [header, first] = lines(csv);
    expect(header).toBe(
      "Abstract #,Title,Status,Presentation Type,Theme,Author,Reviewer,Reviewer Email,Reviewer Role,Review," +
        '"Originality (0-10, weight 60%)","Methods (0-10, weight 40%)",Overall (0-100),Recommended Format,Confidence (1-5),Notes,Reviewed At',
    );
    // Originality 9, Methods 6: the stored object had Methods first.
    expect(first).toBe(
      `A-004,HF in women,REJECTED,ORAL,Outcomes,Dr. Hadi Skouri,Rana Aziz,rana@x.org,PRIMARY,${REVIEWED},9,6,78,ORAL,4,"Clear, =SUM(1) aside",2026-11-20T08:00:00.000Z`,
    );
  });

  it("lists who still owes a review: an assignment with no review is a row with no scores", () => {
    const { csv, rowCount } = build([abstract()]);
    expect(rowCount).toBe(2);
    expect(lines(csv)[2]).toBe(`A-004,HF in women,REJECTED,ORAL,Outcomes,Dr. Hadi Skouri,Omar Said,omar@x.org,SECONDARY,"${NOT_REVIEWED}",,,,,,,`);
  });

  it("keeps a review whose reviewer was taken off the abstract, and gives an abstract nobody reviews no row", () => {
    const { csv, rowCount } = build([
      abstract({ assigned: [], reviews: [review({ reviewerUserId: "u2" })] }),
      abstract({ serialId: 5, assigned: [], reviews: [] }),
    ]);
    expect(rowCount).toBe(1);
    expect(lines(csv)[1]).toContain(`Omar Said,omar@x.org,,${REVIEWED},9,6,78`);
    expect(csv).not.toContain("A-005");
  });

  it("an overall-only review has no criterion scores, and a reviewer account that is gone leaves the name blank", () => {
    const { csv } = build([abstract({ assigned: [], reviews: [review({ reviewerUserId: "gone", criteriaScores: null, overallScore: 55 })] })]);
    expect(lines(csv)[1]).toContain(`,,,,${REVIEWED},,,55,ORAL`);
  });

  it("the header names the event's own scale", () => {
    expect(lines(build([abstract()], { scale: 100 }).csv)[0]).toContain('"Originality (0-100, weight 60%)"');
  });

  it("keeps the scores of a criterion deleted since, in a trailing column, because the overall was worked out with them", () => {
    const { csv } = build([abstract({ reviews: [review({ criteriaScores: { "c-orig": 9, "c-gone": 3 } })] })]);
    const [header, first] = lines(csv);
    expect(header).toContain('"Methods (0-10, weight 40%)",Deleted criterion 1 (0-10),Overall (0-100)');
    // Originality 9, Methods not scored, the deleted one 3.
    expect(first).toContain(`${REVIEWED},9,,3,78`);
  });
});
