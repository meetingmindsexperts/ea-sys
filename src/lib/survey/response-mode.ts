/**
 * How often one person may answer a survey (several surveys, Phase 4,
 * Oct 7, 2026; docs/MULTI_SURVEY_PLAN.md §5). Client-safe.
 *
 * ONCE: one answer, the personal link single-use (every survey before Phase 4,
 * and always the certificate survey).
 * ONCE_PER_DAY (owner: daily feedback at a multi-day event): one answer per
 * calendar day in the event's timezone; the personal link stays valid until it
 * expires, and never lets anyone change an answer already given.
 */
import { localDateInTz, resolveTimezone } from "@/lib/event-time";

export type SurveyResponseModeValue = "ONCE" | "ONCE_PER_DAY";

export const RESPONSE_MODE_LABEL: Record<SurveyResponseModeValue, string> = {
  ONCE: "Once per person",
  ONCE_PER_DAY: "Once per person per day",
};

export function isDailyMode(mode: string | null | undefined): boolean {
  return mode === "ONCE_PER_DAY";
}

/** The day an answer counts for: its calendar date in the event's timezone. */
export function responseDay(at: Date, timezone: string | null | undefined): string {
  return localDateInTz(at, resolveTimezone(timezone));
}

/**
 * The duplicate gate (`@@unique([surveyId, dedupKey])`): the registration for
 * ONCE, the registration and the day for ONCE_PER_DAY, so a second answer the
 * same day is refused by the database itself.
 */
export function responseDedupKey(
  mode: string | null | undefined,
  registrationId: string,
  at: Date,
  timezone: string | null | undefined,
): string {
  return isDailyMode(mode) ? `${registrationId}:${responseDay(at, timezone)}` : registrationId;
}
