/**
 * An event's web address (`/e/{slug}`): what it may contain, and how one is
 * made from a name (Nov 16, 2026). Pure and client-safe: the Settings form
 * cleans as you type with it and the event save route applies it again.
 *
 * Why: the slug box saved whatever was typed. On Nov 16, 2026 a webinar's slug
 * became "Improving Outcomes in β-Thalassemia" (its name, pasted), every link
 * to it was invalid, Zoom refused the custom stream setup four times, and its
 * handouts would not load. A slug may hold only letters, digits and hyphens.
 * Greek letters, common in medical names, are written out in English
 * (β-Thalassemia becomes beta-thalassemia) rather than dropped, and accents are
 * removed (é becomes e).
 *
 * Case is kept as typed (MEHF2027 stays MEHF2027: existing slugs are links
 * already sent); one made from a name is lower case.
 */

const GREEK: Record<string, string> = {
  α: "alpha",
  β: "beta",
  γ: "gamma",
  δ: "delta",
  ε: "epsilon",
  ζ: "zeta",
  η: "eta",
  θ: "theta",
  ι: "iota",
  κ: "kappa",
  λ: "lambda",
  μ: "mu",
  ν: "nu",
  ξ: "xi",
  ο: "omicron",
  π: "pi",
  ρ: "rho",
  σ: "sigma",
  ς: "sigma",
  τ: "tau",
  υ: "upsilon",
  φ: "phi",
  χ: "chi",
  ψ: "psi",
  ω: "omega",
};

/** Latin letters that do not decompose into a base letter and an accent. */
const LATIN_EXTRA: Record<string, string> = { ß: "ss", æ: "ae", Æ: "AE", ø: "o", Ø: "O", œ: "oe", Œ: "OE", đ: "d", Đ: "D", ł: "l", Ł: "L", þ: "th", Þ: "TH" };

/** Combining accents, left behind by NFKD (é becomes e plus an accent). */
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Text written in plain Latin letters where it can be: accents removed, Greek
 * letters spelled out (an upper-case one capitalised: Β becomes Beta), a few
 * Latin letters expanded. Anything else (Arabic, say) is left for the caller
 * to drop.
 */
export function toAsciiLetters(text: string): string {
  return Array.from(text.normalize("NFKD").replace(COMBINING_MARKS, ""))
    .map((ch) => {
      if (LATIN_EXTRA[ch]) return LATIN_EXTRA[ch];
      const lower = ch.toLowerCase();
      const greek = GREEK[lower];
      if (!greek) return ch;
      return ch === lower ? greek : greek[0].toUpperCase() + greek.slice(1);
    })
    .join("");
}

/**
 * What the slug box keeps while someone types: spaces and underscores become
 * hyphens, anything that is not a letter, digit or hyphen goes. The ends are
 * NOT trimmed, or a hyphen could never be typed.
 */
export function cleanEventSlugInput(text: string): string {
  return toAsciiLetters(text)
    .replace(/[\s_]+/g, "-")
    .replace(/[^A-Za-z0-9-]/g, "")
    .replace(/-{2,}/g, "-");
}

export const EVENT_SLUG_MAX = 200;

/** A finished slug: cleaned, no hyphen at either end, at most 200 characters. May be empty. */
export function normalizeEventSlug(text: string): string {
  return cleanEventSlugInput(text).slice(0, EVENT_SLUG_MAX).replace(/^-+|-+$/g, "");
}

/** A slug made from an event's name: as normalizeEventSlug, in lower case. */
export function eventSlugFromName(name: string): string {
  return normalizeEventSlug(name).toLowerCase();
}

/** Whether a stored slug is already safe in a web address. */
export function isValidEventSlug(slug: string): boolean {
  return slug.length >= 2 && slug === normalizeEventSlug(slug);
}
