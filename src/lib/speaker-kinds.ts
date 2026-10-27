/**
 * Who a speaker is to the event, for the Speakers page tabs (owner, Oct 27): invited by the organisers, or
 * someone who submitted an abstract (a submitter, and its presenter once accepted). A speaker with an abstract
 * counts as a submitter. Pure, client-safe.
 */
export type SpeakerKind = "all" | "invited" | "submitters";

export const isSubmitter = (s: { _count: { abstracts: number } }) => s._count.abstracts > 0;

export const matchesKind = (s: { _count: { abstracts: number } }, kind: SpeakerKind) =>
  kind === "all" || (kind === "submitters") === isSubmitter(s);

/**
 * Who "Email" sends to: the ticked speakers, else everyone listed when a tab narrows the list (the filters
 * cannot express a tab), else no ids, meaning the status-wide audience.
 */
export function emailRecipientIds(selected: Set<string>, narrowed: boolean, listed: { id: string }[]): string[] {
  if (selected.size > 0) return Array.from(selected);
  return narrowed ? listed.map((s) => s.id) : [];
}

/**
 * Whether there is anyone to email. A narrowed list that is empty must not offer a send: no ids reach the server
 * as "everyone of the status" (review HIGH, Oct 27).
 */
export function canEmailListed(selectedCount: number, narrowed: boolean, listedCount: number, totalCount: number): boolean {
  if (selectedCount > 0) return true;
  return narrowed ? listedCount > 0 : totalCount > 0;
}
