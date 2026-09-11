/**
 * Template tokens, ONE definition (Sep 11, 2026).
 *
 * `{{name}}` is what renderTemplate substitutes. Two things kept breaking it
 * in production, four or five times over the summer, each time on one send
 * path and not another:
 *
 *  1. The WYSIWYG editor wraps or splits a token with inline markup when an
 *     organiser edits it in place: `{{<span>rsvpButton</span>}}`,
 *     `{{rsvp<strong>Button</strong>}}`, `<span>{{</span>x<span>}}</span>`,
 *     or a `&nbsp;` inside the braces. The renderer's regex cannot see through
 *     a tag, so the token went out literally while looking correct on screen.
 *     `normalizeTemplateTokens()` collapses those back to `{{name}}`; every
 *     renderer and every template save runs it.
 *  2. A token one send path provides and another does not, or a typo, went
 *     out as literal text and reported success. `findUnresolvedTokens()` is
 *     what `sendEmail` refuses on, so the failure is loud and names the token.
 *
 * Client-safe: no db, no Node imports. Both editors use it too.
 */

const TAG = String.raw`<\/?[A-Za-z][^>]*>`;
const NBSP = String.raw`(?:&nbsp;| )`;

/** `{{` … `}}` whose inside is one word, possibly interrupted by tags, spaces or nbsp. */
const MANGLED_TOKEN_RE = new RegExp(String.raw`\{\{((?:${TAG}|${NBSP}|\s|\w)+?)\}\}`, "g");
const TAG_RE = new RegExp(TAG, "g");
const NBSP_RE = new RegExp(NBSP, "g");

/** Anything that still looks like a token after rendering, tags inside tolerated. */
const ANY_TOKEN_RE = /\{\{([^{}]{1,120})\}\}/g;

export const UNRESOLVED_TOKENS_CODE = "UNRESOLVED_TOKENS";

/**
 * Collapse editor-mangled tokens back to `{{name}}`. Anything that is not a
 * single word inside the braces is left exactly as it was.
 */
export function normalizeTemplateTokens(source: string): string {
  if (!source || !source.includes("{{")) return source;
  return source.replace(MANGLED_TOKEN_RE, (match, inner: string) => {
    const name = inner.replace(TAG_RE, "").replace(NBSP_RE, "").replace(/\s+/g, "");
    return /^\w+$/.test(name) ? `{{${name}}}` : match;
  });
}

/**
 * The token names still present in the given rendered parts, unique, in
 * order of first appearance. Tags and nbsp inside the braces are stripped so
 * a mangled remnant is reported by its name, not its markup.
 */
export function findUnresolvedTokens(...parts: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (typeof part !== "string" || !part.includes("{{")) continue;
    for (const m of part.matchAll(ANY_TOKEN_RE)) {
      const name = m[1].replace(TAG_RE, "").replace(NBSP_RE, "").trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}
