/**
 * Unit tests for the responsive-image plumbing in src/lib/email.ts.
 *
 * Pins three contracts:
 *   1. wrapWithBranding emits header + footer images with the
 *      Outlook-friendly `width="600"` HTML attribute alongside the
 *      `max-width: 600px` CSS — the combination is what makes the
 *      images render at email-body width across Outlook desktop +
 *      Apple Mail + Gmail.
 *   2. The footer image sits between the body content and the
 *      footer-text block in source order.
 *   3. normalizeBodyImages rewrites Tiptap-style <img> tags to the
 *      canonical attribute set, strips any organizer-set width that
 *      would overflow the 600px body, and is idempotent.
 */

import { describe, it, expect } from "vitest";
import { normalizeBodyImages, wrapWithBranding } from "@/lib/email";

describe("normalizeBodyImages", () => {
  it("adds width=600 + border=0 + responsive style to a bare <img>", () => {
    const out = normalizeBodyImages('<p>hello</p><img src="https://x.test/a.png" alt="A" /><p>tail</p>');
    expect(out).toMatch(/<img[^>]+width="600"/);
    expect(out).toMatch(/<img[^>]+border="0"/);
    expect(out).toMatch(/<img[^>]+style="display: block; width: 100%; max-width: 600px;/);
    expect(out).toMatch(/src="https:\/\/x\.test\/a\.png"/);
    expect(out).toMatch(/alt="A"/);
  });

  it("strips an organizer-set inline width that would overflow the body", () => {
    const out = normalizeBodyImages(
      '<img src="x.png" width="2000" style="width: 2000px; height: 800px;" />'
    );
    // Result should have width="600", NOT width="2000"; the inline
    // style should be the canonical responsive one, not the
    // overflowing one.
    expect(out).toMatch(/width="600"/);
    expect(out).not.toMatch(/width="2000"/);
    expect(out).not.toMatch(/width: 2000px/);
    expect(out).toMatch(/max-width: 600px/);
  });

  it("preserves attributes other than width / border / style (src, alt, data-*)", () => {
    const out = normalizeBodyImages(
      '<img src="x.png" alt="logo" data-tiptap-id="abc" class="my-img" />'
    );
    expect(out).toMatch(/src="x\.png"/);
    expect(out).toMatch(/alt="logo"/);
    expect(out).toMatch(/data-tiptap-id="abc"/);
    expect(out).toMatch(/class="my-img"/);
  });

  it("is idempotent — re-running on already-normalized HTML produces identical output", () => {
    const once = normalizeBodyImages('<img src="x.png" alt="A" />');
    const twice = normalizeBodyImages(once);
    expect(twice).toBe(once);
  });

  it("handles single-quoted attributes too", () => {
    const out = normalizeBodyImages("<img src='x.png' width='1200' style='width: 1200px;' />");
    expect(out).toMatch(/width="600"/);
    expect(out).not.toMatch(/width: 1200px/);
  });

  it("rewrites multiple <img> tags in one pass", () => {
    const out = normalizeBodyImages(
      '<p>before</p><img src="a.png" /><p>middle</p><img src="b.png" width="100" /><p>after</p>'
    );
    const matches = out.match(/<img[^>]+width="600"/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("leaves HTML without <img> tags untouched", () => {
    const html = "<p>just text</p><div>and a div</div>";
    expect(normalizeBodyImages(html)).toBe(html);
  });
});

describe("wrapWithBranding — responsive header + footer images", () => {
  it("emits the header image with width=600 + border=0 + responsive style", () => {
    const out = wrapWithBranding("<p>body</p>", {
      eventName: "Test Event",
      emailHeaderImage: "https://cdn.test/banner.png",
    });
    expect(out).toMatch(/<img[^>]+src="https:\/\/cdn\.test\/banner\.png"[^>]+width="600"/);
    expect(out).toMatch(/<img[^>]+border="0"/);
    expect(out).toMatch(/max-width: 600px/);
  });

  it("emits a footer image when emailFooterImage is set", () => {
    const out = wrapWithBranding("<p>body</p>", {
      eventName: "Test Event",
      emailFooterImage: "https://cdn.test/footer.png",
    });
    expect(out).toMatch(/<img[^>]+src="https:\/\/cdn\.test\/footer\.png"[^>]+width="600"/);
  });

  it("renders the footer image AFTER the body and BEFORE the footer text", () => {
    const out = wrapWithBranding("<p>BODY_MARKER</p>", {
      eventName: "Test",
      emailFooterImage: "https://cdn.test/footer.png",
    });
    const bodyIdx = out.indexOf("BODY_MARKER");
    const footerImgIdx = out.indexOf("https://cdn.test/footer.png");
    const footerTextIdx = out.indexOf("This email was sent regarding");
    expect(bodyIdx).toBeGreaterThan(-1);
    expect(footerImgIdx).toBeGreaterThan(bodyIdx);
    expect(footerTextIdx).toBeGreaterThan(footerImgIdx);
  });

  it("does NOT render either image block when both are absent", () => {
    const out = wrapWithBranding("<p>body</p>", { eventName: "Test" });
    expect(out).not.toMatch(/<img\b/);
  });

  it("normalizes <img> in the body too — Tiptap-inserted images get the responsive treatment", () => {
    const out = wrapWithBranding(
      '<p>hello</p><img src="https://cdn.test/inline.png" width="2000" />',
      { eventName: "Test" }
    );
    // The body's <img> should also have width="600" after normalization.
    expect(out).toMatch(/<img[^>]+src="https:\/\/cdn\.test\/inline\.png"[^>]+width="600"/);
    expect(out).not.toMatch(/width="2000"/);
  });
});
