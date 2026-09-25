/**
 * Rollups. Hits in, dashboard numbers out.
 *
 * CLIENT-SAFE. No node: imports, no I/O, no dependency. Pure functions over an
 * array, which is what makes them testable without a database and what keeps
 * the extractable core extractable.
 *
 * WHY IN-PROCESS AND NOT SQL
 * This follows what src/lib/event-analytics.ts already does for registrations:
 * one slim findMany, then aggregate in memory. It is the right call at this
 * size (a busy event is low thousands of hits, and production's whole fortnight
 * of public traffic is about 2,200), and it buys two things that matter more
 * than the theoretical efficiency of GROUP BY. The logic stays pure and
 * testable, and it avoids $queryRaw, which in this codebase is deliberately
 * OUTSIDE the tenant lane and would therefore fail closed to empty results
 * under RLS on the platform instance.
 *
 * If an event ever produces enough traffic for this to hurt, the fix is a
 * pre-aggregated daily table, not raw SQL.
 */

import type { AnalyticsHit } from "./types";
import { buildFunnel, type FunnelInput, type FunnelStep } from "./funnel";

export interface Bucket {
  /** YYYY-MM-DD in the requested timezone. */
  date: string;
  pageviews: number;
  visitors: number;
}

export interface PageRow {
  routePattern: string;
  /** The most-seen concrete path for this pattern, for display. */
  examplePath: string;
  pageviews: number;
  visitors: number;
}

export interface NamedCount {
  label: string;
  visitors: number;
}

export interface TrafficSummary {
  pageviews: number;
  /** Distinct visitors over the whole range, not the sum of the daily figures. */
  visitors: number;
  sessions: number;
  /** Sessions with exactly one pageview, as a share of all sessions, 0..1. */
  bounceRate: number;
  /** Mean time on page, from the engagement hits only. Null if none reported. */
  avgDurationMs: number | null;
  /** Mean furthest scroll, 0-100. Null if none reported. */
  avgScrollDepth: number | null;
  daily: Bucket[];
  topPages: PageRow[];
  topReferrers: NamedCount[];
  devices: NamedCount[];
}

/** Only these count as a page being viewed. Engagement is a second hit. */
const PAGEVIEW = "pageview";
const ENGAGEMENT = "page_engagement";

function dayKey(at: Date, timeZone: string): string {
  // Intl rather than toISOString: a day boundary means the organiser's day, and
  // an event in Dubai should not have its evening traffic land on tomorrow.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  return parts; // en-CA formats as YYYY-MM-DD
}

/** Every day in the range, so a quiet day is a gap in the chart, not missing. */
function dateRange(from: Date, to: Date, timeZone: string): string[] {
  const days: string[] = [];
  const cursor = new Date(from.getTime());
  // Step by whole days from the start; the guard bounds a pathological range.
  for (let i = 0; i < 800 && cursor.getTime() <= to.getTime(); i++) {
    days.push(dayKey(cursor, timeZone));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return [...new Set(days)];
}

function topBy(
  counts: Map<string, Set<string>>,
  limit: number,
): NamedCount[] {
  return [...counts.entries()]
    .map(([label, visitors]) => ({ label, visitors: visitors.size }))
    .sort((a, b) => b.visitors - a.visitors || a.label.localeCompare(b.label))
    .slice(0, limit);
}

export function summariseTraffic(
  hits: readonly AnalyticsHit[],
  opts: { from: Date; to: Date; timeZone?: string; topLimit?: number },
): TrafficSummary {
  const timeZone = opts.timeZone || "UTC";
  const limit = opts.topLimit ?? 10;

  const visitors = new Set<string>();
  const sessions = new Map<string, number>(); // sessionHash -> pageview count
  const byDay = new Map<string, { pageviews: number; visitors: Set<string> }>();
  const byPattern = new Map<
    string,
    { pageviews: number; visitors: Set<string>; paths: Map<string, number> }
  >();
  const byReferrer = new Map<string, Set<string>>();
  const byDevice = new Map<string, Set<string>>();

  let pageviews = 0;
  let durationSum = 0;
  let durationCount = 0;
  let scrollSum = 0;
  let scrollCount = 0;

  for (const hit of hits) {
    // Engagement hits carry duration and scroll but are NOT a second view of
    // the page. Counting them would inflate every pageview figure by roughly
    // the share of visitors who stayed a second, which is most of them.
    if (hit.name === ENGAGEMENT) {
      if (typeof hit.durationMs === "number") {
        durationSum += hit.durationMs;
        durationCount++;
      }
      if (typeof hit.scrollDepth === "number") {
        scrollSum += hit.scrollDepth;
        scrollCount++;
      }
      continue;
    }
    if (hit.name !== PAGEVIEW) continue; // conversions are counted by the funnel

    pageviews++;
    visitors.add(hit.visitorHash);
    sessions.set(hit.sessionHash, (sessions.get(hit.sessionHash) ?? 0) + 1);

    const day = dayKey(hit.occurredAt, timeZone);
    const dayEntry = byDay.get(day) ?? { pageviews: 0, visitors: new Set<string>() };
    dayEntry.pageviews++;
    dayEntry.visitors.add(hit.visitorHash);
    byDay.set(day, dayEntry);

    const patternEntry =
      byPattern.get(hit.routePattern) ??
      { pageviews: 0, visitors: new Set<string>(), paths: new Map<string, number>() };
    patternEntry.pageviews++;
    patternEntry.visitors.add(hit.visitorHash);
    patternEntry.paths.set(hit.path, (patternEntry.paths.get(hit.path) ?? 0) + 1);
    byPattern.set(hit.routePattern, patternEntry);

    if (hit.referrerHost) {
      const set = byReferrer.get(hit.referrerHost) ?? new Set<string>();
      set.add(hit.visitorHash);
      byReferrer.set(hit.referrerHost, set);
    }
    if (hit.deviceType) {
      const set = byDevice.get(hit.deviceType) ?? new Set<string>();
      set.add(hit.visitorHash);
      byDevice.set(hit.deviceType, set);
    }
  }

  const sessionCounts = [...sessions.values()];
  const bounced = sessionCounts.filter((n) => n === 1).length;

  return {
    pageviews,
    // Distinct over the range. Deliberately NOT the sum of the daily counts,
    // which double-counts anyone who came back on a second day.
    visitors: visitors.size,
    sessions: sessions.size,
    bounceRate: sessionCounts.length === 0 ? 0 : bounced / sessionCounts.length,
    avgDurationMs: durationCount === 0 ? null : Math.round(durationSum / durationCount),
    avgScrollDepth: scrollCount === 0 ? null : Math.round(scrollSum / scrollCount),
    daily: dateRange(opts.from, opts.to, timeZone).map((date) => {
      const entry = byDay.get(date);
      return { date, pageviews: entry?.pageviews ?? 0, visitors: entry?.visitors.size ?? 0 };
    }),
    topPages: [...byPattern.entries()]
      .map(([routePattern, e]) => ({
        routePattern,
        examplePath:
          [...e.paths.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? routePattern,
        pageviews: e.pageviews,
        visitors: e.visitors.size,
      }))
      .sort((a, b) => b.pageviews - a.pageviews)
      .slice(0, limit),
    topReferrers: topBy(byReferrer, limit),
    devices: topBy(byDevice, limit),
  };
}

export interface SiteRow {
  siteId: string;
  pageviews: number;
  /** Distinct visitors to this site over the range. */
  visitors: number;
  /** Distinct visitors who opened a registration form. */
  registerVisitors: number;
  /** The referrer host that sent the most visitors, or null if all were direct. */
  topSource: string | null;
  /** Pageviews per day across the range, oldest first, for a small trend. */
  daily: number[];
}

/**
 * One row per site (per event in EA-SYS) for the app-wide view (Sep 25,
 * 2026). The visitor hash includes the site, so a person who looked at two
 * events is two visitors here, by design; the page says so.
 */
export function summariseBySite(
  hits: readonly AnalyticsHit[],
  opts: { from: Date; to: Date; timeZone?: string },
): SiteRow[] {
  const timeZone = opts.timeZone || "UTC";
  const days = dateRange(opts.from, opts.to, timeZone);
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const REGISTER_PAGES = new Set(["/e/:slug/register", "/e/:slug/register/:category"]);

  const sites = new Map<
    string,
    { pageviews: number; visitors: Set<string>; register: Set<string>; sources: Map<string, Set<string>>; daily: number[] }
  >();
  for (const hit of hits) {
    if (hit.name !== PAGEVIEW) continue;
    let site = sites.get(hit.siteId);
    if (!site) {
      site = { pageviews: 0, visitors: new Set(), register: new Set(), sources: new Map(), daily: days.map(() => 0) };
      sites.set(hit.siteId, site);
    }
    site.pageviews++;
    site.visitors.add(hit.visitorHash);
    if (REGISTER_PAGES.has(hit.routePattern)) site.register.add(hit.visitorHash);
    if (hit.referrerHost) {
      const set = site.sources.get(hit.referrerHost) ?? new Set<string>();
      set.add(hit.visitorHash);
      site.sources.set(hit.referrerHost, set);
    }
    const i = dayIndex.get(dayKey(hit.occurredAt, timeZone));
    if (i !== undefined) site.daily[i]++;
  }

  return [...sites.entries()]
    .map(([siteId, s]) => ({
      siteId,
      pageviews: s.pageviews,
      visitors: s.visitors.size,
      registerVisitors: s.register.size,
      topSource: topBy(s.sources, 1)[0]?.label ?? null,
      daily: s.daily,
    }))
    .sort((a, b) => b.visitors - a.visitors || a.siteId.localeCompare(b.siteId));
}

/**
 * The registration funnel, counted in DISTINCT VISITORS rather than pageviews.
 *
 * Visitors, because "500 people looked and 80 registered" is the question. One
 * person refreshing the register page five times is one person considering it,
 * not five, and counting hits would flatter every rate.
 *
 * The steps (revised Sep 25, 2026, from what production traffic showed):
 *
 * 1. "Visited": anyone who viewed ANY of the event's measured public pages.
 *    It used to be the event home page only, but 93% of real views land
 *    straight on a register page, sent there by the conference's own website;
 *    the home page had 15 views in five weeks, so step one was smaller than
 *    step two. Every register-page visitor is also a visitor, so step two can
 *    no longer exceed step one.
 * 2. "Opened a registration form": visitors on a register page.
 * 3. "Registered online": the CALLER's count, which must be registrations made
 *    through the public form WITHIN THE SAME WINDOW as the hits. It used to be
 *    every registration the event ever had (CSV imports, admin adds, rows from
 *    before tracking began), set against visitors from one window, which is
 *    how conversion ran past 100% on imported events. It comes from the
 *    Registration table, not a conversion beacon, because a beacon can be lost
 *    to a closed tab and this number is independently knowable. It can still
 *    exceed step two when a visit was not measured (tracking blocked, or a
 *    page outside the allow-list), and buildFunnel reports that as measured.
 */
export function buildRegistrationFunnel(
  hits: readonly AnalyticsHit[],
  onlineRegistrationsInWindow: number,
): FunnelStep[] {
  const visitorsFor = (match: (routePattern: string) => boolean) => {
    const set = new Set<string>();
    for (const hit of hits) {
      if (hit.name !== PAGEVIEW) continue;
      if (match(hit.routePattern)) set.add(hit.visitorHash);
    }
    return set.size;
  };
  const REGISTER_PAGES = ["/e/:slug/register", "/e/:slug/register/:category"];

  const steps: FunnelInput[] = [
    { name: "visited", label: "Visited the event's pages", count: visitorsFor(() => true) },
    {
      name: "register_viewed",
      label: "Opened a registration form",
      count: visitorsFor((p) => REGISTER_PAGES.includes(p)),
    },
    { name: "registered", label: "Registered online", count: Math.max(0, onlineRegistrationsInWindow) },
  ];

  return buildFunnel(steps);
}
