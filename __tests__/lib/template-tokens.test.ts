/**
 * Template tokens (Sep 11, 2026): the one place that says what a token is.
 * Pins the normaliser against the exact shapes the editor produced in
 * production ({{<span>rsvpButton</span>}} shipped literally on OOPVF2026)
 * and the unresolved-token finder sendEmail refuses on.
 */
import { describe, it, expect } from "vitest";
import { findUnresolvedTokens, normalizeTemplateTokens } from "@/lib/template-tokens";

describe("normalizeTemplateTokens", () => {
  it("collapses the production case: a token whose word the editor wrapped in a span", () => {
    expect(normalizeTemplateTokens("Studio 1 {{<span>rsvpButton</span>}}</p>")).toBe("Studio 1 {{rsvpButton}}</p>");
  });
  it("collapses a token split by bold, a token with tags around the braces, spaces, and nbsp", () => {
    expect(normalizeTemplateTokens("{{rsvp<strong>Button</strong>}}")).toBe("{{rsvpButton}}");
    expect(normalizeTemplateTokens("<span>{{</span>firstName<span>}}</span>")).toBe("<span>{{firstName}}</span>");
    expect(normalizeTemplateTokens("{{ eventName }}")).toBe("{{eventName}}");
    expect(normalizeTemplateTokens("{{rsvpLink&nbsp;}}")).toBe("{{rsvpLink}}");
    expect(normalizeTemplateTokens("{{first Name}}")).toBe("{{firstName}}");
  });
  it("leaves clean tokens, non-token braces and brace-free text exactly as they are", () => {
    expect(normalizeTemplateTokens("<p>{{rsvpButton}} and {{firstName}}</p>")).toBe("<p>{{rsvpButton}} and {{firstName}}</p>");
    expect(normalizeTemplateTokens("{{ }} {{a-b}} {{a.b}}")).toBe("{{ }} {{a-b}} {{a.b}}");
    expect(normalizeTemplateTokens("no tokens here")).toBe("no tokens here");
    expect(normalizeTemplateTokens("")).toBe("");
  });
});

describe("findUnresolvedTokens", () => {
  it("returns the remaining token names once each, in order, across parts", () => {
    expect(findUnresolvedTokens("Hi {{firstName}}", "<p>{{rsvpButton}} {{firstName}}</p>")).toEqual(["firstName", "rsvpButton"]);
  });
  it("reports a mangled remnant by its name, not its markup", () => {
    expect(findUnresolvedTokens("{{<span>rsvpButton</span>}}")).toEqual(["rsvpButton"]);
    expect(findUnresolvedTokens("{{ sessiondetails&nbsp;}}")).toEqual(["sessiondetails"]);
  });
  it("finds nothing in rendered output, empty or missing parts", () => {
    expect(findUnresolvedTokens("<p>Dear Jane,</p>", null, undefined, "")).toEqual([]);
    expect(findUnresolvedTokens()).toEqual([]);
  });
});
