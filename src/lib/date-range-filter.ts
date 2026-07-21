/**
 * Shared created/updated date-range filters for list endpoints (July 21, 2026,
 * integrator request — incremental syncs like the n8n→Webflow people sync
 * previously had to full-pull every run because nothing was filterable by
 * "changed since my last checkpoint").
 *
 * One parser for every surface (REST speakers + registrations GETs, MCP
 * `list_speakers` / `list_registrations`) so the param names, inclusivity, and
 * validation can't drift per caller — the no-cross-caller-duplication rule.
 *
 * Params (all optional, ISO 8601 datetimes, bounds INCLUSIVE):
 *   createdAfter  → createdAt >= value
 *   createdBefore → createdAt <= value
 *   updatedAfter  → updatedAt >= value   ← the incremental-sync checkpoint
 *   updatedBefore → updatedAt <= value
 *
 * An unparsable value is an ERROR result, never a silently-dropped filter — a
 * typo'd checkpoint that silently widened to "everything" is exactly the
 * bad-filter class the July 13 bulk-email INVALID_FILTER fix closed.
 */

export const DATE_RANGE_PARAMS = [
  "createdAfter",
  "createdBefore",
  "updatedAfter",
  "updatedBefore",
] as const;
export type DateRangeParam = (typeof DATE_RANGE_PARAMS)[number];

export interface DateRangeWhere {
  createdAt?: { gte?: Date; lte?: Date };
  updatedAt?: { gte?: Date; lte?: Date };
}

export type DateRangeFilterResult =
  | { ok: true; where: DateRangeWhere; active: boolean }
  | { ok: false; param: DateRangeParam; value: string; message: string };

const PARAM_TO_WHERE: Record<DateRangeParam, { field: "createdAt" | "updatedAt"; op: "gte" | "lte" }> = {
  createdAfter: { field: "createdAt", op: "gte" },
  createdBefore: { field: "createdAt", op: "lte" },
  updatedAfter: { field: "updatedAt", op: "gte" },
  updatedBefore: { field: "updatedAt", op: "lte" },
};

/**
 * `get` abstracts the input source: REST passes
 * `(k) => searchParams.get(k)`, MCP passes a lookup over the tool input.
 * Absent/empty values are simply inactive; anything present must parse.
 */
export function parseDateRangeFilters(
  get: (name: DateRangeParam) => string | null | undefined,
): DateRangeFilterResult {
  const where: DateRangeWhere = {};
  let active = false;
  for (const param of DATE_RANGE_PARAMS) {
    const raw = get(param);
    if (raw == null || String(raw).trim() === "") continue;
    const value = String(raw).trim();
    const date = new Date(value);
    if (isNaN(date.getTime())) {
      return {
        ok: false,
        param,
        value,
        message: `Invalid ${param} "${value}" — must be an ISO 8601 datetime (e.g. 2026-07-21T00:00:00Z)`,
      };
    }
    const { field, op } = PARAM_TO_WHERE[param];
    where[field] = { ...where[field], [op]: date };
    active = true;
  }
  return { ok: true, where, active };
}
