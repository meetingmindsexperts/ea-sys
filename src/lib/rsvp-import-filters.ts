/**
 * RSVP import filters (Oct 23, 2026). Pure and client-safe; used by
 * src/components/rsvp/import-invitees-dialog.tsx to narrow the people already
 * loaded. Cancelled registrations are left out by default.
 */

/** The fields the filters read from a person in the import list. */
export interface FilterablePerson {
  /** Registration status, or the speaker's status on the speaker tabs. */
  status?: string;
  typeId?: string;
  paymentStatus?: string;
  badgeType?: string;
}

/** "Any" for every filter; status also has the default "not cancelled". */
export const ANY = "__any__";
export const NOT_CANCELLED = "__not_cancelled__";

export interface Filters {
  type: string;
  status: string;
  payment: string;
  badge: string;
}

export const DEFAULT_FILTERS: Filters = { type: ANY, status: NOT_CANCELLED, payment: ANY, badge: ANY };
/** Speakers start with every status shown. */
export const SPEAKER_DEFAULT_FILTERS: Filters = { ...DEFAULT_FILTERS, status: ANY };

/** "COMPLIMENTARY" becomes "Complimentary". */
export function titleCase(v: string): string {
  return v.charAt(0) + v.slice(1).toLowerCase().replace(/_/g, " ");
}

function matchesStatus(person: FilterablePerson, wanted: string): boolean {
  if (wanted === ANY) return true;
  if (wanted === NOT_CANCELLED) return person.status !== "CANCELLED";
  return person.status === wanted;
}

export function matchesFilters(person: FilterablePerson, f: Filters): boolean {
  if (!matchesStatus(person, f.status)) return false;
  if (f.type !== ANY && person.typeId !== f.type) return false;
  if (f.payment !== ANY && person.paymentStatus !== f.payment) return false;
  return f.badge === ANY || (person.badgeType ?? "") === f.badge;
}

/** Distinct values, sorted, for a filter's options. */
export function distinct(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))].sort();
}
