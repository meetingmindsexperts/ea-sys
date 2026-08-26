import { describe, it, expect } from "vitest";
import { countries } from "@/lib/countries";
import {
  classifyResidency,
  countryNamesFor,
  isTravelGrantEligible,
  resolveCountryCode,
  type ResidencyClass,
} from "@/lib/travel-grant/eligibility";
import { residencyLabel } from "@/lib/travel-grant/constants";

/**
 * Travel Grant eligibility. See docs/TRAVEL_GRANT_PLAN.md §4 and
 * docs/TRAVEL_GRANT_COUNTRIES_PLAN.md.
 *
 * The home country became an ARGUMENT on Aug 26 2026. Most of this file still
 * passes `["AE"]`, deliberately: those cases were the regression net for the
 * hard-coded version, and keeping them proves the generalisation did not change
 * the answer for the one event configured that way.
 *
 * MUTATIONS THIS SUITE EXISTS TO CATCH. If you change eligibility.ts, check that
 * each of these still fails:
 *
 *   1. Compare display names instead of resolving to a code
 *      -> the "AE" / "ARE" / "U.A.E." cases fail. A legacy row holding the ISO
 *         code would be classed overseas and a local resident mailed an offer.
 *   2. Make the fallback `overseas` instead of `unknown`
 *      -> the city cases fail. Unrecognised input must never be eligible.
 *   3. Make `isTravelGrantEligible` accept `unknown`
 *      -> the D4 case fails.
 *   4. Substring-match the aliases (`normalized.includes("ae")`)
 *      -> "Israel" fails, because it contains "ae".
 *   5. Return `overseas` when `homeCodes` is empty
 *      -> the unconfigured case fails. That is the fail-OPEN direction: it would
 *         offer a grant to every author on the event, including the locals.
 */

const UAE = ["AE"] as const;

describe("classifyResidency", () => {
  describe("the home country, in every spelling that reaches this column", () => {
    const home = [
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
    it.each(home)("classifies %j as home", (value) => {
      expect(classifyResidency(value, UAE)).toBe<ResidencyClass>("home");
    });
  });

  describe("recognised countries that are not the home country", () => {
    const overseas = ["Oman", "oman", "  Oman  ", "OM", "om", "Egypt", "United Kingdom", "GB"];
    it.each(overseas)("classifies %j as overseas", (value) => {
      expect(classifyResidency(value, UAE)).toBe<ResidencyClass>("overseas");
    });

    it("does not substring-match the aliases (Israel contains 'ae')", () => {
      expect("israel").toContain("ae"); // the trap, stated so it cannot be argued away
      expect(classifyResidency("Israel", UAE)).toBe<ResidencyClass>("overseas");
    });
  });

  describe("the home country is the organizer's, not ours", () => {
    it("treats a Saudi author as local on a Riyadh event, and a UAE author as overseas", () => {
      expect(classifyResidency("Saudi Arabia", ["SA"])).toBe<ResidencyClass>("home");
      expect(classifyResidency("United Arab Emirates", ["SA"])).toBe<ResidencyClass>("overseas");
    });

    it("accepts several home countries", () => {
      const gulf = ["AE", "SA", "QA"];
      expect(classifyResidency("Qatar", gulf)).toBe<ResidencyClass>("home");
      expect(classifyResidency("AE", gulf)).toBe<ResidencyClass>("home");
      expect(classifyResidency("Oman", gulf)).toBe<ResidencyClass>("overseas");
    });

    it("is the SAME verdict whether the author's country is stored as a name or a code", () => {
      // The reason everything resolves to a code first: the picker writes names,
      // the importers write free text, legacy rows hold codes.
      expect(classifyResidency("Saudi Arabia", ["SA"])).toBe(classifyResidency("SA", ["SA"]));
      expect(classifyResidency("ksa", ["SA"])).toBe<ResidencyClass>("home");
    });
  });

  describe("no home country configured is unknown, never overseas", () => {
    // Unreachable through readTravelGrantSettings, which reports the feature as
    // disabled in that state. Pinned anyway because it is the one place where
    // the intuitive reading fails OPEN: an empty exempt set would make every
    // recognised country count as overseas and offer a grant to every local.
    it.each(["United Arab Emirates", "Oman", "GB"])(
      "classifies %j as unknown when the exempt set is empty",
      (value) => {
        expect(classifyResidency(value, [])).toBe<ResidencyClass>("unknown");
      },
    );
  });

  describe("absent or unusable values fall through to unknown", () => {
    const unknown: (string | null | undefined)[] = [null, undefined, "", "   ", "\t\n"];
    it.each(unknown)("classifies %j as unknown", (value) => {
      expect(classifyResidency(value, UAE)).toBe<ResidencyClass>("unknown");
    });

    it("treats a non-string as unknown rather than throwing", () => {
      expect(classifyResidency(42 as unknown as string, UAE)).toBe<ResidencyClass>("unknown");
    });
  });

  describe("the safety property: a local city must never read as overseas", () => {
    // The CSV importers write this column as raw free text, so these are real
    // reachable values, not hypotheticals. Each one is IN a country some event
    // will exempt, so classifying it as overseas would mail a grant offer to
    // someone who lives near the venue. The trap MULTIPLIES now that the home
    // country is configurable, which is why the answer is a fallthrough rather
    // than a list.
    const places = [
      ["Dubai", UAE],
      ["Abu Dhabi", UAE],
      ["Sharjah", UAE],
      ["Al Ain", UAE],
      ["Ras Al Khaimah", UAE],
      ["Riyadh", ["SA"]],
      ["Jeddah", ["SA"]],
      ["Doha", ["QA"]],
    ] as const;
    it.each(places)("classifies %j as unknown, never overseas", (value, home) => {
      expect(classifyResidency(value, home)).toBe<ResidencyClass>("unknown");
    });
  });

  describe("garbage input is unknown, not eligible", () => {
    const garbage = ["n/a", "N/A", "-", "unknown", "Untied Kingdom", "xx", "12345"];
    it.each(garbage)("classifies %j as unknown", (value) => {
      expect(classifyResidency(value, UAE)).toBe<ResidencyClass>("unknown");
    });
  });
});

describe("resolveCountryCode", () => {
  it("resolves a display name, a code, and either casing to the same code", () => {
    for (const v of ["Oman", "oman", "OM", "om", "  Oman  "]) {
      expect(resolveCountryCode(v)).toBe("OM");
    }
  });

  it("resolves the informal abbreviations people actually type", () => {
    // Every one of these was `unknown` before the alias table, so each entry
    // only ever converts a FLAGGED row into a correctly-routed one.
    expect(resolveCountryCode("UK")).toBe("GB");
    expect(resolveCountryCode("USA")).toBe("US");
    expect(resolveCountryCode("KSA")).toBe("SA");
    expect(resolveCountryCode("UAE")).toBe("AE");
  });

  it("strips a leading 'the'", () => {
    expect(resolveCountryCode("The Netherlands")).toBe("NL");
  });

  it("returns null rather than guessing", () => {
    for (const v of [null, undefined, "", "Dubai", "xx", 42 as unknown as string]) {
      expect(resolveCountryCode(v)).toBeNull();
    }
  });
});

describe("countryNamesFor", () => {
  it("maps codes to display names in the order given", () => {
    expect(countryNamesFor(["SA", "AE"])).toEqual(["Saudi Arabia", "United Arab Emirates"]);
  });

  it("drops a code it does not recognise rather than rendering a blank chip", () => {
    expect(countryNamesFor(["AE", "ZZ"])).toEqual(["United Arab Emirates"]);
    expect(countryNamesFor([])).toEqual([]);
  });
});

describe("residencyLabel", () => {
  it("names the country when there is exactly one", () => {
    expect(residencyLabel("home", ["United Arab Emirates"])).toBe(
      "United Arab Emirates, not eligible",
    );
  });

  it("shortens to 'Local' for two or more, so the badge cannot wrap", () => {
    expect(residencyLabel("home", ["United Arab Emirates", "Saudi Arabia"])).toBe(
      "Local, not eligible",
    );
  });

  it("does not depend on the configuration for the other two verdicts", () => {
    expect(residencyLabel("overseas", [])).toBe("Eligible");
    expect(residencyLabel("overseas", ["Oman"])).toBe("Eligible");
    expect(residencyLabel("unknown", ["Oman"])).toBe("Country not recorded");
  });
});

describe("isTravelGrantEligible", () => {
  it("is true only for a recognised country outside the exempt set", () => {
    expect(isTravelGrantEligible("Oman", UAE)).toBe(true);
    expect(isTravelGrantEligible("OM", UAE)).toBe(true);
  });

  it("is false for a home country", () => {
    expect(isTravelGrantEligible("United Arab Emirates", UAE)).toBe(false);
    expect(isTravelGrantEligible("AE", UAE)).toBe(false);
  });

  it("is false for unknown (decision D4: do not send, flag it instead)", () => {
    expect(isTravelGrantEligible(null, UAE)).toBe(false);
    expect(isTravelGrantEligible("", UAE)).toBe(false);
    expect(isTravelGrantEligible("Dubai", UAE)).toBe(false);
  });

  it("is false for everyone when no home country is configured", () => {
    expect(isTravelGrantEligible("Oman", [])).toBe(false);
  });
});

describe("structural guards on the country list itself", () => {
  it("no country name contains a period or comma, so stripping them is safe", () => {
    // normalize() removes . and , to fold "U.A.E." into the alias set. That is
    // only safe while no legitimate country name relies on them.
    const punctuated = countries.filter((c) => /[.,]/.test(c.name));
    expect(punctuated).toEqual([]);
  });

  it("no country name begins with 'The', so stripping a leading 'the' is safe", () => {
    const leadingThe = countries.filter((c) => /^the\s/i.test(c.name));
    expect(leadingThe).toEqual([]);
  });

  it("no informal alias collides with a real name or code except its own country", () => {
    // "uk" must not be a country's code, or the alias would shadow it.
    for (const [alias, code] of [
      ["uk", "GB"],
      ["usa", "US"],
      ["ksa", "SA"],
      ["uae", "AE"],
      ["are", "AE"],
    ] as const) {
      const collisions = countries.filter(
        (c) => c.code.toLowerCase() === alias || c.name.toLowerCase() === alias,
      );
      for (const c of collisions) expect(c.code).toBe(code);
    }
  });

  it("every country in the picker gets a definite verdict, never unknown", () => {
    // An organizer picking any option from the dropdown must get a real answer.
    // If this fails, normalize() has damaged a real country name.
    const undecided = countries.filter((c) => classifyResidency(c.name, UAE) === "unknown");
    expect(undecided.map((c) => c.name)).toEqual([]);
  });

  it("every country is selectable AS a home country", () => {
    // The picker stores what resolveCountryCode returns, so a name it cannot
    // resolve would be silently dropped on save.
    const unresolvable = countries.filter((c) => resolveCountryCode(c.name) !== c.code);
    expect(unresolvable.map((c) => c.name)).toEqual([]);
  });
});
