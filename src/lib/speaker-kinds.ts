/**
 * Who a speaker is to the event, for the Speakers page tabs (owner, Oct 27): invited by the organisers, or
 * someone who submitted an abstract (a submitter, and its presenter once accepted). Pure, client-safe.
 *
 * INVITED AND AN AUTHOR (owner, Nov 20, 2026: authors are kept apart from the faculty "except for those who are
 * invited and submitted, and submitted and later got invited"). Someone who has submitted is listed with the
 * invited speakers when THE ORGANISERS put them on the Faculty type (`facultyByOrganisers`):
 *   - a speaker the organisers added themselves (no sign-up door on the record) whose registration is on the
 *     Faculty type: the companion made when staff add a speaker; or
 *   - a registration made Faculty by hand: Add registration as Faculty, or "Make Faculty" on the sheet, which
 *     is the organisers saying "this one is faculty" about someone who registered or submitted first.
 *
 * What does NOT say invited, each tried and dropped (reviews of 8eaa3550 and 54404a7a):
 *   - the Faculty type alone. Until Nov 20, 2026 an abstract sign-up with no presenter rate was GIVEN a Faculty
 *     registration, so a sign-up door on the record plus an automatic Faculty registration is what any author
 *     of that time has (33 on one production event). They stay with the submitters, where they always were,
 *     until an organiser moves them off Faculty.
 *   - the sign-up door alone. It is absent on a record staff made only to enter an author's abstract, and
 *     until Nov 20, 2026 the abstract door stamped it on an invited speaker's record when they signed in to
 *     submit (it no longer does: `submitterSourceStamp` in speaker-companion.ts; a record stamped before then
 *     keeps the stamp until it is corrected by hand).
 *   - a place on the programme. An accepted author given a talk is scheduled like any speaker and is still an
 *     author. (With nothing submitted, a place on the programme does count: signupKind.)
 *
 * The Registrations page's Speaker filter asks this same function with each row's own facts
 * (author-facts-server.ts).
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
  /** Their live registration is on the Faculty type. Absent reads as no. */
  onFacultyType?: boolean;
  /** That registration was made Faculty by hand (FACULTY_BY_HAND_SOURCE), not by the automatic companion. */
  facultyByHand?: boolean;
  _count?: { sessions?: number; topicSpeakers?: number };
};

/** How a registration made Faculty by a person is marked: Add registration as Faculty, and Make Faculty. */
export const FACULTY_BY_HAND_SOURCE = "FACULTY_ADMIN";

/** What is read of the registration a speaker record points at (or, on Registrations, of the row itself). */
type FacultyRegistration = { status: string; createdSource?: string | null; ticketType: { isFaculty: boolean } | null };

/** A live registration on the Faculty type. */
export const registrationOnFacultyType = (registration: FacultyRegistration | null | undefined) =>
  !!registration && registration.status !== "CANCELLED" && registration.ticketType?.isFaculty === true;

/** ...and one a person made Faculty, as opposed to the companion made automatically for a speaker record. */
export const registrationFacultyByHand = (registration: FacultyRegistration | null | undefined) =>
  registrationOnFacultyType(registration) && registration?.createdSource === FACULTY_BY_HAND_SOURCE;

/**
 * The organisers put this person on the Faculty type (see the header). Only a KNOWN null door counts: the field
 * is removed for a caller who may not read the submissions (speaker-submission-visibility.ts), and "not told"
 * must never read as "the organisers added them".
 */
export const facultyByOrganisers = (s: Pick<WithSubmissions, "onFacultyType" | "facultyByHand" | "submitterSource">) =>
  s.onFacultyType === true && (s.facultyByHand === true || s.submitterSource === null);

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
 * Each speaker is in exactly one group: put on Faculty by the organisers (invited, whatever they submitted), else
 * abstract submitter, else session proposer, else (with nothing submitted) the sign-up door they came through,
 * else invited.
 */
export function speakerKindOf(s: WithSubmissions): Exclude<SpeakerKind, "all"> {
  if (facultyByOrganisers(s)) return "invited";
  if (isSubmitter(s)) return "submitters";
  if (isProposer(s)) return "proposers";
  return signupKind(s);
}

/**
 * The tab the Speakers page opens on. Authors are kept apart from the faculty (owner, Nov 20, 2026), so an event
 * that has both opens on the invited speakers; an event with nothing to tell apart, or with no invited speaker
 * to show, opens on everyone. `tabs` is what the caller can be shown: without the Invited tab (the abstracts or
 * proposals are hidden from them) it opens on everyone.
 */
export function openingKind(tabs: readonly SpeakerKind[], invitedCount: number): SpeakerKind {
  const split = tabs.includes("submitters") || tabs.includes("proposers");
  return split && tabs.includes("invited") && invitedCount > 0 ? "invited" : "all";
}

/**
 * An accepted author with no registration at all: nothing for "Make presenters" to make Complimentary, and no
 * badge on the day. `hasRegistration` is absent when the caller may not read registrations, and absent never
 * reads as "none".
 */
export const acceptedWithoutRegistration = (s: { hasRegistration?: boolean; abstracts?: { status: string }[] }) =>
  s.hasRegistration === false && (s.abstracts ?? []).some((a) => a.status === "ACCEPTED");

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
