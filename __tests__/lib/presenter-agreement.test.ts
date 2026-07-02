import { describe, it, expect } from "vitest";
import {
  mergePresenterAgreementHtml,
  PRESENTER_AGREEMENT_IDENTIFIER_PREFIX,
  type PresenterAgreementContext,
} from "@/lib/presenter-agreement";
import { DEFAULT_PRESENTER_AGREEMENT_HTML } from "@/lib/default-terms";

function ctx(overrides: Partial<PresenterAgreementContext> = {}): PresenterAgreementContext {
  return {
    title: "Dr.",
    firstName: "Ada",
    lastName: "Lovelace",
    presenterName: "Dr. Ada Lovelace",
    presenterEmail: "ada@example.com",
    presenterOrganization: "Analytical Engines",
    presenterCountry: "United Kingdom",
    jobTitle: "Mathematician",
    eventName: "MedCon 2026",
    eventStartDate: "October 1, 2026",
    eventEndDate: "October 3, 2026",
    eventDateRange: " — October 1, 2026 to October 3, 2026",
    eventVenue: "Grand Hall",
    eventAddress: "1 Main St",
    eventCity: "Dubai",
    organizationName: "Meeting Minds",
    signedDate: "July 2, 2026",
    abstractTitles: "On the Analytical Engine; Notes G",
    abstractCount: "2",
    presentationTypes: "Oral",
    themeNames: "Computing",
    ...overrides,
  };
}

describe("presenter-agreement", () => {
  it("identifier prefix is stable (public route + send route depend on it)", () => {
    expect(PRESENTER_AGREEMENT_IDENTIFIER_PREFIX).toBe("presenter-agreement:");
  });

  describe("mergePresenterAgreementHtml", () => {
    it("substitutes known tokens", () => {
      const out = mergePresenterAgreementHtml(
        "<p>{{presenterName}} — {{eventName}} — {{abstractTitles}}</p>",
        ctx(),
      );
      expect(out).toBe("<p>Dr. Ada Lovelace — MedCon 2026 — On the Analytical Engine; Notes G</p>");
    });

    it("tolerates whitespace inside the braces", () => {
      expect(mergePresenterAgreementHtml("{{  presenterName  }}", ctx())).toBe("Dr. Ada Lovelace");
    });

    it("HTML-escapes injected values (stored-XSS defense)", () => {
      const out = mergePresenterAgreementHtml("{{presenterName}}", ctx({ presenterName: '<script>alert(1)</script>' }));
      expect(out).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(out).not.toContain("<script>");
    });

    it("leaves unknown tokens as-is (typos surface visibly, not silently dropped)", () => {
      expect(mergePresenterAgreementHtml("{{nope}} {{eventName}}", ctx())).toBe("{{nope}} MedCon 2026");
    });

    it("renders empty string for a present-but-empty value", () => {
      expect(mergePresenterAgreementHtml("[{{eventVenue}}]", ctx({ eventVenue: "" }))).toBe("[]");
    });
  });

  describe("DEFAULT_PRESENTER_AGREEMENT_HTML", () => {
    it("references the core merge tokens and resolves them cleanly", () => {
      for (const token of ["presenterName", "eventName", "abstractTitles", "organizationName", "signedDate"]) {
        expect(DEFAULT_PRESENTER_AGREEMENT_HTML).toContain(`{{${token}}}`);
      }
      // Every token in the default must be resolvable by the merger (no stray
      // {{...}} left behind after a full merge).
      const merged = mergePresenterAgreementHtml(DEFAULT_PRESENTER_AGREEMENT_HTML, ctx());
      expect(merged).not.toMatch(/\{\{\s*\w+\s*\}\}/);
    });
  });
});
