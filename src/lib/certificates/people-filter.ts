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
 */

import type { RecipientState } from "./recipient-states";

export const PEOPLE_FILTER_ALL = "all";

/** Any / on no list / not assigned / assigned / one of the report's states. */
export type PeopleStatusFilter = typeof PEOPLE_FILTER_ALL | "NO_LIST" | "NOT_ASSIGNED" | "ASSIGNED" | RecipientState;

export interface PeopleFilter {
  /** Matched against the name and the email, whatever the case. */
  search: string;
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
  cells: Record<string, { state: RecipientState }>;
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
  if (filter.registrationType !== PEOPLE_FILTER_ALL && person.registrationType !== filter.registrationType) return false;
  if (filter.attendance === "checked-in" && !person.checkedIn) return false;
  if (filter.attendance === "not-checked-in" && person.checkedIn) return false;
  const answered = person.surveyAnsweredAt !== null;
  if (filter.survey === "answered" && !answered) return false;
  if (filter.survey === "not-answered" && answered) return false;
  return matchesStatus(person, filter, columnIds);
}

/** Whether any filter is narrowing the list (the certificate alone only picks the column). */
export function isPeopleFilterActive(filter: PeopleFilter): boolean {
  return (
    filter.search.trim() !== "" ||
    filter.registrationType !== PEOPLE_FILTER_ALL ||
    filter.attendance !== PEOPLE_FILTER_ALL ||
    filter.survey !== PEOPLE_FILTER_ALL ||
    filter.status !== PEOPLE_FILTER_ALL
  );
}
