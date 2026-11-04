/**
 * Which events a new budget can be created for, shared by the New budget
 * dialog and the Import sheet page so the two lists cannot drift.
 *
 * An event needs a code (the archive row and the approval inbox are keyed on
 * it), must not already hold a budget (the POST refuses a second family), and
 * must be running: PUBLISHED or LIVE. A draft event is not yet real, and a
 * completed or cancelled one is over (owner, Nov 4, 2026).
 */
export const BUDGETABLE_EVENT_STATUSES: readonly string[] = ["PUBLISHED", "LIVE"];

export interface BudgetEventOption {
  id: string;
  name: string;
  code: string | null;
  status: string;
}

export function budgetableEvents<T extends BudgetEventOption>(events: readonly T[], budgetedEventIds: ReadonlySet<string | null>): T[] {
  return events.filter((e) => !!e.code && !budgetedEventIds.has(e.id) && BUDGETABLE_EVENT_STATUSES.includes(e.status));
}

/** How many running events are left out only for want of a code, for the hint under the picker. */
export function uncodedRunningCount(events: readonly BudgetEventOption[], budgetedEventIds: ReadonlySet<string | null>): number {
  return events.filter((e) => !e.code && !budgetedEventIds.has(e.id) && BUDGETABLE_EVENT_STATUSES.includes(e.status)).length;
}

export function budgetEventLabel(e: { code: string | null; name: string }): string {
  return `${e.code} · ${e.name}`;
}
