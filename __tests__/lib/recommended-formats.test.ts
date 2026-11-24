/**
 * A reviewer's recommended format follows the event's presentation types
 * (Content, Abstracts), plus Neither (Nov 10, 2026). Since Nov 24, 2026 the
 * types and their names are the organisation's.
 */
import { describe, it, expect } from "vitest";
import { recommendableFormats, recommendedFormatLabel, recommendedFormatSchema, resolveWrittenRecommendation } from "@/lib/recommended-formats";
import { defaultPresentationTypes, readPresentationTypes } from "@/lib/abstract-presentation-types";

const DEFAULTS = defaultPresentationTypes();

describe("recommendableFormats", () => {
  it("an event that never narrowed its types offers every format", () => {
    expect(recommendableFormats({}, DEFAULTS)).toEqual(["ORAL", "POSTER", "VIDEO", "WORKSHOP", "NEITHER"]);
    expect(recommendableFormats(null, DEFAULTS)).toEqual(["ORAL", "POSTER", "VIDEO", "WORKSHOP", "NEITHER"]);
  });

  it("an oral-only event cannot be recommended for a poster", () => {
    expect(recommendableFormats({ abstractPresentationTypes: ["ORAL"] }, DEFAULTS)).toEqual(["ORAL", "NEITHER"]);
  });

  it("Oral or Poster stands for both, even renamed and with Oral and Poster not offered on their own", () => {
    expect(recommendableFormats({ abstractPresentationTypes: ["ORAL_POSTER"] }, DEFAULTS)).toEqual(["ORAL", "POSTER", "NEITHER"]);
    const renamed = readPresentationTypes({ presentationTypes: [{ key: "ORAL_POSTER", label: "Either" }] });
    expect(recommendableFormats({ abstractPresentationTypes: ["ORAL_POSTER"] }, renamed)).toEqual(["ORAL", "POSTER", "NEITHER"]);
  });

  it("Video and Workshop can be recommended when the event takes them", () => {
    expect(recommendableFormats({ abstractPresentationTypes: ["VIDEO", "WORKSHOP"] }, DEFAULTS)).toEqual(["VIDEO", "WORKSHOP", "NEITHER"]);
  });

  it("a recommendation is named as the organisation names the type", () => {
    const renamed = readPresentationTypes({ presentationTypes: [{ key: "POSTER", label: "E-poster" }] });
    expect(recommendedFormatLabel(renamed, "POSTER")).toBe("E-poster");
    expect(recommendedFormatLabel(renamed, "NEITHER")).toBe("Neither");
    expect(recommendedFormatLabel(renamed, null)).toBe("");
  });

  // Step 4 (Nov 24, 2026): an organisation's own type is recommended like a built-in.
  it("offers an organisation's own type where the event offers it", () => {
    const own = readPresentationTypes({ presentationTypes: [{ key: "SYMPOSIUM", label: "Symposium" }] });
    expect(recommendableFormats({ abstractPresentationTypes: ["SYMPOSIUM", "ORAL"] }, own)).toEqual(["ORAL", "SYMPOSIUM", "NEITHER"]);
    expect(recommendedFormatLabel(own, "SYMPOSIUM")).toBe("Symposium");
  });

  it("the either-way choice never stands for a type the organisation retired", () => {
    const oralRetired = readPresentationTypes({ presentationTypes: [{ key: "ORAL", label: "Oral", retired: true }] });
    expect(recommendableFormats({ abstractPresentationTypes: ["ORAL_POSTER"] }, oralRetired)).toEqual(["POSTER", "NEITHER"]);
  });

  it("a door takes a key's shape; NEITHER is one, a sentence is not", () => {
    expect(recommendedFormatSchema.safeParse("SYMPOSIUM").success).toBe(true);
    expect(recommendedFormatSchema.safeParse("NEITHER").success).toBe(true);
    expect(recommendedFormatSchema.safeParse("a symposium").success).toBe(false);
  });
});

describe("resolveWrittenRecommendation (step 5: the assistant writes a name or a key)", () => {
  const own = readPresentationTypes({
    presentationTypes: [
      { key: "CASE_REPORT", label: "Case report" },
      { key: "SYMPOSIUM", label: "Panel discussion" },
      { key: "POSTER", label: "E-poster" },
    ],
  });

  it("reads a key or a name in any case and spacing", () => {
    expect(resolveWrittenRecommendation("CASE_REPORT", own)).toBe("CASE_REPORT");
    expect(resolveWrittenRecommendation("case report", own)).toBe("CASE_REPORT");
    expect(resolveWrittenRecommendation("  Case   Report ", own)).toBe("CASE_REPORT");
    expect(resolveWrittenRecommendation("oral", own)).toBe("ORAL");
  });

  it("a renamed type is found by its new name and its old key", () => {
    expect(resolveWrittenRecommendation("Panel discussion", own)).toBe("SYMPOSIUM");
    expect(resolveWrittenRecommendation("symposium", own)).toBe("SYMPOSIUM");
    expect(resolveWrittenRecommendation("E-poster", own)).toBe("POSTER");
  });

  it("Neither in any case", () => {
    expect(resolveWrittenRecommendation("neither", own)).toBe("NEITHER");
    expect(resolveWrittenRecommendation("NEITHER", own)).toBe("NEITHER");
  });

  it("a renamed type's old name, now another type's, is ambiguous and passed on to be refused (review of 33d5aa63f)", () => {
    const reused = readPresentationTypes({
      presentationTypes: [
        { key: "POSTER", label: "E-poster" },
        { key: "POSTER_2", label: "Poster" },
        { key: "CASE_REPORT", label: "Clinical case" },
        { key: "CASE_REPORT_2", label: "Case report" },
      ],
    });
    expect(resolveWrittenRecommendation("Poster", reused)).toBe("Poster");
    expect(resolveWrittenRecommendation("Case report", reused)).toBe("Case report");
    // A key as written, or the current name with no other claim on it, is never ambiguous.
    expect(resolveWrittenRecommendation("POSTER", reused)).toBe("POSTER");
    expect(resolveWrittenRecommendation("POSTER_2", reused)).toBe("POSTER_2");
    expect(resolveWrittenRecommendation("clinical case", reused)).toBe("CASE_REPORT");
    // "Oral Poster" names an own type and has the shape of the built-in's key: refused with the list, then sent by key.
    const oralPoster = readPresentationTypes({ presentationTypes: [{ key: "ORAL_POSTER_2", label: "Oral Poster" }] });
    expect(resolveWrittenRecommendation("Oral Poster", oralPoster)).toBe("Oral Poster");
    expect(resolveWrittenRecommendation("ORAL_POSTER_2", oralPoster)).toBe("ORAL_POSTER_2");
  });

  it("passes on what matches nothing, and Oral or Poster, for the review service to refuse with the choices", () => {
    expect(resolveWrittenRecommendation("Keynote", own)).toBe("Keynote");
    expect(resolveWrittenRecommendation("Oral or Poster", own)).toBe("ORAL_POSTER");
  });
});
