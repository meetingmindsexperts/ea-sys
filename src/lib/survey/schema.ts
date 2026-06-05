/**
 * Zod schemas + TS types for the per-event feedback survey.
 *
 * Single source of truth used by:
 *   - the admin builder UI (`/events/[eventId]/survey`)
 *   - the public form renderer (`/e/[slug]/survey`)
 *   - the public submit route's answer validation
 *
 * Storage shape: `Event.surveyConfig` holds the ordered question array
 * verbatim (see prisma/schema.prisma:~205 + migration
 * 20260605120000_add_survey). `SurveyResponse.answers` is a flat
 * `{ [questionId]: value }` map; skipped optional questions are
 * ABSENT from the map (not null) so a `Object.keys(answers).length`
 * count reflects "questions actually answered".
 *
 * Question type evolution — adding a new type:
 *   1. Add a union arm to `SurveyQuestion` (in this file)
 *   2. Add a discriminator to `surveyAnswerForQuestion()`
 *   3. Add a renderer case in the public form's question component
 *   4. Add an aggregator (if numeric) in `src/lib/survey/aggregate.ts`
 *
 * The `id` field is critical: it's how answers stay linked to
 * questions across renames + reorders. The builder MUST generate
 * a fresh id on question-create (via `newQuestionId()` below) and
 * MUST preserve the id across edits. NEVER use array index.
 */

import { z } from "zod";
import { randomUUID } from "crypto";

// ── Question types ───────────────────────────────────────────────────────

/**
 * Single-select question — fixed list of options, exactly one answer.
 * Used for the "occupation" + "how did you hear about us" cases in
 * the operator-provided example.
 */
export const singleSelectQuestionSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.literal("single_select"),
  label: z.string().min(1).max(500),
  required: z.boolean(),
  options: z.array(z.string().min(1).max(200)).min(2).max(20),
});

/**
 * 1-to-5 rating (Likert) question — the bulk of a typical post-event
 * survey (program quality, presentations, venue, A/V, etc.). The
 * 1-5 range is fixed by convention; we don't expose configurable
 * scale length because doing so would force the aggregator to
 * branch on every render.
 */
export const ratingQuestionSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.literal("rating_1_to_5"),
  label: z.string().min(1).max(500),
  required: z.boolean(),
});

/**
 * Free-text question. `maxLength` defaults to 2000 (longer than any
 * sane survey comment, short enough to be SES-safe in CSV exports).
 */
export const textQuestionSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.literal("text"),
  label: z.string().min(1).max(500),
  required: z.boolean(),
  maxLength: z.number().int().min(1).max(10_000).optional(),
});

export const surveyQuestionSchema = z.discriminatedUnion("type", [
  singleSelectQuestionSchema,
  ratingQuestionSchema,
  textQuestionSchema,
]);

export type SurveyQuestion = z.infer<typeof surveyQuestionSchema>;
export type SingleSelectQuestion = z.infer<typeof singleSelectQuestionSchema>;
export type RatingQuestion = z.infer<typeof ratingQuestionSchema>;
export type TextQuestion = z.infer<typeof textQuestionSchema>;

// ── Survey config (whole-event shape) ────────────────────────────────────

/**
 * The full per-event survey definition stored at `Event.surveyConfig`.
 * Capped at 50 questions per event to keep the public form fast +
 * the CSV export manageable; not a soft limit, it's a Zod refusal.
 *
 * Question `id`s must be unique within the survey — duplicates would
 * cause silent answer overwrite at submit time. The refinement
 * below enforces it before persistence.
 */
export const surveyConfigSchema = z
  .array(surveyQuestionSchema)
  .min(1)
  .max(50)
  .refine(
    (questions) => {
      const ids = new Set<string>();
      for (const q of questions) {
        if (ids.has(q.id)) return false;
        ids.add(q.id);
      }
      return true;
    },
    { message: "Question ids must be unique within the survey" },
  );

export type SurveyConfig = z.infer<typeof surveyConfigSchema>;

// ── Answer types + per-config validator ──────────────────────────────────

/**
 * Possible answer value shapes (typed by question kind):
 *   single_select → one of the configured option strings
 *   rating_1_to_5 → integer 1..5
 *   text          → string (up to question.maxLength)
 */
export type SurveyAnswerValue = string | number;

/**
 * Per-question answer schema — derives the right Zod schema from
 * the question's type so the API route can validate submitted
 * `answers` against the *current* config (not a frozen snapshot —
 * if the organizer edits the survey mid-collection, in-flight
 * responses validate against the new shape).
 *
 * Required questions: must be present + non-empty.
 * Optional questions: may be absent OR present with a valid value.
 *                     `null` is NEVER accepted — use absence.
 */
export function surveyAnswerForQuestion(q: SurveyQuestion): z.ZodTypeAny {
  switch (q.type) {
    case "single_select":
      return z.enum(q.options as [string, ...string[]]);
    case "rating_1_to_5":
      return z.number().int().min(1).max(5);
    case "text":
      return z.string().min(1).max(q.maxLength ?? 2000);
  }
}

/**
 * Validate a `{ [questionId]: value }` answer map against a config.
 * Returns `{ ok: true, answers }` with the normalized map (unknown
 * keys stripped, integers coerced where safe) or
 * `{ ok: false, errors }` listing every problem so the form can
 * highlight every bad field at once.
 *
 * Critical: the route MUST use the result's `answers`, NOT the
 * caller's input — values may have been coerced (e.g. "3" → 3 for
 * a rating). Don't write the raw input.
 */
export function validateAnswers(
  config: SurveyConfig,
  rawAnswers: Record<string, unknown>,
): { ok: true; answers: Record<string, SurveyAnswerValue> } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const out: Record<string, SurveyAnswerValue> = {};

  for (const question of config) {
    const raw = rawAnswers[question.id];
    const isAbsent = raw === undefined || raw === null || raw === "";

    if (isAbsent) {
      if (question.required) {
        errors.push(`Question ${question.id} (${question.label}) is required`);
      }
      // Absent + optional = skip entirely (don't write null to the map).
      continue;
    }

    // Type-coerce numerics so an HTML form's `"3"` reaches the rating
    // validator as 3. Single-select + text expect string already.
    let candidate: unknown = raw;
    if (question.type === "rating_1_to_5" && typeof raw === "string") {
      const n = Number(raw);
      if (Number.isFinite(n)) candidate = n;
    }

    const result = surveyAnswerForQuestion(question).safeParse(candidate);
    if (!result.success) {
      errors.push(
        `Question ${question.id} (${question.label}): ${result.error.issues[0]?.message ?? "invalid"}`,
      );
      continue;
    }
    out[question.id] = result.data as SurveyAnswerValue;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, answers: out };
}

// ── ID generation ────────────────────────────────────────────────────────

/**
 * Generate a stable question id. The builder MUST call this exactly
 * once per question-create and never re-derive from array index.
 *
 * `crypto.randomUUID()` (Node 18+, built-in) gives 122 bits of
 * entropy in a 36-char string. We strip the dashes purely to keep
 * the surveyConfig JSON compact in the DB; collision resistance is
 * unchanged.
 */
export function newQuestionId(): string {
  return randomUUID().replace(/-/g, "");
}
