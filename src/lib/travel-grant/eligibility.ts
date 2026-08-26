/**
 * Travel Grant eligibility: is the submitting author based in one of the
 * countries this event treats as local?
 *
 * Client-safe by construction. It imports the country list and nothing else, so
 * a `"use client"` form can render the same verdict the server routed on. See
 * docs/TRAVEL_GRANT_PLAN.md §4 and docs/TRAVEL_GRANT_COUNTRIES_PLAN.md.
 *
 * ## The home country is the organizer's, not ours
 *
 * This shipped with the UAE hard-coded, which is one customer's geography baked
 * into a shared feature: a Riyadh conference would have offered grants to its
 * own locals and withheld them from everyone in Dubai. The exempt set is now an
 * argument. Note this made the module SMALLER — a special case became the
 * general case, rather than a second special case being added beside the first.
 *
 * ## Why this is not a one-line comparison
 *
 * `Speaker.country` holds a DISPLAY NAME, not an ISO code: `CountrySelect`
 * writes `c.name`, so production holds `"United Arab Emirates"`. But that same
 * component resolves a stored value on EITHER code or name, so the rest of the
 * app tolerates a legacy row holding `"AE"`, and the CSV importers write the
 * column as raw free text with no validation at all.
 *
 * So a name comparison is wrong, and wrong in the expensive direction: a row
 * holding `"AE"` would be classed as overseas and a Dubai resident offered a
 * travel grant. Everything resolves to an alpha-2 CODE first, and the
 * comparison happens between codes.
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
 * This is the load-bearing safety property, and it did not get weaker by
 * generalising — it got broader. The CSV importers accept free text, so
 * `"Dubai"`, `"U.A.E"`, `"n/a"` and ordinary typos all reach this column, and
 * with a configurable home country the same trap now multiplies: `"Jeddah"`,
 * `"Doha"`, `"Riyadh"`. Treating unrecognised input as overseas would mail a
 * grant offer to a local resident; treating it as unknown routes it to the
 * console for a human, which is recoverable. City and region names are
 * deliberately NOT enumerated: adding `dubai` would invite an endless list
 * whose gaps fail OPEN. Falling through to `unknown` covers all of them at once
 * and fails CLOSED.
 */
import { countries } from "@/lib/countries";

export type ResidencyClass = "home" | "overseas" | "unknown";

/**
 * Lowercase, drop a leading `"the "`, strip the punctuation that abbreviations
 * attract, collapse runs of whitespace. `"  U.A.E. "`, `"U. A. E."` and
 * `"The Netherlands"` all normalise into something resolvable. No country name
 * in `countries.ts` contains a period or a comma, or begins with `"The "`, so
 * neither rule can damage a legitimate value (asserted by test).
 */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the\s+/, "");
}

/**
 * Every recognised country, by normalised display name and by alpha-2 code,
 * mapped to its canonical code. Built once at module load from the same list the
 * picker renders, so what counts as "a real country" here cannot drift from what
 * an organizer is able to choose there.
 */
const COUNTRY_INDEX: ReadonlyMap<string, string> = new Map(
  countries.flatMap((c) => [
    [normalize(c.name), c.code] as const,
    [normalize(c.code), c.code] as const,
  ]),
);

/**
 * Informal spellings that are not in the list at all, mapped to their code.
 *
 * An explicit enumeration, NOT a substring match: `includes("ae")` would
 * classify Israel, Ireland and Taiwan as the UAE.
 *
 * Kept deliberately short. Each entry is an abbreviation people actually type
 * into a free-text field, and every one of them resolves to `unknown` without
 * it — so this list only ever converts a flagged row into a correctly-routed
 * one. `are` is the UAE's alpha-3 and is here because it was recognised before
 * this change; alpha-3 is not supported generally, because `countries.ts` does
 * not carry alpha-3 codes and inventing 196 of them is a worse trade than
 * leaving those rows flagged for a human.
 */
const INFORMAL_ALIASES: ReadonlyMap<string, string> = new Map([
  ["uae", "AE"],
  ["u a e", "AE"],
  ["are", "AE"],
  ["uk", "GB"],
  ["u k", "GB"],
  ["great britain", "GB"],
  ["usa", "US"],
  ["u s a", "US"],
  ["united states of america", "US"],
  ["ksa", "SA"],
]);

/**
 * Resolve any recorded country value to its ISO alpha-2 code, or null if we do
 * not recognise it. Exported because the settings picker validates the
 * organizer's stored codes through exactly this function, so a code the picker
 * accepts is by definition one the classifier can match.
 */
export function resolveCountryCode(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalize(value);
  if (!normalized) return null;
  return COUNTRY_INDEX.get(normalized) ?? INFORMAL_ALIASES.get(normalized) ?? null;
}

/** Display names for a set of codes, in the order given. Unknown codes are dropped. */
export function countryNamesFor(codes: readonly string[]): string[] {
  return codes
    .map((code) => countries.find((c) => c.code === code)?.name)
    .filter((name): name is string => !!name);
}

/**
 * Classify an author's recorded country for travel-grant routing.
 *
 * - `"home"`      based in a country this event treats as local. Not eligible.
 * - `"overseas"`  a recognised country that is not one of them. Eligible.
 * - `"unknown"`   blank, unrecognised, or not a country at all. **Not eligible**,
 *                 and surfaced in the console so a human can decide (D4).
 *
 * `homeCodes` empty returns `"unknown"` for everything rather than `"overseas"`.
 * That state is unreachable through `readTravelGrantSettings`, which reports the
 * feature as disabled when no country is configured — but if it is ever reached
 * some other way, the failure has to be "nobody is offered a grant" and not
 * "everybody is". A misleading label in an impossible state is much cheaper than
 * a grant offer to an author who lives down the road from the venue.
 */
export function classifyResidency(
  country: string | null | undefined,
  homeCodes: readonly string[],
): ResidencyClass {
  const code = resolveCountryCode(country);
  if (!code) return "unknown";
  if (homeCodes.length === 0) return "unknown";
  return homeCodes.includes(code) ? "home" : "overseas";
}

/**
 * The one predicate callers should use to decide whether to mint a grant and
 * render the email block. Deliberately a named function rather than an inline
 * `=== "overseas"` at each call site, so the "unknown is not eligible" rule is
 * stated once and cannot be re-litigated differently in the email path and the
 * console path.
 */
export function isTravelGrantEligible(
  country: string | null | undefined,
  homeCodes: readonly string[],
): boolean {
  return classifyResidency(country, homeCodes) === "overseas";
}
