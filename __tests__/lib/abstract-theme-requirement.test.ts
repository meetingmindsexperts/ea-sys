import { describe, it, expect } from "vitest";
import { isThemeMissing, THEME_REQUIRED_CODE, THEME_REQUIRED_MESSAGE } from "@/lib/abstract-theme-requirement";

/**
 * Theme is mandatory to submit, but only when the event HAS themes.
 *
 * The conditional half is the whole point: themes are per-event and optional,
 * so an unconditional requirement would make submission impossible on an event
 * whose organiser never created any. Pinned here because that failure would be
 * total and would only appear on someone else's event.
 *
 * Four surfaces share this rule — the three submit forms and both write routes
 * — so it lives in one place and is asserted once.
 */
describe("abstract theme requirement", () => {
  it("requires a theme when the event has them and none is chosen", () => {
    expect(isThemeMissing(true, null)).toBe(true);
    expect(isThemeMissing(true, undefined)).toBe(true);
    expect(isThemeMissing(true, "")).toBe(true);
    expect(isThemeMissing(true, "   ")).toBe(true);
  });

  it("is satisfied once a theme is chosen", () => {
    expect(isThemeMissing(true, "theme_1")).toBe(false);
  });

  it("never blocks an event that has no themes", () => {
    // The case that would break submission entirely if the rule were absolute.
    expect(isThemeMissing(false, null)).toBe(false);
    expect(isThemeMissing(false, "")).toBe(false);
    expect(isThemeMissing(false, "theme_1")).toBe(false);
  });

  it("exposes one message and one code for every caller", () => {
    expect(THEME_REQUIRED_CODE).toBe("THEME_REQUIRED");
    expect(THEME_REQUIRED_MESSAGE).toMatch(/theme/i);
  });
});
