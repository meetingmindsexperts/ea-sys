/**
 * Unit tests for src/lib/survey/share-link.ts — the organizer-generated
 * shareable survey link helpers. The load-bearing case is
 * isShareLinkValid(): it gates reaching the public form via the
 * reusable `?share=` token, so its valid/expired/mismatch/wrong-length
 * branches must each behave exactly. Token comparison is timing-safe
 * (crypto.timingSafeEqual) and must never throw on a length mismatch.
 */

import { describe, it, expect } from "vitest";
import {
  SURVEY_EXPIRY_DAYS,
  surveyExpiryDaysSchema,
  surveyShareLinkSchema,
  readSurveyShareLink,
  generateShareToken,
  isShareLinkValid,
  buildShareUrl,
  buildShareLinkRecord,
  DEFAULT_SURVEY_EXPIRY_DAYS,
} from "@/lib/survey/share-link";

const T0 = new Date("2026-06-09T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("surveyExpiryDaysSchema", () => {
  it("accepts 3/5/7/10 and rejects anything else", () => {
    for (const d of SURVEY_EXPIRY_DAYS) {
      expect(surveyExpiryDaysSchema.safeParse(d).success).toBe(true);
    }
    for (const bad of [0, 1, 4, 6, 14, 30, -7, "7"]) {
      expect(surveyExpiryDaysSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("default is 7", () => {
    expect(DEFAULT_SURVEY_EXPIRY_DAYS).toBe(7);
  });
});

describe("generateShareToken", () => {
  it("returns a 64-char hex string and is unique per call", () => {
    const a = generateShareToken();
    const b = generateShareToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe("buildShareLinkRecord", () => {
  it("sets expiresAt to now + N days and stamps createdBy", () => {
    const rec = buildShareLinkRecord(5, "user_123", T0);
    expect(rec.createdByUserId).toBe("user_123");
    expect(rec.createdAt).toBe(T0.toISOString());
    expect(new Date(rec.expiresAt).getTime()).toBe(T0.getTime() + 5 * DAY);
    expect(rec.token).toMatch(/^[0-9a-f]{64}$/);
    // Round-trips through the stored-shape schema.
    expect(surveyShareLinkSchema.safeParse(rec).success).toBe(true);
  });
});

describe("readSurveyShareLink", () => {
  it("returns null for null/undefined/garbage and parses a valid record", () => {
    expect(readSurveyShareLink(null)).toBeNull();
    expect(readSurveyShareLink(undefined)).toBeNull();
    expect(readSurveyShareLink({ token: "x" })).toBeNull(); // missing fields
    expect(readSurveyShareLink("nope")).toBeNull();
    const rec = buildShareLinkRecord(7, "u", T0);
    expect(readSurveyShareLink(rec)?.token).toBe(rec.token);
  });
});

describe("isShareLinkValid", () => {
  it("ok=true for a matching, unexpired token", () => {
    const rec = buildShareLinkRecord(7, "u", T0);
    const res = isShareLinkValid(rec, rec.token, new Date(T0.getTime() + DAY));
    expect(res.ok).toBe(true);
  });

  it("reason=none when no link is stored", () => {
    const res = isShareLinkValid(null, "anything", T0);
    expect(res).toEqual({ ok: false, reason: "none" });
  });

  it("reason=mismatch for a wrong token of equal length", () => {
    const rec = buildShareLinkRecord(7, "u", T0);
    const wrong = "f".repeat(rec.token.length);
    const res = isShareLinkValid(rec, wrong, T0);
    expect(res).toEqual({ ok: false, reason: "mismatch" });
  });

  it("reason=mismatch (never throws) for a different-length token", () => {
    const rec = buildShareLinkRecord(7, "u", T0);
    // timingSafeEqual throws on unequal buffer lengths — the length
    // guard must convert that into a clean mismatch, not a 500.
    const res = isShareLinkValid(rec, "short", T0);
    expect(res).toEqual({ ok: false, reason: "mismatch" });
  });

  it("reason=mismatch for a missing/empty provided token", () => {
    const rec = buildShareLinkRecord(7, "u", T0);
    expect(isShareLinkValid(rec, "", T0)).toEqual({ ok: false, reason: "mismatch" });
    expect(isShareLinkValid(rec, null, T0)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("reason=expired exactly at and after expiry", () => {
    const rec = buildShareLinkRecord(3, "u", T0);
    const atExpiry = new Date(T0.getTime() + 3 * DAY);
    const afterExpiry = new Date(T0.getTime() + 3 * DAY + 1);
    expect(isShareLinkValid(rec, rec.token, atExpiry)).toEqual({ ok: false, reason: "expired" });
    expect(isShareLinkValid(rec, rec.token, afterExpiry)).toEqual({ ok: false, reason: "expired" });
  });

  it("checks the token BEFORE expiry (wrong token on an expired link → mismatch)", () => {
    const rec = buildShareLinkRecord(3, "u", T0);
    const afterExpiry = new Date(T0.getTime() + 10 * DAY);
    const wrong = "0".repeat(rec.token.length);
    expect(isShareLinkValid(rec, wrong, afterExpiry)).toEqual({ ok: false, reason: "mismatch" });
  });
});

describe("buildShareUrl", () => {
  it("composes the public share URL", () => {
    expect(buildShareUrl("https://x.test", "my-event", "abc")).toBe(
      "https://x.test/e/my-event/survey?share=abc",
    );
  });
});
