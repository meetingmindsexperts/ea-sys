/**
 * Pure aggregation + CSV helpers for survey responses.
 *
 * Used by:
 *   - `/events/[eventId]/survey/responses` page (per-question summary)
 *   - `/api/events/[eventId]/survey/responses/export` route (CSV stream)
 *
 * Stateless: every function takes a config + the response list (or a
 * single response) and returns derived data. No DB access, no logging
 * — Vitest can pin every branch with plain object fixtures.
 *
 * Math conventions:
 *   - rating means use integer answers 1..5; missing answers are
 *     EXCLUDED from the denominator (a skipped optional rating
 *     shouldn't drag the average down)
 *   - "response count" for a question = number of responses that
 *     actually answered it (NOT total responses to the survey)
 *   - single_select counts include only valid options from the
 *     current config; orphaned answers (option later removed) are
 *     bucketed under `__orphaned` so they're visible but don't
 *     pollute the percentage math
 */

import type {
  SurveyConfig,
  SurveyAnswerValue,
  RatingQuestion,
  SingleSelectQuestion,
  TextQuestion,
} from "./schema";

/** Shape that callers pass in — narrowest useful slice of SurveyResponse. */
export interface SurveyResponseLike {
  id: string;
  submittedAt: Date | string;
  answers: Record<string, SurveyAnswerValue>;
}

// ── Per-question aggregates ──────────────────────────────────────────────

export interface RatingAggregate {
  questionId: string;
  label: string;
  /** Responses that answered this rating question. NOT total survey responses. */
  count: number;
  /** Arithmetic mean across answered values. `null` when count = 0. */
  mean: number | null;
  /** Histogram bucket counts for 1..5 in order. Always length 5. */
  distribution: [number, number, number, number, number];
}

export function aggregateRating(
  question: RatingQuestion,
  responses: SurveyResponseLike[],
): RatingAggregate {
  const distribution: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  let sum = 0;
  let count = 0;
  for (const r of responses) {
    const v = r.answers[question.id];
    // Strict 1..5 integer — defensive against legacy or hand-edited
    // rows that might have a string. We don't coerce; an out-of-range
    // value is excluded rather than silently pushed into a bucket.
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 5) continue;
    distribution[v - 1] += 1;
    sum += v;
    count += 1;
  }
  return {
    questionId: question.id,
    label: question.label,
    count,
    mean: count === 0 ? null : sum / count,
    distribution,
  };
}

export interface SingleSelectAggregate {
  questionId: string;
  label: string;
  /** Responses that answered this question (count of non-orphaned + orphaned answers). */
  count: number;
  /**
   * Counts keyed by current option strings (every configured option
   * appears, even with 0 — so the UI can render the full list
   * without a separate "options" lookup).
   */
  counts: Record<string, number>;
  /**
   * Answers whose value is not in the question's current option list.
   * Happens when the organizer renames or removes an option mid-
   * collection. Surfaced separately so they're visible in the report
   * (not silently dropped) without polluting the % math.
   */
  orphaned: Record<string, number>;
}

export function aggregateSingleSelect(
  question: SingleSelectQuestion,
  responses: SurveyResponseLike[],
): SingleSelectAggregate {
  const counts: Record<string, number> = Object.fromEntries(
    question.options.map((o) => [o, 0]),
  );
  const orphaned: Record<string, number> = {};
  let count = 0;
  for (const r of responses) {
    const v = r.answers[question.id];
    if (typeof v !== "string" || v.length === 0) continue;
    count += 1;
    if (v in counts) {
      counts[v] += 1;
    } else {
      orphaned[v] = (orphaned[v] ?? 0) + 1;
    }
  }
  return {
    questionId: question.id,
    label: question.label,
    count,
    counts,
    orphaned,
  };
}

export interface TextAggregate {
  questionId: string;
  label: string;
  count: number;
  /** Individual responses surfaced verbatim. Capped at 500 by caller
   *  if needed; this function returns all of them. */
  responses: Array<{ responseId: string; submittedAt: Date; value: string }>;
}

export function aggregateText(
  question: TextQuestion,
  responses: SurveyResponseLike[],
): TextAggregate {
  const out: TextAggregate["responses"] = [];
  for (const r of responses) {
    const v = r.answers[question.id];
    if (typeof v !== "string" || v.length === 0) continue;
    out.push({
      responseId: r.id,
      submittedAt: typeof r.submittedAt === "string" ? new Date(r.submittedAt) : r.submittedAt,
      value: v,
    });
  }
  return {
    questionId: question.id,
    label: question.label,
    count: out.length,
    responses: out,
  };
}

// ── Whole-survey aggregate ───────────────────────────────────────────────

export type QuestionAggregate =
  | ({ type: "rating_1_to_5" } & RatingAggregate)
  | ({ type: "single_select" } & SingleSelectAggregate)
  | ({ type: "text" } & TextAggregate);

/**
 * Aggregate every question in the config against the response set.
 * Preserves config order so the report renders questions in the
 * order the organizer authored them.
 */
export function aggregateSurvey(
  config: SurveyConfig,
  responses: SurveyResponseLike[],
): QuestionAggregate[] {
  return config.map((q): QuestionAggregate => {
    switch (q.type) {
      case "rating_1_to_5":
        return { type: "rating_1_to_5", ...aggregateRating(q, responses) };
      case "single_select":
        return { type: "single_select", ...aggregateSingleSelect(q, responses) };
      case "text":
        return { type: "text", ...aggregateText(q, responses) };
    }
  });
}

// ── CSV export ───────────────────────────────────────────────────────────

/**
 * CSV-escape a single cell per RFC 4180:
 *   - if the value contains comma, quote, CR, or LF: wrap in double-
 *     quotes and double any internal quotes
 *   - otherwise return as-is
 *
 * Numbers, booleans, null, undefined all flatten to their string form;
 * `null`/`undefined` become empty.
 */
export function csvCell(value: SurveyAnswerValue | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export interface CsvResponseRow {
  responseId: string;
  submittedAt: Date | string;
  registrantFirstName?: string | null;
  registrantLastName?: string | null;
  registrantEmail?: string | null;
  answers: Record<string, SurveyAnswerValue>;
}

/**
 * Build a CSV document with one row per response. Column order:
 *
 *   submittedAt, firstName, lastName, email, <one column per question in config order>
 *
 * Question column headers use the current `question.label` truncated
 * + the question id in brackets so duplicates within a survey
 * (allowed by the schema if labels match) can be distinguished:
 *
 *   "Overall satisfaction [a1b2c3]"
 *
 * Returns the full CSV as a single string. Callers stream it via the
 * route handler's NextResponse body — sizes are small (typical event
 * = a few thousand rows × ~20 columns ≈ <2 MB).
 */
export function toCsv(
  config: SurveyConfig,
  rows: CsvResponseRow[],
): string {
  const idColumns = config.map((q) => q.id);
  const headers = [
    "submittedAt",
    "firstName",
    "lastName",
    "email",
    ...config.map((q) => `${truncateLabel(q.label)} [${q.id.slice(0, 8)}]`),
  ];

  const lines: string[] = [headers.map(csvCell).join(",")];

  for (const row of rows) {
    const submittedAtIso =
      typeof row.submittedAt === "string" ? row.submittedAt : row.submittedAt.toISOString();
    const cells: string[] = [
      csvCell(submittedAtIso),
      csvCell(row.registrantFirstName ?? null),
      csvCell(row.registrantLastName ?? null),
      csvCell(row.registrantEmail ?? null),
      ...idColumns.map((id) => csvCell(row.answers[id] ?? null)),
    ];
    lines.push(cells.join(","));
  }

  // RFC 4180 specifies CRLF, but every CSV reader on Earth accepts
  // both. LF keeps the test fixtures readable.
  return lines.join("\n");
}

function truncateLabel(label: string, max = 80): string {
  if (label.length <= max) return label;
  return label.slice(0, max - 1) + "…";
}
