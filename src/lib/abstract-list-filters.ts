/**
 * The Status and Presentation type filters on the Abstracts page (owner,
 * Nov 20, 2026: "add filters for abstracts, and show them if abstracts exist").
 *
 * The choices are the values the listed abstracts actually have, each with its
 * count, so a filter never offers an answer that would show nothing: an event
 * with no accepted abstract has no "Accepted" choice. With no abstracts there
 * are no choices, and the page shows no filters at all.
 *
 * A chosen value that no listed abstract has any more (the last "Submitted"
 * abstract was just accepted) reads as "all": `effectiveListFilter`. A filter
 * left on a value that vanished would hide the whole list for no visible reason.
 *
 * Client-safe: pure functions over the rows the page already holds.
 */
import { inDecisionOrder, presentationTypeLabel, type PresentationTypeDef } from "@/lib/abstract-presentation-types";
import { abstractStatusWords } from "@/lib/abstract-status-label";

export const ALL = "all";
/** The presentation type choice for abstracts that have none. */
export const NO_TYPE = "none";

/** The order the statuses are offered in: the order an abstract moves through them. */
const STATUS_ORDER = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "REVISION_REQUESTED", "ACCEPTED", "REJECTED", "WITHDRAWN"];

export interface ListFilterOption {
  value: string;
  label: string;
  count: number;
}

interface FilterableAbstract {
  status: string;
  presentationType: string | null;
}

function tally(values: Array<string | null>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) {
    const key = v || NO_TYPE;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Known values first, in their own order; then anything this build does not know, by name. */
function ordered(counts: Map<string, number>, known: string[], labelOf: (value: string) => string): ListFilterOption[] {
  const rest = [...counts.keys()].filter((v) => !known.includes(v) && v !== NO_TYPE).sort();
  return [...known, ...rest]
    .filter((v) => counts.has(v))
    .map((value) => ({ value, label: labelOf(value), count: counts.get(value) ?? 0 }));
}

/** `types` is the event's organisation's list: the type choices follow its order and its names. */
export function abstractFilterOptions(abstracts: ReadonlyArray<FilterableAbstract>, types: readonly PresentationTypeDef[]): {
  statuses: ListFilterOption[];
  types: ListFilterOption[];
} {
  const statusCounts = tally(abstracts.map((a) => a.status));
  const typeCounts = tally(abstracts.map((a) => a.presentationType));
  const typeOptions = ordered(typeCounts, inDecisionOrder(types).map((t) => t.key), (v) => presentationTypeLabel(types, v));
  const untyped = typeCounts.get(NO_TYPE);
  if (untyped) typeOptions.push({ value: NO_TYPE, label: "No type", count: untyped });
  return { statuses: ordered(statusCounts, STATUS_ORDER, abstractStatusWords), types: typeOptions };
}

/** The chosen value, or "all" when no listed abstract has it any more. */
export function effectiveListFilter(chosen: string, options: ReadonlyArray<ListFilterOption>): string {
  return options.some((o) => o.value === chosen) ? chosen : ALL;
}

export function matchesListFilters(a: FilterableAbstract, filters: { status: string; type: string }): boolean {
  if (filters.status !== ALL && a.status !== filters.status) return false;
  if (filters.type === ALL) return true;
  if (filters.type === NO_TYPE) return !a.presentationType;
  return a.presentationType === filters.type;
}
