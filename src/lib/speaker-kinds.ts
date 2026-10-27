/**
 * Who a speaker is to the event, for the Speakers page tabs (owner, Oct 27): invited by the organisers, or
 * someone who submitted an abstract (a submitter, and its presenter once accepted). Pure, client-safe.
 */
export type SpeakerKind = "all" | "invited" | "submitters" | "proposers";

/** Either list is absent when the caller may not read it (speaker-submission-visibility.ts). */
type WithSubmissions = { abstracts?: { status: string }[]; sessionProposals?: { status: string }[] };

/** Abstracts and proposals that do not make anyone a submitter: one only started, or taken back (review MED, Oct 27). */
const NOT_SUBMITTED = new Set(["DRAFT", "WITHDRAWN"]);
const submitted = (items: { status: string }[] | undefined) => (items ?? []).some((a) => !NOT_SUBMITTED.has(a.status));

/**
 * A speaker who has submitted at least one abstract. A draft or a withdrawn one does not count, so an invited
 * speaker who only started an abstract stays on the Invited tab.
 */
export const isSubmitter = (s: WithSubmissions) => submitted(s.abstracts);

/**
 * A speaker who proposed a session (owner, Oct 27) and is not an abstract submitter: someone who signed up to
 * propose, and so has no complimentary registration unless the organiser grants one (Aug 5 ruling).
 */
export const isProposer = (s: WithSubmissions) => !isSubmitter(s) && submitted(s.sessionProposals);

/** Each speaker is in exactly one group: abstract submitter, else session proposer, else invited. */
export function speakerKindOf(s: WithSubmissions): Exclude<SpeakerKind, "all"> {
  if (isSubmitter(s)) return "submitters";
  return isProposer(s) ? "proposers" : "invited";
}

export const matchesKind = (s: WithSubmissions, kind: SpeakerKind) => kind === "all" || speakerKindOf(s) === kind;

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
