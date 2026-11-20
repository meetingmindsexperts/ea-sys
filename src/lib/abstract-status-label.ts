/**
 * THE word shown for an abstract's status, to staff and to the author alike
 * (owner, Nov 20, 2026).
 *
 * A status the organisers set to REJECTED reads "NOT ACCEPTED": on screens,
 * in filters, and in the `{{newStatus}}` of the decision email. "Rejected" in
 * an author's inbox sounded harsher than the decision is, and one word
 * everywhere means staff and authors talk about the same thing. Only the word
 * changes: the stored status is still REJECTED, and so are the API, the
 * exports and the assistant's tools, which other systems read.
 *
 * The other statuses read as they are stored, with spaces ("UNDER REVIEW").
 * Sentence-case labels ("Under review") are the caller's to make with
 * `abstractStatusWords`. Pure, client-safe.
 */
export function abstractStatusLabel(status: string): string {
  return status === "REJECTED" ? "NOT ACCEPTED" : status.replace(/_/g, " ");
}

/** The same word in sentence case: "Not accepted", "Under review". */
export function abstractStatusWords(status: string): string {
  const upper = abstractStatusLabel(status);
  return upper.charAt(0) + upper.slice(1).toLowerCase();
}
