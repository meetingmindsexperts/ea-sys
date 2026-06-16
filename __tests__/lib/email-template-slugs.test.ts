/**
 * The client-safe SYSTEM_TEMPLATE_SLUGS mirror must stay in sync with the
 * authoritative DEFAULT_TEMPLATES in src/lib/email.ts. If a new default
 * template is added there without updating the mirror, the bulk-email dialog
 * would mis-classify it as a "custom" template and offer it as a duplicate
 * send option. This test fails CI on that drift.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_TEMPLATES } from "@/lib/email";
import { SYSTEM_TEMPLATE_SLUGS, isCustomTemplateSlug } from "@/lib/email-template-slugs";

describe("email-template-slugs", () => {
  it("mirrors every DEFAULT_TEMPLATES slug (no drift)", () => {
    const defaultSlugs = new Set(DEFAULT_TEMPLATES.map((t) => t.slug));
    // Every system default is in the mirror …
    for (const slug of defaultSlugs) {
      expect(SYSTEM_TEMPLATE_SLUGS.has(slug)).toBe(true);
    }
    // … and the mirror has no extra entries that aren't real defaults.
    for (const slug of SYSTEM_TEMPLATE_SLUGS) {
      expect(defaultSlugs.has(slug)).toBe(true);
    }
    expect(SYSTEM_TEMPLATE_SLUGS.size).toBe(defaultSlugs.size);
  });

  it("classifies system slugs as not-custom", () => {
    expect(isCustomTemplateSlug("registration-confirmation")).toBe(false);
    expect(isCustomTemplateSlug("speaker-invitation")).toBe(false);
    expect(isCustomTemplateSlug("custom-notification")).toBe(false);
  });

  it("classifies organizer-created slugs as custom", () => {
    expect(isCustomTemplateSlug("vip-welcome")).toBe(true);
    expect(isCustomTemplateSlug("sponsor-thank-you")).toBe(true);
    expect(isCustomTemplateSlug("my-custom-blast")).toBe(true);
  });
});
