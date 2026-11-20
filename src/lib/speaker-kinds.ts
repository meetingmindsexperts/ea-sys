/**
 * Who a speaker is to the event, for the Speakers page tabs (owner, Oct 27): invited by the organisers, or
 * someone who submitted an abstract (a submitter, and its presenter once accepted). Pure, client-safe.
 *
 * INVITED AND AN AUTHOR (owner, Nov 20, 2026: authors are kept apart from the faculty "except for those who are
 * invited and submitted, and submitted and later got invited"). Someone who has submitted is listed with the
 * invited speakers on ONE fact: their registration is on the Faculty type. That type is only ever given to a
 * speaker the organisers chose (the companion made when staff add a speaker, or "Make Faculty" for someone who
 * submitted first), so it is the organisers' own statement, and they can change it.
 *
 * What is deliberately NOT read for this (review of 8eaa3550, MED):
 *   - the sign-up door on the record (`submitterSource`). It is stamped on an organiser-made record the moment
 *     that speaker signs in through the abstract link, and it is null on a record staff made only to enter an
 *     author's abstract, so it says neither "invited" nor "not invited" about someone who submitted.
 *   - a place on the programme. An accepted author given a talk is scheduled like any speaker and is still an
 *     author. (With nothing submitted, a place on the programme does count: signupKind.)
 *
 * The Registrations page's Speaker filter asks this same function (author-facts-server.ts).
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
  /** Their live registration is on the Faculty type: invited, whatever they submitted. Absent reads as no. */
  onFacultyType?: boolean;
  _count?: { sessions?: number; topicSpeakers?: number };
};

/**
 * Is the registration a speaker record points at a live one on the Faculty type? The pointer is enough here:
 * a Faculty registration is only ever made for a speaker record, and making it sets the pointer.
 */
export const registrationOnFacultyType = (registration: { status: string; ticketType: { isFaculty: boolean } | null } | null | undefined) =>
  !!registration && registration.status !== "CANCELLED" && registration.ticketType?.isFaculty === true;

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
 * Each speaker is in exactly one group: on the Faculty type (invited, whatever they submitted), else abstract
 * submitter, else session proposer, else (with nothing submitted) the sign-up door they came through, else invited.
 */
export function speakerKindOf(s: WithSubmissions): Exclude<SpeakerKind, "all"> {
  if (s.onFacultyType === true) return "invited";
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
