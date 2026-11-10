/**
 * A reviewer's recommended format follows the event's presentation types
 * (Content, Abstracts), plus Neither (Nov 10, 2026).
 */
import { describe, it, expect } from "vitest";
import { recommendableFormats } from "@/lib/recommended-formats";

describe("recommendableFormats", () => {
  it("an event that never narrowed its types offers every format", () => {
    expect(recommendableFormats({})).toEqual(["ORAL", "POSTER", "VIDEO", "WORKSHOP", "NEITHER"]);
    expect(recommendableFormats(null)).toEqual(["ORAL", "POSTER", "VIDEO", "WORKSHOP", "NEITHER"]);
  });

  it("an oral-only event cannot be recommended for a poster", () => {
    expect(recommendableFormats({ abstractPresentationTypes: ["ORAL"] })).toEqual(["ORAL", "NEITHER"]);
  });

  it("Oral or Poster stands for both", () => {
    expect(recommendableFormats({ abstractPresentationTypes: ["ORAL_POSTER"] })).toEqual(["ORAL", "POSTER", "NEITHER"]);
  });

  it("Video and Workshop can be recommended when the event takes them", () => {
    expect(recommendableFormats({ abstractPresentationTypes: ["VIDEO", "WORKSHOP"] })).toEqual(["VIDEO", "WORKSHOP", "NEITHER"]);
  });
});
