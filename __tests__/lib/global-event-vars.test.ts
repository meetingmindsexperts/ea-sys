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

/**
 * The other half: the tokens must be DISCOVERABLE, not just functional.
 *
 * The runtime fix shipped first and the editor still listed twelve tokens for
 * abstract-submission-confirmation, none of them the event date — so an
 * organizer looking at the "Available variables" panel concluded, reasonably,
 * that it was not available. Working but undiscoverable is not available.
 */
describe("the editor advertises the global block on every slug", () => {
  it("lists the event tokens for a slug that never declared them", async () => {
    const { templateVariablesFor } = await import("@/lib/email");
    const keys = templateVariablesFor("abstract-submission-confirmation").map((v) => v.key);
    for (const k of ["eventName", "eventDate", "eventDateRange", "eventVenue"]) {
      expect(keys).toContain(k);
    }
  });

  it("advertises them for EVERY slug, not a hand-picked few", async () => {
    // The point of merging rather than pasting: adding the next global token
    // must not mean 25 edits with one of them missed.
    const { TEMPLATE_VARIABLES, templateVariablesFor } = await import("@/lib/email");
    for (const slug of Object.keys(TEMPLATE_VARIABLES)) {
      const keys = templateVariablesFor(slug).map((v) => v.key);
      expect(keys, `slug ${slug}`).toContain("eventDate");
      expect(keys, `slug ${slug}`).toContain("eventVenue");
    }
  });

  it("never lists a key twice, and the slug's own description wins", async () => {
    // registration-confirmation already declares eventDate with its own
    // wording; the merge must not produce a duplicate chip in the panel.
    const { templateVariablesFor, TEMPLATE_VARIABLES } = await import("@/lib/email");
    const own = (TEMPLATE_VARIABLES["registration-confirmation"] ?? []).find((v) => v.key === "eventDate");
    const merged = templateVariablesFor("registration-confirmation");
    expect(merged.filter((v) => v.key === "eventDate")).toHaveLength(1);
    if (own) expect(merged.find((v) => v.key === "eventDate")?.description).toBe(own.description);
  });

  it("an unknown slug still gets the global block rather than nothing", async () => {
    const { templateVariablesFor } = await import("@/lib/email");
    expect(templateVariablesFor("no-such-slug").map((v) => v.key)).toContain("eventDate");
  });
});
