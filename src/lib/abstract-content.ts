/**
 * Word counting for abstracts. The caps themselves are per-event and live in
 * src/lib/abstract-limits.ts; this file holds only the counting rule, so the
 * forms' live counter and the API's enforcement can never disagree about what
 * "a word" is.
 *
 * The body limit applies to the abstract CONTENT only. The title has its own
 * limit and author names are entered separately, per the submission guidelines.
 */

/** Count words in a block of text (whitespace-delimited; empty -> 0). */
export function countWords(text: string | null | undefined): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}
