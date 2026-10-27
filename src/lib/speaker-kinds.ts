/**
 * Who a speaker is to the event, for the Speakers page tabs (owner, Oct 27): invited by the organisers, or
 * someone who submitted an abstract (a submitter, and its presenter once accepted). Pure, client-safe.
 */
export type SpeakerKind = "all" | "invited" | "submitters" | "proposers";

/**
 * Either list is absent when the caller may not read it (speaker-submission-visibility.ts). `submitterSource` is
 * the public sign-up door the speaker came through ("abstract", "proposal" or "both"), null when organisers added
 * them; `_count` holds how many session roles and topics they speak on.
 */
type WithSubmissions = {
  abstracts?: { status: string }[];
  sessionProposals?: { status: string }[];
  submitterSource?: string | null;
  _count?: { sessions?: number; topicSpeakers?: number };
};

/** Abstracts and proposals that do not make anyone a submitter: one only started, or taken back (review MED, Oct 27). */
const NOT_SUBMITTED = new Set(["DRAFT", "WITHDRAWN"]);
const submitted = (items: { status: string }[] | undefined) => (items ?? []).some((a) => !NOT_SUBMITTED.has(a.status));

/**
 * A speaker who has submitted at least one abstract. A draft or a withdrawn one does not count. An invited
 * speaker who only started one stays on Invited, unless the abstract sign-in stamped their submitterSource and
 * they are not on the programme yet: then signupKind puts them on Submitters (accepted by the owner, Oct 27).
 */
export const isSubmitter = (s: WithSubmissions) => submitted(s.abstracts);

/**
 * A speaker who proposed a session (owner, Oct 27) and is not an abstract submitter: someone who signed up to
 * propose, and so has no complimentary registration unless the organiser grants one (Aug 5 ruling).
 */
export const isProposer = (s: WithSubmissions) => !isSubmitter(s) && submitted(s.sessionProposals);

/**
 * The group of someone who signed up through a public door and has submitted nothing yet (MEHF 2027, Oct 27): the
 * door they came through, never Invited, which is the organisers' own faculty. A speaker the organisers put on
 * the programme counts as invited whatever door they once used.
 */
function signupKind(s: WithSubmissions): Exclude<SpeakerKind, "all"> {
  const onProgramme = (s._count?.sessions ?? 0) + (s._count?.topicSpeakers ?? 0) > 0;
  if (!s.submitterSource || onProgramme) return "invited";
  return s.submitterSource === "proposal" ? "proposers" : "submitters";
}

/**
 * Each speaker is in exactly one group: abstract submitter, else session proposer, else (with nothing submitted)
 * the sign-up door they came through, else invited.
 */
export function speakerKindOf(s: WithSubmissions): Exclude<SpeakerKind, "all"> {
  if (isSubmitter(s)) return "submitters";
  if (isProposer(s)) return "proposers";
  return signupKind(s);
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
