/**
 * Block tokens that are OUR markup render raw by default, whatever the caller
 * remembered to list (September 18, 2026). The automatic abstract decision
 * email called renderAndWrap with no raw keys while buildAbstractDecisionVars
 * handed it a <div>; the bulk resend listed the key and rendered the box, the
 * automatic path delivered escaped source. This pins the automatic path's
 * exact call shape: the default template, the builder's vars, NO caller keys.
 */
import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn() }));
vi.mock("@/lib/travel-grant/server", () => ({ resolveTravelGrantBlock: vi.fn() }));
import { renderTemplate, getDefaultTemplate } from "@/lib/email";
import { buildAbstractDecisionVars } from "@/lib/abstract-notifications";

describe("DEFAULT_RAW_HTML_KEYS covers the block builders", () => {
  it("the automatic decision email renders the reviewer-notes box, not its source", () => {
    const tpl = getDefaultTemplate("abstract-status-update");
    expect(tpl).toBeTruthy();
    const vars = { ...buildAbstractDecisionVars({ status: "ACCEPTED", reviewNotes: "Good <work>", reviewScore: 80 }), eventName: "E", firstName: "A", lastName: "B", title: "Dr.", abstractTitle: "T", loginLink: "#", organizerSignature: "" };
    const html = renderTemplate(tpl!.htmlContent, vars);
    expect(html).toContain('<div style="background: #e0f2fe');
    expect(html).toContain("<strong>Reviewer Notes:</strong>");
    expect(html).toContain("Good &lt;work&gt;");
    expect(html).not.toContain("&lt;div");
  });

  it.each(["reviewNotes", "claimSummary", "presenterFeeBlock"])("%s is raw without a caller key", (key) => {
    const html = renderTemplate(`<p>x</p>{{${key}}}`, { [key]: "<table><tr><td>1</td></tr></table>" });
    expect(html).toContain("<table><tr><td>1</td></tr></table>");
  });

  it("a free-text value is still escaped", () => {
    expect(renderTemplate("{{firstName}}", { firstName: "<b>x</b>" })).toBe("&lt;b&gt;x&lt;/b&gt;");
  });
});
