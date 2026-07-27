/**
 * The built-in starter certificate templates.
 *
 * Two invariants matter more than the rest, because both fail SILENTLY on the
 * printed page:
 *
 *  1. TOKEN VALIDITY — a starter box referencing a token the renderer doesn't
 *     resolve prints a blank line on every certificate and logs a warn per
 *     render. Nothing about the certificate looks broken; the line is just
 *     missing. So every token in every starter box is checked against the
 *     catalog here.
 *
 *  2. NO DANGLING LABELS — "Total Hour/s Awarded: {{cmeHours}}" on an event
 *     with no CME hours renders "Total Hour/s Awarded:" with nothing after the
 *     colon. The starter adapts to the event instead, and these tests pin that
 *     it omits the line rather than shipping the label.
 */

import { describe, it, expect } from "vitest";

import {
  buildStarterBackgroundPdf,
  starterTemplateName,
  starterTemplateRole,
  starterTextBoxes,
  STARTER_PAGE_WIDTH,
  STARTER_PAGE_HEIGHT,
  type StarterEventShape,
} from "@/lib/certificates/starter-template";
import { unknownTokensIn } from "@/lib/certificates/token-catalog";
import { certificateTextBoxesSchema } from "@/lib/certificates/template-box-schema";
import type { CertificateType } from "@/lib/certificates/types";

const FULLY_CONFIGURED: StarterEventShape = {
  hasVenue: true,
  hasCme: true,
  hasAccreditation: true,
};
const BARE: StarterEventShape = { hasVenue: false, hasCme: false, hasAccreditation: false };

const CATEGORIES: CertificateType[] = ["ATTENDANCE", "APPRECIATION"];

function contentOf(category: CertificateType, shape: StarterEventShape): string[] {
  return starterTextBoxes(category, shape).map((b) => b.content);
}

describe("starter text boxes — token validity", () => {
  it.each(CATEGORIES)("uses only tokens the renderer resolves (%s)", (category) => {
    for (const shape of [FULLY_CONFIGURED, BARE]) {
      for (const box of starterTextBoxes(category, shape)) {
        expect(unknownTokensIn(box.content), `box "${box.content}"`).toEqual([]);
      }
    }
  });

  it.each(CATEGORIES)("passes the shared write-door schema (%s)", (category) => {
    // The starter route persists these, so they must satisfy exactly the
    // validation an organizer-authored template does.
    expect(certificateTextBoxesSchema.safeParse(starterTextBoxes(category, FULLY_CONFIGURED)).success)
      .toBe(true);
  });

  it.each(CATEGORIES)("has unique box ids (%s)", (category) => {
    const ids = starterTextBoxes(category, FULLY_CONFIGURED).map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(CATEGORIES)("keeps every box inside the page (%s)", (category) => {
    for (const box of starterTextBoxes(category, FULLY_CONFIGURED)) {
      expect(box.x, box.content).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, box.content).toBeLessThanOrEqual(STARTER_PAGE_WIDTH);
      expect(box.y, box.content).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, box.content).toBeLessThanOrEqual(STARTER_PAGE_HEIGHT);
    }
  });
});

describe("starter text boxes — adapts to the event, no dangling labels", () => {
  it("omits accreditation, CME and venue lines on an unconfigured event", () => {
    const bare = contentOf("ATTENDANCE", BARE);
    expect(bare.some((c) => c.includes("{{cmeHours}}"))).toBe(false);
    expect(bare.some((c) => c.includes("{{accreditationName}}"))).toBe(false);
    expect(bare.some((c) => c.includes("{{accreditationReference}}"))).toBe(false);
    expect(bare.some((c) => c.includes("{{venueLine}}"))).toBe(false);
  });

  it("includes them once the event has them", () => {
    const full = contentOf("ATTENDANCE", FULLY_CONFIGURED);
    expect(full).toContain("Total Hour/s Awarded: {{cmeHours}}");
    expect(full).toContain("Accredited by {{accreditationName}}");
    expect(full).toContain("Accreditation #: {{accreditationReference}}");
    expect(full).toContain("{{venueLine}}");
  });

  it("never emits a label whose only value token was omitted", () => {
    // The point of the adaptation: any box carrying a ':' label must also
    // carry a token, otherwise it prints a bare colon.
    for (const category of CATEGORIES) {
      for (const shape of [FULLY_CONFIGURED, BARE]) {
        for (const content of contentOf(category, shape)) {
          if (content.trimEnd().endsWith(":")) {
            throw new Error(`Starter box would print a dangling label: "${content}"`);
          }
        }
      }
    }
  });

  it("keeps the core identity lines regardless of configuration", () => {
    for (const category of CATEGORIES) {
      const bare = contentOf(category, BARE);
      expect(bare).toContain("{{recipientName}}");
      expect(bare).toContain("{{eventName}}");
      expect(bare).toContain("{{organizationName}}");
      expect(bare.some((c) => c.includes("{{eventDateRange}}"))).toBe(true);
    }
  });
});

describe("starter text boxes — category differences", () => {
  it("titles each category correctly", () => {
    expect(contentOf("ATTENDANCE", BARE)).toContain("CERTIFICATE OF ATTENDANCE");
    expect(contentOf("APPRECIATION", BARE)).toContain("CERTIFICATE OF APPRECIATION");
  });

  it("puts {{role}} in the appreciation wording and pairs it with a default role", () => {
    // Together these are what removes OSH's retyping: duplicate the template,
    // change the role field, and the sentence re-words itself.
    expect(contentOf("APPRECIATION", BARE)).toContain("contributed as {{role}} to");
    expect(starterTemplateRole("APPRECIATION")).toBe("Speaker");
  });

  it("leaves attendance role-free", () => {
    expect(contentOf("ATTENDANCE", BARE).some((c) => c.includes("{{role}}"))).toBe(false);
    expect(starterTemplateRole("ATTENDANCE")).toBeNull();
  });

  it("names the presentation on appreciation only", () => {
    expect(contentOf("APPRECIATION", BARE)).toContain("{{abstractTitle}}");
    expect(contentOf("ATTENDANCE", BARE).some((c) => c.includes("{{abstractTitle}}"))).toBe(false);
  });

  it("names templates per category", () => {
    expect(starterTemplateName("ATTENDANCE")).toBe("Standard Attendance");
    expect(starterTemplateName("APPRECIATION")).toBe("Standard Appreciation");
  });
});

describe("starter background PDF", () => {
  it.each(CATEGORIES)("produces a single-page PDF at the expected size (%s)", async (category) => {
    const buf = await buildStarterBackgroundPdf(category);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(buf);
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    // Matching the observed designer-export convention (A4 @ 300 DPI) is what
    // lets an organizer swap in their own artwork without moving every box.
    expect(Math.round(width)).toBe(STARTER_PAGE_WIDTH);
    expect(Math.round(height)).toBe(STARTER_PAGE_HEIGHT);
    expect(height).toBeGreaterThan(width); // portrait
  });

  it("carries no embedded fonts — the background is decoration only", async () => {
    // Every word on the certificate must be an editable text box. If wording
    // were baked into the background, the organizer could not change it
    // without a designer, which is the dependency this feature removes.
    const buf = await buildStarterBackgroundPdf("ATTENDANCE");
    const raw = buf.toString("latin1");
    expect(raw).not.toContain("/Type /Font");
    expect(raw).not.toContain("CERTIFICATE OF ATTENDANCE");
  });
});
