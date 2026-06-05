/**
 * Unit tests for src/lib/survey/schema.ts — the survey config + answer
 * validator. Focused on the contract the public submit route relies on:
 *
 *   - SurveyConfig validation (per-question + cross-question rules)
 *   - validateAnswers() type coercion + required-field handling
 *   - Question id stability (newQuestionId is non-derived)
 *
 * If a single test in this file breaks, the public POST route's
 * answer validation breaks with it — these are the load-bearing
 * cases.
 */

import { describe, it, expect } from "vitest";
import {
  surveyConfigSchema,
  surveyQuestionSchema,
  validateAnswers,
  newQuestionId,
  type SurveyConfig,
  type SurveyQuestion,
} from "@/lib/survey/schema";

// ── Fixture builders ────────────────────────────────────────────────────

function makeRating(id: string, required = true): SurveyQuestion {
  return { id, type: "rating_1_to_5", label: `Rate ${id}`, required };
}
function makeSelect(id: string, options: string[], required = true): SurveyQuestion {
  return { id, type: "single_select", label: `Pick ${id}`, required, options };
}
function makeText(id: string, required = false, maxLength?: number): SurveyQuestion {
  return { id, type: "text", label: `Tell us about ${id}`, required, maxLength };
}

// ── Question / config schema ────────────────────────────────────────────

describe("surveyQuestionSchema", () => {
  it("accepts a valid rating question", () => {
    expect(surveyQuestionSchema.safeParse(makeRating("q1")).success).toBe(true);
  });

  it("accepts a valid single_select with 2 options", () => {
    const q = makeSelect("q2", ["A", "B"]);
    expect(surveyQuestionSchema.safeParse(q).success).toBe(true);
  });

  it("rejects single_select with only 1 option (no choice = not a question)", () => {
    const q = { ...makeSelect("q2", ["A"]) };
    expect(surveyQuestionSchema.safeParse(q).success).toBe(false);
  });

  it("rejects single_select with more than 20 options (denial-of-service guard)", () => {
    const opts = Array.from({ length: 21 }, (_, i) => `opt${i}`);
    expect(surveyQuestionSchema.safeParse(makeSelect("q", opts)).success).toBe(false);
  });

  it("rejects rating with required missing", () => {
    const bad: unknown = { id: "q1", type: "rating_1_to_5", label: "Rate q1" };
    expect(surveyQuestionSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an empty label", () => {
    const bad = { ...makeRating("q1"), label: "" };
    expect(surveyQuestionSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts text with custom maxLength", () => {
    expect(surveyQuestionSchema.safeParse(makeText("q", false, 500)).success).toBe(true);
  });
});

describe("surveyConfigSchema", () => {
  it("accepts a valid 3-question config", () => {
    const cfg = [makeRating("q1"), makeSelect("q2", ["A", "B"]), makeText("q3")];
    expect(surveyConfigSchema.safeParse(cfg).success).toBe(true);
  });

  it("rejects an empty config (min: 1)", () => {
    expect(surveyConfigSchema.safeParse([]).success).toBe(false);
  });

  it("rejects more than 50 questions", () => {
    const cfg = Array.from({ length: 51 }, (_, i) => makeRating(`q${i}`));
    expect(surveyConfigSchema.safeParse(cfg).success).toBe(false);
  });

  it("rejects duplicate question ids (silent-overwrite vector)", () => {
    const cfg = [makeRating("dup"), makeText("dup")];
    const result = surveyConfigSchema.safeParse(cfg);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/unique/i);
    }
  });
});

// ── newQuestionId ───────────────────────────────────────────────────────

describe("newQuestionId", () => {
  it("returns a 32-char hex-ish string (UUID minus dashes)", () => {
    const id = newQuestionId();
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[a-f0-9]{32}$/);
  });

  it("produces different ids on each call", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newQuestionId()));
    expect(ids.size).toBe(50);
  });
});

// ── validateAnswers ─────────────────────────────────────────────────────

describe("validateAnswers — happy path", () => {
  const config: SurveyConfig = [
    makeRating("r1"),
    makeSelect("s1", ["Academia", "Physician"]),
    makeText("t1", false, 500),
  ];

  it("accepts a complete valid submission", () => {
    const result = validateAnswers(config, {
      r1: 4,
      s1: "Academia",
      t1: "Great event",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.answers).toEqual({ r1: 4, s1: "Academia", t1: "Great event" });
    }
  });

  it("strips unknown keys (config drift safety)", () => {
    const result = validateAnswers(config, {
      r1: 4,
      s1: "Academia",
      ghost: "not in config",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.answers).not.toHaveProperty("ghost");
    }
  });

  it("absent optional question is silently skipped (NOT written as null)", () => {
    const result = validateAnswers(config, { r1: 4, s1: "Academia" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.answers).not.toHaveProperty("t1");
      expect(Object.keys(result.answers)).toHaveLength(2);
    }
  });

  it("coerces a string rating to a number (HTML form sends strings)", () => {
    const result = validateAnswers(config, {
      r1: "3",
      s1: "Academia",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.answers.r1).toBe(3);
  });
});

describe("validateAnswers — rejections", () => {
  const config: SurveyConfig = [
    makeRating("r1"),
    makeSelect("s1", ["A", "B"]),
    makeText("t1", true),
  ];

  it("rejects missing required rating", () => {
    const result = validateAnswers(config, { s1: "A", t1: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/r1.*required/);
  });

  it("rejects out-of-range rating (6)", () => {
    const result = validateAnswers(config, { r1: 6, s1: "A", t1: "x" });
    expect(result.ok).toBe(false);
  });

  it("rejects rating below range (0)", () => {
    const result = validateAnswers(config, { r1: 0, s1: "A", t1: "x" });
    expect(result.ok).toBe(false);
  });

  it("rejects fractional rating (3.5)", () => {
    const result = validateAnswers(config, { r1: 3.5, s1: "A", t1: "x" });
    expect(result.ok).toBe(false);
  });

  it("rejects single_select value not in options (typo / tampering)", () => {
    const result = validateAnswers(config, { r1: 4, s1: "Mars", t1: "x" });
    expect(result.ok).toBe(false);
  });

  it("rejects text exceeding maxLength", () => {
    const cfg: SurveyConfig = [makeText("t1", true, 5)];
    const result = validateAnswers(cfg, { t1: "way too long" });
    expect(result.ok).toBe(false);
  });

  it("treats empty string as absent (so required check fires)", () => {
    const result = validateAnswers(config, { r1: 4, s1: "A", t1: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/t1.*required/);
  });

  it("reports ALL errors at once (form can show every bad field)", () => {
    const result = validateAnswers(config, { r1: 99, s1: "Mars" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("never accepts explicit null (rule: use absence, not null)", () => {
    const result = validateAnswers(config, { r1: null, s1: "A", t1: "x" });
    expect(result.ok).toBe(false);
  });
});
