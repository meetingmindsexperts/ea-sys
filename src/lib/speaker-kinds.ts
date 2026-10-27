/**
 * Who a speaker is to the event, for the Speakers page tabs (owner, Oct 27): invited by the organisers, or
 * someone who submitted an abstract (a submitter, and its presenter once accepted). Pure, client-safe.
 */
export type SpeakerKind = "all" | "invited" | "submitters";

type WithAbstracts = { abstracts: { status: string }[] };

/** Abstracts that do not make anyone a submitter: one only started, or taken back (review MED, Oct 27). */
const NOT_SUBMITTED = new Set(["DRAFT", "WITHDRAWN"]);

/**
 * A speaker who has submitted at least one abstract. A draft or a withdrawn one does not count, so an invited
 * speaker who only started an abstract stays on the Invited tab.
 */
export const isSubmitter = (s: WithAbstracts) => s.abstracts.some((a) => !NOT_SUBMITTED.has(a.status));

export const matchesKind = (s: WithAbstracts, kind: SpeakerKind) =>
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
