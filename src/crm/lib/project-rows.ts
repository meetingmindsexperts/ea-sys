/**
 * The shape a corporate project leaves the API in (Nov 12, 2026): one select
 * and one mapping, shared by the list and the detail route so the two cannot
 * drift. Pure apart from the Prisma types.
 *
 * Dates leave as YYYY-MM-DD strings: they are calendar days, and a Date read in
 * the browser's timezone can land on the day before. `dealTotals` is the
 * per-currency Open / Won / Lost rollup; the key is in FINANCIAL_KEYS, so
 * redactForCaller removes it for a caller who may not see deal values.
 */
import type { Prisma } from "@prisma/client";
import { companyDealValueBreakdown } from "@/crm/lib/company-rollup";

export const PROJECT_SELECT = {
  id: true,
  name: true,
  startDate: true,
  endDate: true,
  location: true,
  archivedAt: true,
  createdAt: true,
  company: { select: { id: true, name: true } },
  owner: { select: { id: true, firstName: true, lastName: true } },
  // The event this project duplicates, when someone linked one (deal-attribution.ts).
  event: { select: { id: true, name: true } },
  // Feeds the rollup, stripped below. Archived deals never count toward a total.
  deals: { where: { archivedAt: null }, select: { status: true, dealValue: true, currency: true } },
} satisfies Prisma.CrmProjectSelect;

/**
 * What a deal read selects of its corporate project: enough to show it on the
 * board and in the export (name, days, place) and the event it is linked to,
 * which is the event the deal counts under (deal-attribution.ts).
 */
export const DEAL_PROJECT_SELECT = {
  id: true,
  name: true,
  startDate: true,
  endDate: true,
  location: true,
  archivedAt: true,
  eventId: true,
  event: { select: { id: true, name: true } },
} satisfies Prisma.CrmProjectSelect;

type ProjectRaw = Prisma.CrmProjectGetPayload<{ select: typeof PROJECT_SELECT }>;

/** A calendar-day column as YYYY-MM-DD (it is stored as UTC midnight). */
export function dayString(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** YYYY-MM-DD to the UTC-midnight Date a @db.Date column takes, or null when it is not a real day. */
export function parseDay(v: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00.000Z`);
  // "2027-02-31" parses to March 3: only a day that round-trips is real.
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : d;
}

export function projectRow({ deals, startDate, endDate, ...p }: ProjectRaw) {
  return {
    ...p,
    startDate: dayString(startDate),
    endDate: dayString(endDate),
    dealCount: deals.length,
    openDealCount: deals.filter((d) => d.status === "OPEN").length,
    wonDealCount: deals.filter((d) => d.status === "WON").length,
    dealTotals: companyDealValueBreakdown(deals),
  };
}

export type CrmProjectRowOut = ReturnType<typeof projectRow>;
