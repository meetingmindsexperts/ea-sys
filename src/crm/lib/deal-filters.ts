/**
 * Deal + task list filter parsing.
 *
 * Pure functions that turn URL query params into a Prisma `where` fragment. Kept
 * out of the route handlers so the two things that are easy to get wrong live in
 * ONE tested place:
 *
 * 1. THE VALUE FILTER IS FINANCE-GATED. MEMBER has deal values redacted. If MEMBER
 *    could ALSO filter by value, a redacted value becomes searchable — "show deals
 *    over $100k … over $150k … over $175k" binary-searches the exact number the
 *    redaction was meant to hide. So `buildDealWhere` DROPS the value filter unless
 *    the caller may see values. The UI hides the control too, but the server is the
 *    authority — a hand-crafted `?min=` from a MEMBER token must do nothing.
 *
 * 2. A BAD DATE MUST NARROW TO NOTHING, NOT WIDEN TO EVERYTHING. An unparseable
 *    `from`/`to` is ignored rather than silently dropping the whole predicate — the
 *    bulk-email M7 lesson (a bad filter value that widens the audience is worse than
 *    one that errors).
 */
import type { Prisma } from "@prisma/client";

export type DealDateField = "expectedClose" | "createdAt" | "closed";

const DATE_FIELDS = new Set<DealDateField>(["expectedClose", "createdAt", "closed"]);

/** Parse a YYYY-MM-DD (or ISO) string to a Date, or null if unparseable. */
function parseDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A `to` date is inclusive of the whole day — bump it to the end of that day. */
function endOfDay(d: Date): Date {
  const e = new Date(d);
  e.setHours(23, 59, 59, 999);
  return e;
}

export interface DealFilterParams {
  ownerId?: string | null;
  status?: string | null;
  eventId?: string | null;
  dateField?: string | null;
  from?: string | null;
  to?: string | null;
  min?: string | null;
  max?: string | null;
}

/**
 * Build the Prisma `where` for the deals list.
 *
 * `canSeeValues` MUST come from the CRM's own `canViewDealValues` predicate, not
 * from role-string sniffing at the call site.
 */
export function buildDealWhere(
  params: DealFilterParams,
  opts: { organizationId: string; canSeeValues: boolean },
): Prisma.CrmDealWhereInput {
  const where: Prisma.CrmDealWhereInput = { organizationId: opts.organizationId };

  const ownerId = params.ownerId?.trim();
  if (ownerId) where.ownerId = ownerId;

  const eventId = params.eventId?.trim();
  if (eventId) where.eventId = eventId;

  const status = params.status?.trim();
  if (status === "OPEN" || status === "WON" || status === "LOST") where.status = status;

  // ── Date range ──────────────────────────────────────────────────────────────
  const field: DealDateField = DATE_FIELDS.has(params.dateField as DealDateField)
    ? (params.dateField as DealDateField)
    : "expectedClose";
  const from = parseDate(params.from);
  const to = parseDate(params.to);

  if (from || to) {
    const range: Prisma.DateTimeFilter = {};
    if (from) range.gte = from;
    if (to) range.lte = endOfDay(to);

    if (field === "closed") {
      // "Closed in this window" spans two columns — won deals stamp wonAt, lost
      // deals stamp lostAt. Match either.
      where.OR = [{ wonAt: range }, { lostAt: range }];
    } else {
      where[field] = range;
    }
  }

  // ── Value range (STAFF ONLY) ────────────────────────────────────────────────
  if (opts.canSeeValues) {
    const min = params.min != null && params.min !== "" ? Number(params.min) : null;
    const max = params.max != null && params.max !== "" ? Number(params.max) : null;
    const valueFilter: Prisma.DecimalFilter = {};
    if (min != null && Number.isFinite(min)) valueFilter.gte = min;
    if (max != null && Number.isFinite(max)) valueFilter.lte = max;
    if (Object.keys(valueFilter).length > 0) where.dealValue = valueFilter;
  }
  // else: value params are silently ignored — a MEMBER cannot filter by a number
  // they are not allowed to see.

  return where;
}

/**
 * Build the due-date range for the tasks list. `field` is fixed to `dueAt` — a
 * task's only meaningful date for a "what's due this week" filter.
 */
export function buildTaskDueRange(
  params: { from?: string | null; to?: string | null },
): Prisma.DateTimeFilter | null {
  const from = parseDate(params.from);
  const to = parseDate(params.to);
  if (!from && !to) return null;
  const range: Prisma.DateTimeFilter = {};
  if (from) range.gte = from;
  if (to) range.lte = endOfDay(to);
  return range;
}
