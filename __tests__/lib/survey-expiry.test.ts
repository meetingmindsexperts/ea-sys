/**
 * Survey link expiry is typed by the organizer (Sep 17, 2026). It was a
 * 3/5/7/10 dropdown that could not say 15, 30 or 45. The bounds are a typo
 * guard, and the parser refuses anything that is not plainly a whole number
 * rather than coercing it, so the number sent is the number shown.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_SURVEY_EXPIRY_DAYS,
  MAX_SURVEY_EXPIRY_DAYS,
  MIN_SURVEY_EXPIRY_DAYS,
  parseSurveyExpiryInput,
  surveyExpiryDaysSchema,
} from "@/lib/survey/expiry";

describe("surveyExpiryDaysSchema", () => {
  it.each([1, 10, 15, 30, 45, 90, 365])("accepts %i days", (n) => {
    expect(surveyExpiryDaysSchema.safeParse(n).success).toBe(true);
  });

  it.each([3, 5, 7, 10])("still accepts %i, the old dropdown values held by saved scheduled sends", (n) => {
    expect(surveyExpiryDaysSchema.safeParse(n).success).toBe(true);
  });

  it.each([0, -1, 366, 2.5, Number.NaN])("rejects %s", (n) => {
    expect(surveyExpiryDaysSchema.safeParse(n).success).toBe(false);
  });

  it("rejects a numeric string (the filter JSON carries a number)", () => {
    expect(surveyExpiryDaysSchema.safeParse("30").success).toBe(false);
  });

  it("keeps the historical default and sane bounds", () => {
    expect(DEFAULT_SURVEY_EXPIRY_DAYS).toBe(7);
    expect(MIN_SURVEY_EXPIRY_DAYS).toBe(1);
    expect(MAX_SURVEY_EXPIRY_DAYS).toBe(365);
  });
});

describe("parseSurveyExpiryInput", () => {
  it.each([
    ["30", 30],
    ["45", 45],
    [" 15 ", 15],
    ["1", 1],
    ["365", 365],
    ["007", 7],
  ])("reads %j as %i", (raw, expected) => {
    expect(parseSurveyExpiryInput(raw)).toBe(expected);
  });

  it.each(["", " ", "0", "366", "3.5", "-2", "1e2", "30 days", "abc", "+5"])(
    "refuses %j instead of guessing",
    (raw) => {
      expect(parseSurveyExpiryInput(raw)).toBeNull();
    },
  );
});
