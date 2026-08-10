/**
 * How many rows each CRM list surface returns, in one place.
 *
 * WHY THIS EXISTS. These were three bare `take:` literals in three route files,
 * and nothing told the operator when one bit. A board showing 1,000 of 10,412
 * deals with no notice does not look broken — it looks like a pipeline with
 * 1,000 deals in it, and every total read off that screen is wrong. Silent
 * truncation on a sales pipeline is worse than an obviously empty screen.
 *
 * So: the cap lives here, every list route returns the TRUE total alongside the
 * rows, and the UI says so. The caps are a rendering budget, not a correctness
 * mechanism — correctness is the `total` the routes now return.
 *
 * Client-safe (no imports): the banner copy and the query read the same numbers.
 */

/**
 * The board renders every card with no virtualisation, so this is bounded by the
 * DOM, not the database. Raising it further makes the board slower without
 * making it more useful — nobody reads 5,000 cards. Filtering is the real answer,
 * which is what the banner says.
 */
export const CRM_DEALS_LIST_CAP = 2000;

/** A table, so it tolerates more rows than the board does. */
export const CRM_CONTACTS_LIST_CAP = 1000;

/** Accounts are the smallest of the three populations by an order of magnitude. */
export const CRM_COMPANIES_LIST_CAP = 1000;

/** Shape every capped CRM list route returns. */
export interface CrmListMeta {
  /** Rows matching the filters, ignoring the cap — the honest number. */
  total: number;
  /** True when the cap hid some of them. */
  truncated: boolean;
}

/** Build the meta for a page of rows. */
export function listMeta(total: number, returned: number): CrmListMeta {
  return { total, truncated: total > returned };
}
