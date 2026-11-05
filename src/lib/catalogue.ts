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

/** Organization.settings key for the catalogue hero's photo (Settings, General). */
export const CATALOGUE_HERO_IMAGE_SETTING = "catalogueHeroImage";

/**
 * The catalogue hero's photo, or null (the page then draws its pattern). Only
 * an uploaded file or an https URL is accepted, so a hand-edited value cannot
 * point the public page at a `javascript:` or `data:` address.
 */
export function readCatalogueHeroImage(settings: unknown): string | null {
  const value = (settings as Record<string, unknown> | null)?.[CATALOGUE_HERO_IMAGE_SETTING];
  if (typeof value !== "string") return null;
  return /^(\/uploads\/|https:\/\/)[^\s"'<>()]+$/.test(value) ? value : null;
}

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

/**
 * `variants`: every stored spelling of the chosen country or specialty (a
 * topic groups "Cardiology", "cardiology" and "Cardiology " under one slug),
 * so the filter finds them all. Without it the value is matched as given.
 */
export function catalogueWhere(
  orgScope: { organizationId?: string },
  query: CatalogueQuery,
  now: Date,
  variants: { country?: readonly string[]; specialty?: readonly string[] } = {},
): Prisma.EventWhereInput {
  const upcoming = query.when === "upcoming";
  const and: Prisma.EventWhereInput[] = [
    upcoming ? { status: { in: ["PUBLISHED", "LIVE"] }, endDate: { gte: now } } : { endDate: { lt: now } },
  ];
  if (query.q) {
    const contains = { contains: query.q, mode: "insensitive" as const };
    and.push({ OR: [{ name: contains }, { city: contains }, { country: contains }, { specialty: contains }, { venue: contains }] });
  }
  if (query.country) and.push({ country: variants.country ? { in: [...variants.country] } : query.country });
  if (query.type) and.push({ eventType: query.type });
  if (query.specialty) and.push({ specialty: variants.specialty ? { in: [...variants.specialty] } : query.specialty });
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

// ── Topic pages (catalogue phase 3) ────────────────────────────────────────
//
// One indexable page per specialty and per country that has listed events:
// /catalogue/specialty/cardiology, /catalogue/country/oman. They match how
// people search ("cardiology conference Dubai", "CME events Oman") far better
// than a filter URL, which the catalogue keeps noindex. A value with no listed
// event has no page, so nothing thin or empty is ever indexed.

export type TopicKind = "specialty" | "country";
export const TOPIC_KINDS: readonly TopicKind[] = ["specialty", "country"];

/** A URL slug for a value: "United Arab Emirates" -> "united-arab-emirates", diacritics dropped. */
export function topicSlug(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * One specialty or country as a page: its slug, the label people see, and
 * every spelling stored on events. Free-text fields drift ("Cardiology",
 * "cardiology", "Cardiology " with a trailing space); grouping by slug gives
 * one page that lists them all, instead of two chips, duplicate sitemap URLs,
 * or a page that exists but finds nothing.
 */
export interface Topic {
  slug: string;
  label: string;
  variants: string[];
}

/** Group stored values (with how many events carry each) into topics; a value with no usable slug is dropped. */
export function groupTopics(rows: { value: string | null; count: number }[]): Topic[] {
  const groups = new Map<string, { variants: string[]; labels: Map<string, number> }>();
  for (const { value, count } of rows) {
    const label = value?.trim();
    if (!value || !label) continue;
    const slug = topicSlug(label);
    if (!slug) continue;
    const g = groups.get(slug) ?? { variants: [], labels: new Map<string, number>() };
    if (!g.variants.includes(value)) g.variants.push(value);
    g.labels.set(label, (g.labels.get(label) ?? 0) + count);
    groups.set(slug, g);
  }
  return [...groups.entries()]
    .map(([slug, g]) => ({
      slug,
      // The spelling most events use; ties go to the alphabetically first.
      label: [...g.labels.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
      variants: g.variants,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The topic behind a slug, among those that have listed events. */
export function findTopic(topics: readonly Topic[], slug: string): Topic | null {
  return topics.find((t) => t.slug === slug) ?? null;
}

/** The topic a filter value belongs to (a dropdown sends the label). */
export function topicForValue(topics: readonly Topic[], value: string): Topic | null {
  return value ? findTopic(topics, topicSlug(value)) : null;
}

export function topicHref(kind: TopicKind, value: string, query?: Pick<CatalogueQuery, "when" | "page">): string {
  const params = new URLSearchParams();
  if (query?.when === "past") params.set("when", "past");
  if (query && query.page > 1) params.set("page", String(query.page));
  const s = params.toString();
  return `/catalogue/${kind}/${topicSlug(value)}${s ? `?${s}` : ""}`;
}

/** The page's heading, written the way people search. */
export function topicTitle(kind: TopicKind, value: string): string {
  return kind === "specialty" ? `${value} conferences and CME events` : `Medical conferences and CME events in ${value}`;
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The sentence under the heading, from the topic's upcoming events: how many,
 * where (or which specialties, on a country page), and the most CME hours one
 * carries. Factual and self-contained, so an assistant can quote it.
 */
export function topicIntro(
  kind: TopicKind,
  value: string,
  upcoming: { city: string | null; country: string | null; specialty: string | null; cmeHours: { toString(): string } | null }[],
  /** The true number of upcoming events, when `upcoming` is a capped sample. */
  count: number = upcoming.length,
): string {
  if (count === 0 || upcoming.length === 0) {
    return `There are no upcoming ${kind === "specialty" ? `${value} events` : `events in ${value}`} right now; past events are listed below.`;
  }
  const n = count;
  const noun = n === 1 ? "event" : "events";
  const cme = Math.max(0, ...upcoming.map((e) => (e.cmeHours ? Number(e.cmeHours.toString()) : 0)));
  const cmeText = cme > 0 ? `, carrying up to ${cme} CME hours` : "";
  if (kind === "specialty") {
    const places = [...new Set(upcoming.map((e) => (e.city || e.country)?.trim()).filter((p): p is string => !!p))].slice(0, 4);
    return `${n} upcoming ${value} ${noun}${places.length > 0 ? ` in ${listWords(places)}` : ""}${cmeText}.`;
  }
  const specialties = [...new Set(upcoming.map((e) => e.specialty?.trim()).filter((s): s is string => !!s))].slice(0, 4);
  return `${n} upcoming medical ${noun} in ${value}${specialties.length > 0 ? ` across ${listWords(specialties)}` : ""}${cmeText}.`;
}
