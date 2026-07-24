/**
 * The client-safe SYSTEM_TEMPLATE_SLUGS mirror must stay in sync with the
 * authoritative DEFAULT_TEMPLATES in src/lib/email.ts. If a new default
 * template is added there without updating the mirror, the bulk-email dialog
 * would mis-classify it as a "custom" template and offer it as a duplicate
 * send option. This test fails CI on that drift.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_TEMPLATES } from "@/lib/email";
import {
  SYSTEM_TEMPLATE_SLUGS,
  WEBINAR_TEMPLATE_SLUGS,
  isCustomTemplateSlug,
  isWebinarTemplateSlug,
  formatTemplateLabel,
} from "@/lib/email-template-slugs";

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

  it("identifies the webinar-sequence templates (hidden on non-webinar events)", () => {
    // Derived from the `webinar-` prefix, so it can't drift from the mirror.
    for (const slug of SYSTEM_TEMPLATE_SLUGS) {
      expect(isWebinarTemplateSlug(slug)).toBe(slug.startsWith("webinar-"));
    }
    // Every webinar template is also a system template.
    for (const slug of WEBINAR_TEMPLATE_SLUGS) {
      expect(SYSTEM_TEMPLATE_SLUGS.has(slug)).toBe(true);
    }
    expect(isWebinarTemplateSlug("webinar-confirmation")).toBe(true);
    expect(isWebinarTemplateSlug("registration-confirmation")).toBe(false);
    // A custom template that merely happens to start with "webinar" (but isn't
    // one of the system sequence slugs) is NOT treated as a webinar template.
    expect(isWebinarTemplateSlug("webinar-custom-blast")).toBe(false);
    expect(WEBINAR_TEMPLATE_SLUGS.size).toBe(6);
  });

  describe("formatTemplateLabel", () => {
    it("Title-cases a kebab slug by default", () => {
      expect(formatTemplateLabel("speaker-invitation")).toBe("Speaker Invitation");
      expect(formatTemplateLabel("payment-reminder")).toBe("Payment Reminder");
    });

    it("uses friendly overrides for slugs that don't Title-case cleanly", () => {
      expect(formatTemplateLabel("certificate-delivery")).toBe("Certificate");
      expect(formatTemplateLabel("webinar-reminder-24h")).toBe("Webinar Reminder (24h)");
      expect(formatTemplateLabel("custom-notification")).toBe("Custom Email");
      expect(formatTemplateLabel("dinner-rsvp-invitation")).toBe("Dinner RSVP Invitation");
    });

    it("preserves acronyms when falling back to Title Case", () => {
      // 'survey-invitation' has no override, so RSVP/CME must come from the
      // acronym table, not naive capitalization.
      expect(formatTemplateLabel("cme-notice")).toBe("CME Notice");
    });

    it("reads a null/absent slug as a one-off custom email", () => {
      expect(formatTemplateLabel(null)).toBe("Custom email");
      expect(formatTemplateLabel(undefined)).toBe("Custom email");
      expect(formatTemplateLabel("")).toBe("Custom email");
    });

    it("renders every system template slug without throwing", () => {
      // Guards the fallback path: a brand-new default slug must produce a
      // reasonable label even without a dedicated override entry.
      for (const slug of SYSTEM_TEMPLATE_SLUGS) {
        const label = formatTemplateLabel(slug);
        expect(label.length).toBeGreaterThan(0);
        expect(label).not.toContain("-");
      }
    });
  });
});
