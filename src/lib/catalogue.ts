import type { EventType, Prisma } from "@prisma/client";

/**
 * The public event catalogue (/catalogue, Nov 4, 2026): which events it lists
 * and how its filters read. Pure, so the rules are pinned by test; the page
 * runs the queries.
 *
 * WHICH EVENTS. Only events an organiser switched on (`settings.showInCatalogue`,
 * off by default, so a closed or invite-only meeting is never advertised), and
 * only the statuses the public event page itself serves: PUBLISHED and LIVE
 * while upcoming, plus COMPLETED once past. A DRAFT never shows, switch or not.
 */

export const CATALOGUE_PAGE_SIZE = 12;
const MAX_QUERY_LENGTH = 100;
const EVENT_TYPES = ["CONFERENCE", "WEBINAR", "HYBRID"] as const satisfies readonly EventType[];

export const EVENT_TYPE_LABEL: Record<EventType, string> = {
  CONFERENCE: "Conference",
  WEBINAR: "Webinar",
  HYBRID: "Hybrid",
};

export interface CatalogueQuery {
  q: string;
  country: string;
  type: EventType | null;
  specialty: string;
  when: "upcoming" | "past";
  page: number;
}

type SearchParams = Record<string, string | string[] | undefined>;

function one(sp: SearchParams, key: string): string {
  const v = sp[key];
  return (Array.isArray(v) ? v[0] : v)?.trim().slice(0, MAX_QUERY_LENGTH) ?? "";
}

/** The URL's filters, with anything unrecognised read as "no filter" rather than an error. */
export function parseCatalogueQuery(sp: SearchParams): CatalogueQuery {
  const type = one(sp, "type").toUpperCase();
  const page = Number.parseInt(one(sp, "page"), 10);
  return {
    q: one(sp, "q"),
    country: one(sp, "country"),
    type: (EVENT_TYPES as readonly string[]).includes(type) ? (type as EventType) : null,
    specialty: one(sp, "specialty"),
    when: one(sp, "when") === "past" ? "past" : "upcoming",
    page: Number.isFinite(page) && page > 1 ? Math.min(page, 1000) : 1,
  };
}

/** Every listed event of this organisation, before any filter: what the filter menus offer. */
export function catalogueBaseWhere(orgScope: { organizationId?: string }): Prisma.EventWhereInput {
  return {
    ...orgScope,
    status: { in: ["PUBLISHED", "LIVE", "COMPLETED"] },
    settings: { path: ["showInCatalogue"], equals: true },
  };
}

export function catalogueWhere(orgScope: { organizationId?: string }, query: CatalogueQuery, now: Date): Prisma.EventWhereInput {
  const upcoming = query.when === "upcoming";
  const and: Prisma.EventWhereInput[] = [
    upcoming ? { status: { in: ["PUBLISHED", "LIVE"] }, endDate: { gte: now } } : { endDate: { lt: now } },
  ];
  if (query.q) {
    const contains = { contains: query.q, mode: "insensitive" as const };
    and.push({ OR: [{ name: contains }, { city: contains }, { country: contains }, { specialty: contains }, { venue: contains }] });
  }
  if (query.country) and.push({ country: query.country });
  if (query.type) and.push({ eventType: query.type });
  if (query.specialty) and.push({ specialty: query.specialty });
  return { ...catalogueBaseWhere(orgScope), AND: and };
}

/** Soonest first while upcoming; most recent first once past. */
export function catalogueOrderBy(query: CatalogueQuery): Prisma.EventOrderByWithRelationInput[] {
  return query.when === "upcoming" ? [{ startDate: "asc" }, { name: "asc" }] : [{ startDate: "desc" }, { name: "asc" }];
}

/** The URL for these filters with some changed; page resets unless it is the thing being changed. */
export function catalogueHref(query: CatalogueQuery, change: Partial<CatalogueQuery>): string {
  const next = { ...query, ...(("page" in change) ? {} : { page: 1 }), ...change };
  const params = new URLSearchParams();
  if (next.q) params.set("q", next.q);
  if (next.country) params.set("country", next.country);
  if (next.type) params.set("type", next.type);
  if (next.specialty) params.set("specialty", next.specialty);
  if (next.when === "past") params.set("when", "past");
  if (next.page > 1) params.set("page", String(next.page));
  const s = params.toString();
  return s ? `/catalogue?${s}` : "/catalogue";
}
