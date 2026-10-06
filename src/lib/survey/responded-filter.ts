/**
 * "Responded / Not responded to <survey>" (several surveys, Phase 2, Oct 6,
 * 2026; docs/MULTI_SURVEY_PLAN.md O1): derived from the response rows, never a
 * stored flag or a tag. One rule for the Registrations filter, the bulk email
 * count and (as the equivalent Prisma where in bulk-email.ts) the send, so the
 * number the organiser reads is the number mailed. Client-safe.
 */
import { z } from "zod";

export const surveyRespondedSchema = z.object({
  surveyId: z.string().min(1).max(64),
  answered: z.enum(["yes", "no"]),
});

export type SurveyRespondedFilter = z.infer<typeof surveyRespondedSchema>;

/** Whether a registration (by the surveys it answered) passes the filter. No filter passes everyone. */
export function matchesSurveyResponded(
  answeredSurveyIds: readonly string[] | undefined,
  filter: SurveyRespondedFilter | null | undefined,
): boolean {
  if (!filter) return true;
  const answered = (answeredSurveyIds ?? []).includes(filter.surveyId);
  return filter.answered === "yes" ? answered : !answered;
}
