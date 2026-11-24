/**
 * A reviewer's recommended format follows the event's presentation types
 * (Content, Abstracts), plus Neither (Nov 10, 2026). Since Nov 24, 2026 the
 * types and their names are the organisation's.
 */
import { describe, it, expect } from "vitest";
import { recommendableFormats, recommendedFormatLabel, recommendedFormatSchema } from "@/lib/recommended-formats";
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
