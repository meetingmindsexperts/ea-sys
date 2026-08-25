import { describe, it, expect } from "vitest";
import { countries } from "@/lib/countries";
import {
  classifyResidency,
  isTravelGrantEligible,
  type ResidencyClass,
} from "@/lib/travel-grant/eligibility";

/**
 * Travel Grant eligibility. See docs/TRAVEL_GRANT_PLAN.md §4.
 *
 * MUTATIONS THIS SUITE EXISTS TO CATCH. If you change eligibility.ts, check that
 * each of these still fails:
 *
 *   1. Replace the alias set with `country !== "United Arab Emirates"`
 *      -> the "AE" / "ARE" / "U.A.E." cases fail. This is the whole point: a
 *         legacy row holding the ISO code would be classed overseas and a Dubai
 *         resident would be mailed a grant offer.
 *   2. Make the fallback `overseas` instead of `unknown`
 *      -> the "Dubai" and typo cases fail. Unrecognised input must never be
 *         treated as eligible.
 *   3. Make `isTravelGrantEligible` accept `unknown`
 *      -> the D4 case fails.
 *   4. Swap the alias check for `normalized.includes("ae")`
 *      -> "Israel" fails, because it contains "ae".
 */

describe("classifyResidency", () => {
  describe("UAE, in every spelling that reaches this column", () => {
    const uae = [
      "United Arab Emirates", // what CountrySelect writes
      "united arab emirates",
      "  United Arab Emirates  ",
      "the United Arab Emirates",
      "AE", // alpha-2: legacy rows + CSV imports
      "ae",
      "ARE", // alpha-3: some export tools
      "UAE",
      "uae",
      "U.A.E.", // punctuation stripped
      "U. A. E.",
      "U A E",
    ];
    it.each(uae)("classifies %j as uae", (value) => {
      expect(classifyResidency(value)).toBe<ResidencyClass>("uae");
    });
  });

  describe("recognised countries that are not the UAE", () => {
    const overseas = ["Oman", "oman", "  Oman  ", "OM", "om", "Egypt", "United Kingdom", "GB"];
    it.each(overseas)("classifies %j as overseas", (value) => {
      expect(classifyResidency(value)).toBe<ResidencyClass>("overseas");
    });

    it("does not substring-match the alias set (Israel contains 'ae')", () => {
      expect("israel").toContain("ae"); // the trap, stated so it cannot be argued away
      expect(classifyResidency("Israel")).toBe<ResidencyClass>("overseas");
    });
  });

  describe("absent or unusable values fall through to unknown", () => {
    const unknown: (string | null | undefined)[] = [null, undefined, "", "   ", "\t\n"];
    it.each(unknown)("classifies %j as unknown", (value) => {
      expect(classifyResidency(value)).toBe<ResidencyClass>("unknown");
    });

    it("treats a non-string as unknown rather than throwing", () => {
      expect(classifyResidency(42 as unknown as string)).toBe<ResidencyClass>("unknown");
    });
  });

  describe("the safety property: a UAE city must never read as overseas", () => {
    // The CSV importers write this column as raw free text, so these are real
    // reachable values, not hypotheticals. Each one is IN the UAE, so
    // classifying it as overseas would mail a grant offer to a UAE resident.
    const uaePlaces = ["Dubai", "Abu Dhabi", "Sharjah", "Al Ain", "Ras Al Khaimah"];
    it.each(uaePlaces)("classifies %j as unknown, never overseas", (value) => {
      expect(classifyResidency(value)).toBe<ResidencyClass>("unknown");
    });
  });

  describe("garbage input is unknown, not eligible", () => {
    const garbage = ["n/a", "N/A", "-", "unknown", "Untied Kingdom", "xx", "12345"];
    it.each(garbage)("classifies %j as unknown", (value) => {
      expect(classifyResidency(value)).toBe<ResidencyClass>("unknown");
    });
  });
});

describe("isTravelGrantEligible", () => {
  it("is true only for a recognised non-UAE country", () => {
    expect(isTravelGrantEligible("Oman")).toBe(true);
    expect(isTravelGrantEligible("OM")).toBe(true);
  });

  it("is false for the UAE", () => {
    expect(isTravelGrantEligible("United Arab Emirates")).toBe(false);
    expect(isTravelGrantEligible("AE")).toBe(false);
  });

  it("is false for unknown (decision D4: do not send, flag it instead)", () => {
    expect(isTravelGrantEligible(null)).toBe(false);
    expect(isTravelGrantEligible("")).toBe(false);
    expect(isTravelGrantEligible("Dubai")).toBe(false);
  });
});

describe("structural guards on the country list itself", () => {
  it("no country name contains a period or comma, so stripping them is safe", () => {
    // normalize() removes . and , to fold "U.A.E." into the alias set. That is
    // only safe while no legitimate country name relies on them.
    const punctuated = countries.filter((c) => /[.,]/.test(c.name));
    expect(punctuated).toEqual([]);
  });

  it("only the UAE's own codes collide with the alias set", () => {
    const colliding = countries.filter((c) =>
      ["ae", "are", "uae"].includes(c.code.toLowerCase()),
    );
    expect(colliding.map((c) => c.name)).toEqual(["United Arab Emirates"]);
  });

  it("every country in the picker classifies as uae or overseas, never unknown", () => {
    // An organizer picking any option from the dropdown must get a definite
    // verdict. If this fails, normalize() has damaged a real country name.
    const undecided = countries.filter((c) => classifyResidency(c.name) === "unknown");
    expect(undecided.map((c) => c.name)).toEqual([]);
  });
});
