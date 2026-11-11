/**
 * The Recipients tab's filters (Nov 11, 2026): which people of an event a
 * search and a set of filters keep. Pure and client-safe (its imports are
 * too), so the screen and its tests share one rule.
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

import { parseSerialQuery } from "@/lib/registration-search";
import { pastedTokens, type ResolvableRegistration } from "@/lib/resolve-pasted-ids";
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
  /** Matched against the name and the email, whatever the case, and the registration number. */
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
  /** The registration number; absent or null for a speaker. */
  serialId?: number | null;
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

/**
 * A search finds a person by name or email, or by registration number.
 * Digits alone are ONE number, exactly (owner, Oct 26, 2026, the Registrations
 * page's own rule in registration-search.ts): "12", "012" and "#012" find
 * registration 012 and nothing else. "Contains 12" would list 112, 120, 212
 * too, and "select all that match" would then assign to the wrong people
 * (review of e0ce9f1e).
 */
function matchesSearch(person: FilterablePerson, needle: string): boolean {
  const serial = parseSerialQuery(needle);
  if (serial !== null) return person.serialId === serial;
  return person.name.toLowerCase().includes(needle) || (person.email ?? "").toLowerCase().includes(needle);
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
  if (needle !== "" && !matchesSearch(person, needle)) return false;
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

/**
 * The list with the people brought forward listed FIRST (owner, Nov 11, 2026:
 * "when people are selected, show them in page 1"). `first` is a snapshot
 * taken when the person asks for it (Select by IDs, or "Show them first"),
 * never the live ticks: a row that jumped to the top as its box was ticked
 * would put a different person under the cursor for the next tick.
 *
 * The people brought forward are listed whatever the search and filters say
 * (they were chosen on purpose), in the order they have in `everyone`; the
 * rest of the filtered list follows, without them.
 */
export function listFirst<T extends { id: string }>(
  everyone: readonly T[],
  matching: readonly T[],
  first: ReadonlySet<string>,
): T[] {
  if (first.size === 0) return [...matching];
  return [...everyone.filter((p) => first.has(p.id)), ...matching.filter((p) => !first.has(p.id))];
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

// ── Select by IDs ────────────────────────────────────────────────────────────

interface PastablePerson {
  id: string;
  serialId: number | null;
  email: string | null;
  cancelled: boolean;
}

/**
 * The people as rows for the Select-by-IDs matcher (resolvePastedIds), in the
 * order that makes a SHARED address resolve as "Add from a list of emails"
 * does: to the earliest registration that is not cancelled (review of
 * e0ce9f1e). The matcher keeps the last row it sees for a key, so cancelled
 * rows go first and the lowest registration number goes last. A number or a
 * full id still finds its own row, cancelled or not.
 */
export function pastedIdRows(people: readonly PastablePerson[]): ResolvableRegistration[] {
  const rank = (p: PastablePerson) => (p.cancelled ? 0 : 1);
  const serial = (p: PastablePerson) => p.serialId ?? Number.POSITIVE_INFINITY;
  return [...people]
    .sort((a, b) => rank(a) - rank(b) || serial(b) - serial(a))
    .map((p) => ({ id: p.id, serialId: p.serialId, attendee: { email: p.email } }));
}

/**
 * The pasted addresses that more than one person (not cancelled) shares, so
 * the dialog can say that only one of them was ticked.
 */
export function sharedPastedEmails(text: string, people: readonly PastablePerson[]): string[] {
  const holders = new Map<string, number>();
  for (const p of people) {
    if (p.cancelled || !p.email) continue;
    const key = p.email.toLowerCase();
    holders.set(key, (holders.get(key) ?? 0) + 1);
  }
  return pastedTokens(text)
    .map((t) => t.toLowerCase())
    .filter((t) => (holders.get(t) ?? 0) > 1);
}
