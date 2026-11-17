/**
 * The search box on the Abstracts page (Nov 17, 2026).
 *
 * The page holds every abstract of the event already (up to 500), so the
 * search is a filter over that list, not a request. It reads what an organiser
 * is likely to have in hand: the abstract number, the title, the author, the
 * co-authors, the theme, sub-theme and track, and whatever labels the page
 * adds (its status and presentation type).
 *
 * Every word typed must match ("ahmed poster" finds Ahmed's poster), in any
 * order. Case, accents, and the difference between typed and typeset
 * punctuation (' and ’, - and –) are ignored, and punctuation around a word is
 * dropped, so "A-012:" or "(A-012)" pasted from an email still finds it.
 *
 * A NUMBER means the abstract with that number, read by the same rule as
 * "Select by IDs" on the same page (`abstractSerialFromToken`): "12", "012",
 * "A-12", "a012", "#12". It is not looked for inside other abstracts' numbers,
 * so "12" is abstract 12 and not also 112 and 120 to 129; it still finds a
 * title or name that contains it ("B12", "2026").
 *
 * The author's email is searched only when the caller says so: a reviewer is
 * sent it but is never shown it, and a search that confirms a guessed address
 * would show it to them (review of 0418aac8).
 *
 * Pure and client-safe.
 */
import { abstractSerialFromToken } from "@/lib/abstract-reviewer-sheet";

export interface SearchableAbstract {
  serialId: number | null;
  title: string;
  speaker: { firstName: string; lastName: string; email?: string | null };
  theme?: { name: string } | null;
  subTheme?: { name: string } | null;
  track?: { name: string } | null;
  coAuthors?: ReadonlyArray<{ firstName?: string | null; lastName?: string | null } | null> | null;
}

export interface AbstractSearchOptions {
  /** Search the author's email too. Only for a viewer who is shown it. */
  email?: boolean;
  /** More text the page shows on the row: the status label, the presentation type. */
  extra?: ReadonlyArray<string | null | undefined>;
}

/** Letters that do not come apart into a base letter and an accent. */
const PLAIN_LETTERS: Record<string, string> = { ø: "o", ł: "l", ß: "ss", ı: "i", đ: "d", æ: "ae", œ: "oe" };

/**
 * Lower case, accents removed, typeset punctuation made plain, spaces
 * collapsed: "José  Núñez" reads as "jose nunez", "Crohn’s" as "crohn's",
 * "Long–term" as "long-term", "Søren" as "soren".
 */
function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ­]/g, "")
    .toLowerCase()
    .replace(/[øłßıđæœ]/g, (c) => PLAIN_LETTERS[c] ?? c)
    .replace(/[‘’‛ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** A word as typed, without the punctuation around it: `(A-012):` reads as `a-012`. */
function bareTerm(term: string): string {
  return term.replace(/^[^\p{L}\p{N}#]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "");
}

/**
 * The text a word is looked for in. The number is left out on purpose (see the
 * header). Fields are kept apart so a word cannot match across two of them.
 * The second copy has hyphens and apostrophes removed, so "almansoori" finds
 * "Al-Mansoori" and "obrien" finds "O'Brien".
 */
function searchText(fields: ReadonlyArray<string | null | undefined>): string {
  const text = fields.map((f) => fold(f ?? "")).filter(Boolean).join(" | ");
  return `${text} | ${text.replace(/['-]/g, "")}`;
}

/** Does this abstract match what was typed? An empty search matches everything. */
export function abstractMatchesSearch(
  abstract: SearchableAbstract,
  query: string,
  options: AbstractSearchOptions = {},
): boolean {
  const terms = fold(query).split(" ").map(bareTerm).filter(Boolean);
  if (terms.length === 0) return true;

  const coAuthors = (abstract.coAuthors ?? []).map((c) => `${c?.firstName ?? ""} ${c?.lastName ?? ""}`);
  const text = searchText([
    abstract.title,
    `${abstract.speaker.firstName} ${abstract.speaker.lastName}`,
    abstract.theme?.name,
    abstract.subTheme?.name,
    abstract.track?.name,
    ...coAuthors,
    ...(options.extra ?? []),
  ]);
  const email = options.email ? searchText([abstract.speaker.email]) : "";

  return terms.every((term) => {
    const serial = abstractSerialFromToken(term);
    if (serial !== null && abstract.serialId === serial) return true;
    // "#12" is only ever a number; a bare "12" may also be text in a title.
    if (term.startsWith("#")) return false;
    if (text.includes(term)) return true;
    // A number is not looked for in an email: "12" would find everyone whose
    // address has a 12 in it, which is nobody's meaning.
    return serial === null && email.includes(term);
  });
}
