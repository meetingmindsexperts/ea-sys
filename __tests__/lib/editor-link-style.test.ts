import { describe, expect, it } from "vitest";
import { LINK_DEFAULT_STYLE, linkStyle } from "@/lib/editor-link-style";

/**
 * A link in the email editor keeps its own style (Nov 18, 2026): every link
 * was given the cerulean one, so the red agenda link in the MEHFC 2027
 * invitations turned blue on reopening and was saved blue by the next visual
 * edit.
 */
describe("linkStyle", () => {
  it("keeps a link's own colour and decoration as written", () => {
    const red = "color: #FF0000; font-weight: bold; text-decoration: underline;";
    expect(linkStyle(red)).toBe(red);
  });

  it("gives a link with no style the cerulean default", () => {
    expect(linkStyle(null)).toBe(LINK_DEFAULT_STYLE);
    expect(linkStyle("  ")).toBe(LINK_DEFAULT_STYLE);
  });

  it("fills in only what the link does not set, its own declarations last", () => {
    expect(linkStyle("font-weight: 700")).toBe("color: #00aade; text-decoration: underline; font-weight: 700");
    expect(linkStyle("color: white; background: #00aade")).toBe("text-decoration: underline; color: white; background: #00aade");
  });

  it("does not take background-color for a colour", () => {
    expect(linkStyle("background-color: #000")).toMatch(/^color: #00aade;/);
  });

  it("leaves a value with a colon in it whole, and is stable when rendered again", () => {
    const button = "display: inline-block; background: url(https://x.example/a.png); color: #fff; text-decoration: none";
    expect(linkStyle(button)).toBe(button);
    const once = linkStyle("font-weight: 700");
    expect(linkStyle(once)).toBe(once);
  });
});
