/**
 * Unit tests for src/lib/survey/aggregate.ts — pure rating / single-
 * select / text aggregators + CSV escaping.
 *
 * The reporting page + CSV export route both depend on these
 * functions returning EXACT shapes (histogram length, header order,
 * RFC 4180 escaping). If any of these assertions break, the report
 * UI silently misrenders or the CSV breaks downstream importers
 * (Excel / Google Sheets) — neither failure mode is easy to spot.
 */

import { describe, it, expect } from "vitest";
import {
  aggregateRating,
  aggregateSingleSelect,
  aggregateText,
  aggregateSurvey,
  csvCell,
  toCsv,
  type SurveyResponseLike,
} from "@/lib/survey/aggregate";
import type {
  SurveyConfig,
  RatingQuestion,
  SingleSelectQuestion,
  TextQuestion,
} from "@/lib/survey/schema";

// ── Fixtures ────────────────────────────────────────────────────────────

const rating: RatingQuestion = {
  id: "r1",
  type: "rating_1_to_5",
  label: "Overall satisfaction",
  required: true,
};

const select: SingleSelectQuestion = {
  id: "s1",
  type: "single_select",
  label: "Occupation",
  required: true,
  options: ["Academia", "Physician", "Student"],
};

const text: TextQuestion = {
  id: "t1",
  type: "text",
  label: "Comments",
  required: false,
};

function mkResponse(id: string, answers: Record<string, string | number>): SurveyResponseLike {
  return { id, submittedAt: new Date("2026-06-05T00:00:00Z"), answers };
}

// ── Rating ──────────────────────────────────────────────────────────────

describe("aggregateRating", () => {
  it("returns zero state for empty responses", () => {
    const result = aggregateRating(rating, []);
    expect(result.count).toBe(0);
    expect(result.mean).toBeNull();
    expect(result.distribution).toEqual([0, 0, 0, 0, 0]);
  });

  it("computes count + mean + distribution correctly", () => {
    const responses = [
      mkResponse("a", { r1: 5 }),
      mkResponse("b", { r1: 4 }),
      mkResponse("c", { r1: 5 }),
      mkResponse("d", { r1: 3 }),
    ];
    const result = aggregateRating(rating, responses);
    expect(result.count).toBe(4);
    expect(result.mean).toBe(4.25);
    expect(result.distribution).toEqual([0, 0, 1, 1, 2]);
  });

  it("excludes responses that skipped this question (denominator stays honest)", () => {
    const responses = [
      mkResponse("a", { r1: 5 }),
      mkResponse("b", { other: 3 }), // didn't answer r1
      mkResponse("c", { r1: 5 }),
    ];
    const result = aggregateRating(rating, responses);
    expect(result.count).toBe(2);
    expect(result.mean).toBe(5);
  });

  it("excludes non-integer + out-of-range values defensively", () => {
    const responses = [
      mkResponse("a", { r1: 5 }),
      mkResponse("b", { r1: 6 }), // out of range
      mkResponse("c", { r1: 3.5 }), // fractional
      // String "4" — defensive coercion: schema validates at submit
      // time so DB rows are always numeric. We don't coerce in the
      // aggregator.
      mkResponse("d", { r1: "4" as unknown as number }),
    ];
    const result = aggregateRating(rating, responses);
    expect(result.count).toBe(1);
  });
});

// ── Single select ───────────────────────────────────────────────────────

describe("aggregateSingleSelect", () => {
  it("buckets all configured options (zero counts visible)", () => {
    const result = aggregateSingleSelect(select, []);
    expect(result.counts).toEqual({ Academia: 0, Physician: 0, Student: 0 });
    expect(result.count).toBe(0);
    expect(result.orphaned).toEqual({});
  });

  it("counts each option independently", () => {
    const responses = [
      mkResponse("a", { s1: "Academia" }),
      mkResponse("b", { s1: "Academia" }),
      mkResponse("c", { s1: "Student" }),
    ];
    const result = aggregateSingleSelect(select, responses);
    expect(result.counts).toEqual({ Academia: 2, Physician: 0, Student: 1 });
    expect(result.count).toBe(3);
  });

  it("buckets answers no longer in config under `orphaned` (rename safety)", () => {
    const responses = [
      mkResponse("a", { s1: "Academia" }),
      mkResponse("b", { s1: "Allied Health" }), // option later removed
      mkResponse("c", { s1: "Pharma" }), // option later removed
      mkResponse("d", { s1: "Pharma" }),
    ];
    const result = aggregateSingleSelect(select, responses);
    expect(result.orphaned).toEqual({ "Allied Health": 1, Pharma: 2 });
    expect(result.counts.Academia).toBe(1);
    expect(result.count).toBe(4);
  });
});

// ── Text ────────────────────────────────────────────────────────────────

describe("aggregateText", () => {
  it("surfaces non-empty responses verbatim with timestamps", () => {
    // Explicit SurveyResponseLike[] annotation so TS doesn't infer
    // the array element type as a union of `{t1: string}` and `{}` —
    // that widens to `{t1?: undefined}` which violates the strict
    // Record<string, SurveyAnswerValue> on the parameter.
    const responses: SurveyResponseLike[] = [
      { id: "a", submittedAt: new Date("2026-06-05T10:00:00Z"), answers: { t1: "Loved it" } },
      { id: "b", submittedAt: new Date("2026-06-05T11:00:00Z"), answers: {} },
      { id: "c", submittedAt: new Date("2026-06-05T12:00:00Z"), answers: { t1: "Wifi bad" } },
    ];
    const result = aggregateText(text, responses);
    expect(result.count).toBe(2);
    expect(result.responses.map((r) => r.value)).toEqual(["Loved it", "Wifi bad"]);
    expect(result.responses[0].submittedAt).toBeInstanceOf(Date);
  });

  it("normalizes string submittedAt to Date", () => {
    const responses = [{ id: "a", submittedAt: "2026-06-05T10:00:00Z", answers: { t1: "yes" } }];
    const result = aggregateText(text, responses);
    expect(result.responses[0].submittedAt).toBeInstanceOf(Date);
  });
});

// ── aggregateSurvey orchestrator ────────────────────────────────────────

describe("aggregateSurvey", () => {
  it("preserves config order in output", () => {
    const config: SurveyConfig = [text, rating, select];
    const result = aggregateSurvey(config, []);
    expect(result.map((r) => r.type)).toEqual(["text", "rating_1_to_5", "single_select"]);
  });

  it("handles a typical mixed survey end-to-end", () => {
    const config: SurveyConfig = [rating, select, text];
    const responses = [
      mkResponse("a", { r1: 5, s1: "Academia", t1: "Great" }),
      mkResponse("b", { r1: 4, s1: "Student" }),
      mkResponse("c", { r1: 5, t1: "Wifi" }),
    ];
    const result = aggregateSurvey(config, responses);
    expect(result).toHaveLength(3);
    const ratingAgg = result[0];
    if (ratingAgg.type !== "rating_1_to_5") throw new Error("type narrow");
    expect(ratingAgg.count).toBe(3);
    expect(ratingAgg.mean).toBeCloseTo(14 / 3);
  });
});

// ── csvCell ─────────────────────────────────────────────────────────────

describe("csvCell — RFC 4180 escaping", () => {
  it("passes through plain values unchanged", () => {
    expect(csvCell("hello")).toBe("hello");
    expect(csvCell(42)).toBe("42");
  });

  it("renders null + undefined as empty string", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("wraps values with commas in double quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
  });

  it("wraps + escapes embedded double quotes", () => {
    expect(csvCell('she said "hi"')).toBe('"she said ""hi"""');
  });

  it("wraps values with newlines (Excel-safe)", () => {
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("line1\r\nline2")).toBe('"line1\r\nline2"');
  });
});

// ── toCsv ───────────────────────────────────────────────────────────────

describe("toCsv", () => {
  const config: SurveyConfig = [rating, select];

  it("writes the header row with submittedAt + identity + question labels", () => {
    const csv = toCsv(config, []);
    const lines = csv.split("\n");
    expect(lines[0]).toMatch(/^submittedAt,firstName,lastName,email,/);
    expect(lines[0]).toContain("Overall satisfaction");
    expect(lines[0]).toContain("Occupation");
  });

  it("writes one row per response with answers in config order", () => {
    const csv = toCsv(config, [
      {
        responseId: "x",
        submittedAt: new Date("2026-06-05T10:00:00.000Z"),
        registrantFirstName: "Jane",
        registrantLastName: "Doe",
        registrantEmail: "jane@example.com",
        answers: { r1: 4, s1: "Academia" },
      },
    ]);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("2026-06-05T10:00:00.000Z,Jane,Doe,jane@example.com,4,Academia");
  });

  it("renders missing answers as empty cells, NOT 'undefined'", () => {
    const csv = toCsv(config, [
      {
        responseId: "x",
        submittedAt: "2026-06-05T10:00:00.000Z",
        answers: { r1: 4 },
      },
    ]);
    expect(csv.split("\n")[1]).toBe("2026-06-05T10:00:00.000Z,,,,4,");
  });

  it("escapes commas inside identity + answers (no column-shift attack)", () => {
    const csv = toCsv(config, [
      {
        responseId: "x",
        submittedAt: "2026-06-05T10:00:00.000Z",
        registrantFirstName: "Jane, Mary",
        answers: { r1: 5, s1: "Comma, Option" }, // contrived
      },
    ]);
    const row = csv.split("\n")[1];
    expect(row).toContain('"Jane, Mary"');
    expect(row).toContain('"Comma, Option"');
  });

  it("escapes embedded quotes in text answers", () => {
    const cfg: SurveyConfig = [text];
    const csv = toCsv(cfg, [
      {
        responseId: "x",
        submittedAt: "2026-06-05T10:00:00.000Z",
        answers: { t1: 'said "great"' },
      },
    ]);
    expect(csv.split("\n")[1]).toContain('"said ""great"""');
  });
});
