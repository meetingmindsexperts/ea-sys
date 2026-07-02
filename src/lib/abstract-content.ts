/**
 * Abstract body word-count limit. The 300-word cap applies to the abstract
 * *content* only — the title and author names are entered separately and are
 * excluded (see the submission guidelines). Shared by the submit/edit forms
 * (live counter) and the abstract create/update API (server-side enforcement).
 */
export const MAX_ABSTRACT_WORDS = 300;

/** Count words in a block of text (whitespace-delimited; empty → 0). */
export function countWords(text: string | null | undefined): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/** True when the content is within the abstract word limit (empty passes — the
 *  min-length check handles "required" separately). */
export function withinAbstractWordLimit(text: string | null | undefined): boolean {
  return countWords(text) <= MAX_ABSTRACT_WORDS;
}
