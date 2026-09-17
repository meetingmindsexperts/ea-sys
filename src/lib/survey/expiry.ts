/**
 * How long a personal survey link stays valid.
 *
 * The organizer types a whole number of days in the Survey Invitation send
 * (Sep 17, 2026: it was a 3/5/7/10 dropdown, which could not express the 15,
 * 30 or 45 days organizers actually wanted). The number rides inside
 * `filters.surveyExpiryDays`, so a scheduled send reads it back from the
 * persisted ScheduledEmail row; rows saved under the old dropdown hold 3, 5,
 * 7 or 10, all of which still validate.
 *
 * The bounds are not a product rule, they are a typo guard: a whole number,
 * at least one day, at most a year. Without a ceiling, `450` meant for 45
 * mints links that outlive the event by over a year.
 *
 * CLIENT-SAFE: imported by the bulk-email dialog for its inline check, so no
 * Node-only imports here.
 */

import { z } from "zod";

export const MIN_SURVEY_EXPIRY_DAYS = 1;
export const MAX_SURVEY_EXPIRY_DAYS = 365;

/** Used when a send carries no expiry (the behaviour before it was configurable). */
export const DEFAULT_SURVEY_EXPIRY_DAYS = 7;

export const DAY_MS = 24 * 60 * 60 * 1000;

export const surveyExpiryDaysSchema = z
  .number()
  .int("Survey link expiry must be a whole number of days")
  .min(MIN_SURVEY_EXPIRY_DAYS, `Survey link expiry must be at least ${MIN_SURVEY_EXPIRY_DAYS} day`)
  .max(MAX_SURVEY_EXPIRY_DAYS, `Survey link expiry can be at most ${MAX_SURVEY_EXPIRY_DAYS} days`);

export type SurveyExpiryDays = z.infer<typeof surveyExpiryDaysSchema>;

/**
 * Parse what the organizer typed. Digits only: "30" is 30; "3.5", "-2",
 * "1e2", " " and "" are all rejected rather than coerced, so the number that
 * is sent is the number they saw.
 */
export function parseSurveyExpiryInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = surveyExpiryDaysSchema.safeParse(Number(trimmed));
  return parsed.success ? parsed.data : null;
}
