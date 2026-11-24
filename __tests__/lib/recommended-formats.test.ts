/**
 * A reviewer's recommended format follows the event's presentation types
 * (Content, Abstracts), plus Neither (Nov 10, 2026). Since Nov 24, 2026 the
 * types and their names are the organisation's.
 */
import { describe, it, expect } from "vitest";
import { recommendableFormats, recommendedFormatLabel } from "@/lib/recommended-formats";
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

  it("offers only what can be stored until step 4: an organisation's own type is not offered to a reviewer yet", () => {
    const own = readPresentationTypes({ presentationTypes: [{ key: "SYMPOSIUM", label: "Symposium" }] });
    expect(recommendableFormats({ abstractPresentationTypes: ["SYMPOSIUM", "ORAL"] }, own)).toEqual(["ORAL", "NEITHER"]);
  });
});
