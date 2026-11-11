/**
 * The Recipients tab's filters (Nov 11, 2026): which people of an event a
 * search and a set of filters keep. Pure and client-safe, so the screen and
 * its tests share one rule.
 *
 * The tab lists EVERYONE at the event, one line per person with a cell per
 * certificate. A status therefore needs a certificate to be asked about:
 *
 *   one certificate chosen   the status is that certificate's cell
 *   all certificates         "Not assigned" means on NONE of the lists shown,
 *                            "Assigned" means on at least one, and a state
 *                            (Sent, Waiting for survey, ...) means some
 *                            certificate of theirs is in that state
 *
 * "Answered, on no list" is the server's own list of people who answered the
 * certificate survey and are assigned nothing, on their registration or on
 * their speaker record (recipients-report.ts): the people a tag used to lose.
 *
 * SPEAKERS ARE NOT ALL SPEAKERS (review of a5134945). An event's speaker
 * records include everyone who submitted an abstract or proposed a session,
 * and speakers who declined. The speakers view therefore opens on the
 * organisers' own faculty ("invited", not declined or cancelled), plus anyone
 * already on a certificate's list, so "select all" there cannot hand an
 * appreciation certificate to 200 abstract authors. The other groups are one
 * choice away.
 */

import type { RecipientState } from "./recipient-states";

export const PEOPLE_FILTER_ALL = "all";

/** Any / on no list / not assigned / assigned / one of the report's states. */
export type PeopleStatusFilter = typeof PEOPLE_FILTER_ALL | "NO_LIST" | "NOT_ASSIGNED" | "ASSIGNED" | RecipientState;

/**
 * Which speakers: one group each (speakerBucketOf), or everyone. "invited" is
 * the default and also keeps anyone already on a list.
 */
export type SpeakerBucket = "invited" | "submitters" | "proposers" | "inactive";
export type SpeakerBucketFilter = typeof PEOPLE_FILTER_ALL | SpeakerBucket;

export const SPEAKER_BUCKET_LABELS: Record<SpeakerBucket, string> = {
  invited: "Invited speakers",
  submitters: "Abstract submitters",
  proposers: "Session proposers",
  inactive: "Declined or cancelled",
};

/**
 * A speaker's one group: declined or cancelled first, else who they are to
 * the event (src/lib/speaker-kinds.ts, the Speakers page's own tabs).
 */
export function speakerBucketOf(status: string, kind: "invited" | "submitters" | "proposers"): SpeakerBucket {
  return status === "DECLINED" || status === "CANCELLED" ? "inactive" : kind;
}

export interface PeopleFilter {
  /** Matched against the name and the email, whatever the case. */
  search: string;
  /** Speakers only: which group. Ignored for a registration. */
  speakers: SpeakerBucketFilter;
  /** A registration type's name, or all. */
  registrationType: string;
  attendance: typeof PEOPLE_FILTER_ALL | "checked-in" | "not-checked-in";
  survey: typeof PEOPLE_FILTER_ALL | "answered" | "not-answered";
  /** A template id, or all. */
  templateId: string;
  status: PeopleStatusFilter;
}

export const EMPTY_PEOPLE_FILTER: PeopleFilter = {
  search: "",
  speakers: "invited",
  registrationType: PEOPLE_FILTER_ALL,
  attendance: PEOPLE_FILTER_ALL,
  survey: PEOPLE_FILTER_ALL,
  templateId: PEOPLE_FILTER_ALL,
  status: PEOPLE_FILTER_ALL,
};

export interface FilterablePerson {
  name: string;
  email: string | null;
  registrationType: string | null;
  checkedIn: boolean;
  surveyAnsweredAt: string | Date | null;
  noList: boolean;
  /** A speaker's group; null or absent for a registration. */
  speakerBucket?: SpeakerBucket | null;
  cells: Record<string, { state: RecipientState }>;
}

/** The speakers a group choice keeps. The default also keeps anyone already on a list shown. */
function matchesSpeakers(person: FilterablePerson, filter: PeopleFilter, columnIds: readonly string[]): boolean {
  if (!person.speakerBucket || filter.speakers === PEOPLE_FILTER_ALL) return true;
  if (person.speakerBucket === filter.speakers) return true;
  return filter.speakers === "invited" && columnIds.some((id) => person.cells[id] !== undefined);
}

function matchesStatus(person: FilterablePerson, filter: PeopleFilter, columnIds: readonly string[]): boolean {
  if (filter.status === PEOPLE_FILTER_ALL) return true;
  if (filter.status === "NO_LIST") return person.noList;
  // The cells the status is asked about: one certificate's, or every one shown.
  const asked = filter.templateId === PEOPLE_FILTER_ALL ? columnIds : [filter.templateId];
  const held = asked.flatMap((id) => (person.cells[id] ? [person.cells[id]] : []));
  if (filter.status === "NOT_ASSIGNED") return held.length === 0;
  if (filter.status === "ASSIGNED") return held.length > 0;
  return held.some((cell) => cell.state === filter.status);
}

/**
 * Does this person pass the filters? `columnIds` are the certificates shown
 * for their kind (attendance ones for registrations, appreciation ones for
 * speakers): what "all certificates" means.
 */
export function matchesPeopleFilter(person: FilterablePerson, filter: PeopleFilter, columnIds: readonly string[]): boolean {
  const needle = filter.search.trim().toLowerCase();
  if (needle !== "" && !person.name.toLowerCase().includes(needle) && !(person.email ?? "").toLowerCase().includes(needle)) {
    return false;
  }
  if (!matchesSpeakers(person, filter, columnIds)) return false;
  if (filter.registrationType !== PEOPLE_FILTER_ALL && person.registrationType !== filter.registrationType) return false;
  if (filter.attendance === "checked-in" && !person.checkedIn) return false;
  if (filter.attendance === "not-checked-in" && person.checkedIn) return false;
  const answered = person.surveyAnsweredAt !== null;
  if (filter.survey === "answered" && !answered) return false;
  if (filter.survey === "not-answered" && answered) return false;
  return matchesStatus(person, filter, columnIds);
}

/**
 * Whether anything was changed from how the list opens (the certificate alone
 * only picks the column): what "Clear filters" would undo.
 */
export function isPeopleFilterActive(filter: PeopleFilter): boolean {
  return (
    filter.search.trim() !== "" ||
    filter.speakers !== EMPTY_PEOPLE_FILTER.speakers ||
    filter.registrationType !== PEOPLE_FILTER_ALL ||
    filter.attendance !== PEOPLE_FILTER_ALL ||
    filter.survey !== PEOPLE_FILTER_ALL ||
    filter.status !== PEOPLE_FILTER_ALL
  );
}

// ── The selection ────────────────────────────────────────────────────────────

/**
 * The ticked people who are still at the event, in the order listed. The list
 * refetches while the page is open (and after every assignment), so a ticked
 * id can outlive its person; the dialog is only ever handed these.
 */
export function liveSelection(selected: ReadonlySet<string>, everyone: ReadonlyArray<{ id: string }>): string[] {
  return everyone.filter((p) => selected.has(p.id)).map((p) => p.id);
}

/**
 * Of the ticked people, how many the current search and filters do NOT show.
 * A selection survives a search (tick 40, search for the 41st), so the bar
 * says when some of it is out of sight.
 */
export function hiddenSelectionCount(selected: ReadonlySet<string>, listed: ReadonlyArray<{ id: string }>): number {
  const shown = listed.filter((p) => selected.has(p.id)).length;
  return Math.max(0, selected.size - shown);
}

/** The ids of one kind, as the assign and remove calls take them. */
export function assignmentIdsBody(
  category: "ATTENDANCE" | "APPRECIATION",
  ids: string[],
): { registrationIds: string[] } | { speakerIds: string[] } {
  return category === "ATTENDANCE" ? { registrationIds: ids } : { speakerIds: ids };
}

/**
 * Whether a person can be taken off a certificate's list. Someone who HOLDS
 * the certificate stays (taking it back is revoking it); once it is revoked
 * they can go, as the service allows.
 */
export function canRemoveFromList(cell: { state: RecipientState; certificate: unknown | null }): boolean {
  return cell.certificate === null || cell.state === "REVOKED";
}
