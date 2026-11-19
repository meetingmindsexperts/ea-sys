import type { Prisma } from "@prisma/client";

/**
 * Searching for a person by name: ONE rule for the agent's tools, the
 * Contacts page, its export and the add-from-contacts dialog (moved here from
 * the agent's tools on Nov 19, 2026, when the Contacts search was found to
 * have the same gap the agent had: "Yasser Wali" found no one).
 *
 * Client-safe: a type import only.
 */

/**
 * The words of a person search (red-team round, September 22, 2026).
 * search_event used to match the WHOLE query against each field, so
 * "Ahmed Mansour" matched neither the first-name column nor the surname
 * column and a full name found nobody, after which the model told the
 * person the speaker did not exist. Split on whitespace and commas, drop
 * honorifics and stray punctuation, keep at most six words; a query that
 * is nothing but honorifics falls back to its own words.
 */
const PERSON_HONORIFICS = new Set(["dr", "prof", "professor", "mr", "mrs", "ms", "miss", "mx", "sir", "madam", "eng", "hon"]);
export function personSearchTokens(query: string): string[] {
  const words = query
    .split(/[\s,;]+/)
    .map((w) => w.replace(/^[.\-:]+|[.\-:]+$/g, ""))
    .filter((w) => w.length > 0);
  const kept = words.filter((w) => !PERSON_HONORIFICS.has(w.toLowerCase()));
  const tokens = (kept.length > 0 ? kept : words).slice(0, 6);
  return tokens.length > 0 ? tokens : [query.trim()];
}

/**
 * A contact matches a person search when every word matches its first name,
 * last name, email or organisation. One builder for `search_event` and
 * `list_contacts` (Nov 18, 2026): list_contacts had matched the whole text
 * against each field, so "Mahmoud Marashi" found no one.
 */
export function contactSearchClauses(query: string): Prisma.ContactWhereInput[] {
  const ci = (t: string) => ({ contains: t, mode: "insensitive" as const });
  return personSearchTokens(query).map((t) => ({
    OR: [{ firstName: ci(t) }, { lastName: ci(t) }, { email: ci(t) }, { organization: ci(t) }],
  }));
}
