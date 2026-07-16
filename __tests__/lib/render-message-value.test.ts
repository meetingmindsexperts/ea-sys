/**
 * renderMessageValue (email.ts) — tokens typed INTO the compose-box message
 * resolve (July 16, 2026 organizer ask: "{{organizerSignature}} must auto-add
 * the signature from my profile"). renderTemplate is single-pass over the
 * TEMPLATE, so tokens inside a variable's value used to stay literal.
 *
 * Uses the REAL email module — the escaping behavior IS the contract.
 */
import { describe, it, expect } from "vitest";
import { renderMessageValue } from "@/lib/email";

const SIGNATURE = '<p><strong>Dr. K</strong><br/>MMG</p>';
const RAW = new Set(["organizerSignature", "message", "personalMessage"]);

describe("renderMessageValue", () => {
  it("escapes literal plain text (dashboard Textarea contract)", () => {
    expect(renderMessageValue('Hello <b>&</b> "world"', {})).toBe(
      "Hello &lt;b&gt;&amp;&lt;/b&gt; &quot;world&quot;",
    );
  });

  it("keeps already-HTML messages as-is when isHtml (the MCP A1 contract)", () => {
    expect(renderMessageValue("<p>Body</p>", {}, { isHtml: true })).toBe("<p>Body</p>");
  });

  it("resolves {{organizerSignature}} to raw signature HTML inside a plain-text message", () => {
    const out = renderMessageValue(
      "Best regards,\n{{organizerSignature}}",
      { organizerSignature: SIGNATURE },
      { rawHtmlKeys: RAW },
    );
    expect(out).toBe(`Best regards,\n${SIGNATURE}`);
  });

  it("substitutes escaped-value tokens escaped ({{firstName}} carrying markup cannot inject)", () => {
    const out = renderMessageValue(
      "Dear {{firstName}}",
      { firstName: '<img src=x onerror="x">' },
      { rawHtmlKeys: RAW },
    );
    expect(out).toBe("Dear &lt;img src=x onerror=&quot;x&quot;&gt;");
  });

  it("leaves an unknown token literal (matches renderTemplate semantics)", () => {
    expect(renderMessageValue("Hi {{noSuchToken}}", {})).toBe("Hi {{noSuchToken}}");
  });

  it("never recurses into itself — {{message}}/{{personalMessage}} typed in a message stay literal", () => {
    const out = renderMessageValue(
      "{{message}} {{personalMessage}}",
      { message: "SELF", personalMessage: "SELF" },
      { rawHtmlKeys: RAW },
    );
    expect(out).toBe("{{message}} {{personalMessage}}");
  });

  it("resolves tokens inside an isHtml message too (MCP body with a signature token)", () => {
    const out = renderMessageValue(
      "<p>Regards</p>{{organizerSignature}}",
      { organizerSignature: SIGNATURE },
      { isHtml: true, rawHtmlKeys: RAW },
    );
    expect(out).toBe(`<p>Regards</p>${SIGNATURE}`);
  });
});
