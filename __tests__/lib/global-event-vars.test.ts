/**
 * Event variables are GLOBAL (owner rule, Aug 27 2026).
 *
 * WHAT WENT WRONG. Every sender hand-built its own variables object, and
 * `renderTemplate` deliberately leaves an unknown token in place rather than
 * blanking it. So a template using a token its particular sender happened not
 * to pass rendered the LITERAL `{{eventDate}}` in the delivered email.
 *
 * The organizer could not have caught it: the PREVIEW supplies event variables
 * for every slug, so it rendered correctly on screen and wrongly in the inbox.
 * That is the same preview/send divergence class as the Aug 12 `{{eventDateRange}}`
 * bug, and it shipped: Middle East Heart Failure 2027 mailed real abstract
 * authors "which will be held from {{eventDate}} at {{eventVenue}}".
 *
 * The fix rides on `branding` because that is the one object every sender
 * already threads from getEventTemplate into renderAndWrap. These tests pin the
 * PRECEDENCE, which is the part that could regress silently: a caller that
 * already builds its own eventDate must keep winning, or this "fix" would
 * quietly restyle dates in emails that were already correct.
 */
import { describe, it, expect } from "vitest";
import { renderAndWrap } from "@/lib/email";

const tpl = (body: string) => ({ subject: "S", htmlContent: body, textContent: body });
const branding = {
  eventVars: { eventName: "Global Event", eventDate: "Monday, March 1, 2027", eventVenue: "Global Hall, Dubai" },
};

describe("global event vars", () => {
  it("resolves an event token the caller never passed", () => {
    // The exact failure: the sender passes nothing, the template asks anyway.
    const out = renderAndWrap(tpl("<p>held from {{eventDate}} at {{eventVenue}}</p>"), {}, branding);
    expect(out.htmlContent).toContain("Monday, March 1, 2027");
    expect(out.htmlContent).toContain("Global Hall, Dubai");
    expect(out.htmlContent).not.toContain("{{eventDate}}");
    expect(out.htmlContent).not.toContain("{{eventVenue}}");
  });

  it("lets the caller's own value win", () => {
    // Load-bearing. Several senders already build eventDate themselves; if the
    // global block overrode them this change would silently restyle dates in
    // emails that were never broken.
    const out = renderAndWrap(tpl("<p>{{eventDate}}</p>"), { eventDate: "CALLER WINS" }, branding);
    expect(out.htmlContent).toContain("CALLER WINS");
    expect(out.htmlContent).not.toContain("Monday, March 1, 2027");
  });

  it("still renders the subject line from the global block", () => {
    const out = renderAndWrap(
      { subject: "Abstract for {{eventName}}", htmlContent: "x", textContent: "x" }, {}, branding);
    expect(out.subject).toBe("Abstract for Global Event");
  });

  it("fills the plain-text part too, not just the HTML", () => {
    // The text alternative is what a plain-text client shows, and it is rendered
    // by a different function — so it can drift from the HTML independently.
    const out = renderAndWrap(tpl("held at {{eventVenue}}"), {}, branding);
    expect(out.textContent).toContain("Global Hall, Dubai");
    expect(out.textContent).not.toContain("{{eventVenue}}");
  });

  it("changes nothing when branding carries no event block", () => {
    // Event-less senders (and the getDefaultTemplate fallback path) must behave
    // exactly as before rather than crash on a missing object.
    const out = renderAndWrap(tpl("<p>{{eventDate}}</p>"), {}, {});
    expect(out.htmlContent).toContain("{{eventDate}}");
  });

  it("keeps the organizerSignature default weakest of all", () => {
    // Precedence order is signature default < event block < caller.
    const out = renderAndWrap(tpl("<p>[{{organizerSignature}}]</p>"), {}, branding);
    expect(out.htmlContent).toContain("[]");
  });
});
