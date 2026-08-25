/**
 * Travel Grant eligibility: is the submitting author based in the UAE?
 *
 * Client-safe by construction. It imports the country list and nothing else, so
 * a `"use client"` form can render the same verdict the server routed on. See
 * docs/TRAVEL_GRANT_PLAN.md §4.
 *
 * ## Why this is not a one-line comparison
 *
 * `Speaker.country` holds a DISPLAY NAME, not an ISO code: `CountrySelect`
 * writes `c.name`, so production holds `"United Arab Emirates"`. But that same
 * component resolves a stored value on EITHER code or name, so the rest of the
 * app tolerates a legacy row holding `"AE"`, and the CSV importers write the
 * column as raw free text with no validation at all.
 *
 * So `country !== "United Arab Emirates"` is wrong, and wrong in the expensive
 * direction: a row holding `"AE"` would be classed as overseas and a Dubai
 * resident would be offered a travel grant.
 *
 * ## Why three states rather than a boolean
 *
 * A boolean makes "we do not know" unrepresentable, so it has to be folded
 * silently into one of the other two. Naming `unknown` is what makes decision D4
 * ("do not send, but flag it") expressible at all, and therefore testable. Same
 * reasoning that kept `requiresDocument` and `documentRequired` as two separate
 * flags rather than one tri-state enum.
 *
 * ## Why an unrecognised value is `unknown` and never `overseas`
 *
 * This is the load-bearing safety property. The CSV importers accept free text,
 * so `"Dubai"`, `"U.A.E"`, `"n/a"` and ordinary typos all reach this column.
 * **`"Dubai"` is in the UAE.** Treating unrecognised input as overseas would
 * mail a grant offer to a Dubai resident; treating it as unknown routes it to
 * the console for a human, which is recoverable. Emirate and city names are
 * deliberately NOT enumerated here: adding `dubai` would invite an endless list
 * (`abu dhabi`, `sharjah`, `al ain`, ...) whose gaps fail OPEN. Falling through
 * to `unknown` covers all of them at once and fails CLOSED.
 */
import { countries } from "@/lib/countries";

export type ResidencyClass = "uae" | "overseas" | "unknown";

/**
 * Lowercase, strip the punctuation that abbreviations attract, collapse runs of
 * whitespace. `"  U.A.E. "` and `"U. A. E."` both normalise into the alias set
 * below. No country name in `countries.ts` contains a period or a comma, so
 * stripping them cannot damage a legitimate value (asserted by test).
 */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every spelling of the UAE we are willing to treat as authoritative. An
 * explicit enumeration, NOT a substring match: `includes("ae")` would classify
 * Israel, Ireland and Taiwan as the UAE.
 *
 * Covers the display name, the alpha-2 code that legacy rows and imports carry,
 * the alpha-3 code that some export tools emit, and the spaced form that
 * punctuation-stripping produces from `"U.A.E."`.
 */
const UAE_ALIASES: ReadonlySet<string> = new Set([
  "united arab emirates",
  "the united arab emirates",
  "uae",
  "u a e",
  "ae",
  "are",
]);

/**
 * Every country we recognise, by normalised name and by alpha-2 code. Built once
 * at module load from the same list the picker renders, so the set of values
 * that count as "a real country" cannot drift from the set an organizer can
 * choose.
 */
const KNOWN_COUNTRIES: ReadonlySet<string> = new Set(
  countries.flatMap((c) => [normalize(c.name), normalize(c.code)]),
);

/**
 * Classify an author's recorded country for travel-grant routing.
 *
 * - `"uae"`       the author is based in the UAE and is not eligible.
 * - `"overseas"`  a recognised country that is not the UAE. Eligible.
 * - `"unknown"`   blank, unrecognised, or not a country at all. **Not eligible**,
 *                 and surfaced in the console so a human can decide (D4).
 */
export function classifyResidency(country: string | null | undefined): ResidencyClass {
  if (typeof country !== "string") return "unknown";

  const normalized = normalize(country);
  if (!normalized) return "unknown";
  if (UAE_ALIASES.has(normalized)) return "uae";
  if (KNOWN_COUNTRIES.has(normalized)) return "overseas";
  return "unknown";
}

/**
 * The one predicate callers should use to decide whether to mint a grant and
 * render the email block. Deliberately a named function rather than an inline
 * `=== "overseas"` at each call site, so the "unknown is not eligible" rule is
 * stated once and cannot be re-litigated differently in the email path and the
 * console path.
 */
export function isTravelGrantEligible(country: string | null | undefined): boolean {
  return classifyResidency(country) === "overseas";
}
