/**
 * {{rsvpButton}}: the personal RSVP link as an email-safe button. Pins the
 * markup contract (href is the link, label is fixed, both strings escaped so
 * the block is safe to render raw), the empty-link rule, and the token
 * predicate both editors and every producer share.
 */
import { describe, it, expect } from "vitest";
import { buildRsvpButton, templateUsesRsvpToken } from "@/lib/rsvp/button";

describe("buildRsvpButton", () => {
  it("renders a button whose href is the personal link, with the RSVP named in the note", () => {
    const out = buildRsvpButton({ rsvpLink: "https://x.test/e/ev/rsvp/tok1", rsvpName: "Attendance" });
    expect(out.html).toContain('href="https://x.test/e/ev/rsvp/tok1"');
    expect(out.html).toContain(">RSVP now<");
    expect(out.html).toContain("for Attendance");
    expect(out.text).toBe("RSVP now (Attendance): https://x.test/e/ev/rsvp/tok1");
  });

  it("escapes the link and the name, so the block is safe to render raw", () => {
    const out = buildRsvpButton({ rsvpLink: 'https://x.test/?a=1&b="2"', rsvpName: "<b>Gala</b>" });
    expect(out.html).toContain('href="https://x.test/?a=1&amp;b=&quot;2&quot;"');
    expect(out.html).toContain("for &lt;b&gt;Gala&lt;/b&gt;");
    expect(out.html).not.toContain("<b>Gala</b>");
  });

  it("renders nothing for an empty link rather than a dead button", () => {
    expect(buildRsvpButton({ rsvpLink: "  ", rsvpName: "Attendance" })).toEqual({ html: "", text: "" });
  });
});

describe("templateUsesRsvpToken", () => {
  it("matches either exact token in any part", () => {
    expect(templateUsesRsvpToken("<p>{{rsvpButton}}</p>")).toBe(true);
    expect(templateUsesRsvpToken(null, undefined, "x {{rsvpLink}}")).toBe(true);
  });
  it("does not match spaced, url-encoded or other tokens", () => {
    expect(templateUsesRsvpToken("{{ rsvpButton }}", "%7B%7BrsvpLink%7D%7D", "{{rsvpName}}")).toBe(false);
    expect(templateUsesRsvpToken()).toBe(false);
  });
});
