/** "Answered / Not answered <survey>" (several surveys, Phase 2): the one client rule. */
import { describe, it, expect } from "vitest";
import { matchesSurveyResponded, surveyRespondedSchema } from "@/lib/survey/responded-filter";

describe("matchesSurveyResponded", () => {
  it("no filter passes everyone", () => {
    expect(matchesSurveyResponded(undefined, null)).toBe(true);
    expect(matchesSurveyResponded(["a"], undefined)).toBe(true);
  });
  it("answered: only rows that answered that survey", () => {
    expect(matchesSurveyResponded(["a", "b"], { surveyId: "b", answered: "yes" })).toBe(true);
    expect(matchesSurveyResponded(["a"], { surveyId: "b", answered: "yes" })).toBe(false);
    expect(matchesSurveyResponded(undefined, { surveyId: "b", answered: "yes" })).toBe(false);
  });
  it("not answered: everyone without that survey, including rows with no answers at all", () => {
    expect(matchesSurveyResponded(["a"], { surveyId: "b", answered: "no" })).toBe(true);
    expect(matchesSurveyResponded(undefined, { surveyId: "b", answered: "no" })).toBe(true);
    expect(matchesSurveyResponded(["b"], { surveyId: "b", answered: "no" })).toBe(false);
  });
  it("the schema accepts only yes / no and a survey id", () => {
    expect(surveyRespondedSchema.safeParse({ surveyId: "s", answered: "yes" }).success).toBe(true);
    expect(surveyRespondedSchema.safeParse({ surveyId: "s", answered: "maybe" }).success).toBe(false);
    expect(surveyRespondedSchema.safeParse({ surveyId: "", answered: "no" }).success).toBe(false);
  });
});
