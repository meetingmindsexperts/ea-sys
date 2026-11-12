import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EmailCopies } from "@/components/communications/email-copies";

/**
 * The Cc and Bcc lines under a sent email's "To" (Nov 12, 2026). Four places
 * show a logged email; the sweep below fails if one of them shows "To" without
 * also saying who was copied.
 */
const render = (props: Parameters<typeof EmailCopies>[0]) => renderToStaticMarkup(createElement(EmailCopies, props));

describe("EmailCopies", () => {
  it("renders nothing when the email had no cc and no bcc", () => {
    expect(render({ cc: null, bcc: null })).toBe("");
    expect(render({})).toBe("");
    expect(render({ cc: "", bcc: "" })).toBe("");
  });

  it("shows the cc line alone, as sent", () => {
    const html = render({ cc: "a@x.com, b@x.com", bcc: null });
    expect(html).toContain("Cc a@x.com, b@x.com");
    expect(html).not.toContain("Bcc");
  });

  it("shows the bcc line alone", () => {
    const html = render({ cc: null, bcc: "boss@x.com" });
    expect(html).toContain("Bcc boss@x.com");
    expect(html).not.toContain("Cc ");
  });

  it("shows cc first, then bcc, each on its own line", () => {
    const html = render({ cc: "a@x.com", bcc: "b@x.com" });
    expect(html.indexOf("Cc a@x.com")).toBeGreaterThan(-1);
    expect(html.indexOf("Bcc b@x.com")).toBeGreaterThan(html.indexOf("Cc a@x.com"));
    expect(html.match(/class="block /g)).toHaveLength(2);
  });

  it("escapes what it shows", () => {
    expect(render({ cc: "<script>x</script>@x.com" })).not.toContain("<script>");
  });
});

describe("every place that shows a logged email's To also shows who was copied", () => {
  const SURFACES = [
    "src/components/communications/email-log-card.tsx",
    "src/components/communications/email-activity-card.tsx",
    "src/components/communications/view-email-dialog.tsx",
    "src/components/activity/activity-timeline-card.tsx",
  ];

  it.each(SURFACES)("%s renders EmailCopies with both cc and bcc", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src).toMatch(/<EmailCopies\s+cc=\{[^}]+\}\s+bcc=\{[^}]+\}/);
  });
});
