/**
 * How long a personal survey link stays valid. The rule is shared with the
 * registration form link and lives in src/lib/link-expiry.ts (Oct 16, 2026);
 * these names stay so the survey callers and a ScheduledEmail row saved with
 * `filters.surveyExpiryDays` read exactly as before.
 *
 * CLIENT-SAFE: imported by the bulk-email dialog for its inline check.
 */
import { z } from "zod";
import {
  DAY_MS,
  DEFAULT_LINK_EXPIRY_DAYS,
  MAX_LINK_EXPIRY_DAYS,
  MIN_LINK_EXPIRY_DAYS,
  linkExpiryDaysSchema,
  parseLinkExpiryInput,
} from "@/lib/link-expiry";

export { DAY_MS };
export const MIN_SURVEY_EXPIRY_DAYS = MIN_LINK_EXPIRY_DAYS;
export const MAX_SURVEY_EXPIRY_DAYS = MAX_LINK_EXPIRY_DAYS;

/** Used when a send carries no expiry (the behaviour before it was configurable). */
export const DEFAULT_SURVEY_EXPIRY_DAYS = DEFAULT_LINK_EXPIRY_DAYS;

export const surveyExpiryDaysSchema = linkExpiryDaysSchema("Survey link");

export type SurveyExpiryDays = z.infer<typeof surveyExpiryDaysSchema>;

/** Parse what the organizer typed (digits only, within the bounds). */
export const parseSurveyExpiryInput = parseLinkExpiryInput;
