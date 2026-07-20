/**
 * {{organizerSignature}} rollout (July 16, 2026, owner request) — the token
 * now lives in (almost) every default template, so two properties become
 * load-bearing and are pinned here against the REAL email module:
 *
 *   1. renderAndWrap defaults the var to "" — a template carrying the token
 *      sent from an automated path (no human sender) renders NOTHING, never
 *      the literal `{{organizerSignature}}` text.
 *   2. A provided signature renders RAW (organizerSignature is in
 *      DEFAULT_RAW_HTML_KEYS — it is always the sender's OWN profile Tiptap
 *      HTML, never recipient-controlled).
 *   3. Template coverage: every default template EXCEPT the pure-transactional
 *      ones (payment-confirmation, refund-confirmation — owner decision) and
 *      certificate-bundle-delivery (rendered by the certificate token
 *      pipeline, which has its own resolver) carries the token, in BOTH the
 *      html and text bodies. A new template without it fails this test —
 *      add the token or add the slug to the exclusion list deliberately.
 */
import { describe, it, expect } from "vitest";
import {
  renderAndWrap,
  getDefaultTemplate,
  getSamplePreviewVariables,
  DEFAULT_TEMPLATES,
} from "@/lib/email";

const TOKEN = "{{organizerSignature}}";
const EXCLUDED_SLUGS = new Set([
  "payment-confirmation", // transactional — fired by the Stripe webhook, no human sender
  "refund-confirmation", // transactional
  "certificate-bundle-delivery", // rendered by the certificate cover pipeline (own token resolver)
  "document-delivery", // transactional — invoice/receipt/credit-note PDF carrier, no human sender
  "speaker-reimbursement-received", // transactional — automated submit confirmation, no human sender
]);

const BRANDING = { eventName: "OSH" };

describe("{{organizerSignature}} — render safety", () => {
  const tpl = {
    subject: "Hi {{firstName}}",
    htmlContent: "<p>Dear {{firstName}},</p>{{organizerSignature}}",
    textContent: "Dear {{firstName}},\n\n{{organizerSignature}}",
  };

  it("renders as NOTHING (not the literal token) when no var is provided — automated senders", () => {
    const out = renderAndWrap(tpl, { firstName: "Ana" }, BRANDING);
    expect(out.htmlContent).not.toContain(TOKEN);
    expect(out.textContent).not.toContain(TOKEN);
    expect(out.textContent).toBe("Dear Ana,\n\n");
  });

  it("renders a provided signature RAW (profile Tiptap HTML, default raw key)", () => {
    const out = renderAndWrap(
      tpl,
      { firstName: "Ana", organizerSignature: "<p><strong>Dr. K</strong></p>" },
      BRANDING,
    );
    expect(out.htmlContent).toContain("<strong>Dr. K</strong>");
    expect(out.htmlContent).not.toContain("&lt;strong&gt;");
  });
});

describe("{{organizerSignature}} — default-template coverage", () => {
  for (const template of DEFAULT_TEMPLATES) {
    const shouldCarry = !EXCLUDED_SLUGS.has(template.slug);
    it(`${template.slug} ${shouldCarry ? "carries" : "deliberately OMITS"} the token`, () => {
      expect(template.htmlContent.includes(TOKEN)).toBe(shouldCarry);
      expect(template.textContent.includes(TOKEN)).toBe(shouldCarry);
    });
  }

  it("the registration-confirmation sender is var-safe (getDefaultTemplate resolves the token-bearing body)", () => {
    // sendRegistrationConfirmation renders via renderTemplate directly (not
    // renderAndWrap) — it sets organizerSignature: "" in its own vars; this
    // pin just asserts the template it loads really carries the token now.
    const tpl = getDefaultTemplate("registration-confirmation");
    expect(tpl?.htmlContent).toContain(TOKEN);
  });

  it("the preview/test-send sample vars carry a sample signature (no literal token in previews)", () => {
    expect(String(getSamplePreviewVariables().organizerSignature)).toContain("<p>");
  });
});
