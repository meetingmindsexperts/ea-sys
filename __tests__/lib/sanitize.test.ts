import { describe, it, expect } from "vitest";
import { sanitizeHtml } from "@/lib/sanitize";

describe("sanitizeHtml", () => {
  it("passes through safe HTML", () => {
    const input = "<p>Hello <strong>world</strong></p>";
    expect(sanitizeHtml(input)).toBe(input);
  });

  it("strips script tags", () => {
    const input = '<script>alert("xss")</script><p>Safe</p>';
    expect(sanitizeHtml(input)).toBe("<p>Safe</p>");
  });

  it("strips event handlers", () => {
    const result = sanitizeHtml('<div onclick="alert(1)">Click</div>');
    expect(result).toBe("<div>Click</div>");
  });

  it("strips iframe tags", () => {
    const result = sanitizeHtml('<iframe src="evil.com"></iframe>');
    expect(result).toBe("");
  });

  it("preserves allowed attributes (href, class)", () => {
    const input = '<a href="https://example.com" class="link">Link</a>';
    expect(sanitizeHtml(input)).toBe(input);
  });

  it("strips data attributes", () => {
    const result = sanitizeHtml('<div data-evil="hack">Test</div>');
    expect(result).toBe("<div>Test</div>");
  });

  it("passes plain text through unchanged", () => {
    const input = "Just plain text, no HTML";
    expect(sanitizeHtml(input)).toBe(input);
  });

  it("strips onerror from img tags but preserves allowed attrs", () => {
    const result = sanitizeHtml(
      '<img src="photo.jpg" alt="Photo" onerror="alert(1)">'
    );
    expect(result).toContain('src="photo.jpg"');
    expect(result).toContain('alt="Photo"');
    expect(result).not.toContain("onerror");
  });
});
