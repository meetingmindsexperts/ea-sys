/**
 * Public-site traffic across all of an organisation's events, for the
 * app-wide Analytics page (Sep 25, 2026). The per-event card answers "how did
 * this event's pages do"; this answers "how is our public traffic doing, which
 * events draw visitors and which websites send them", which the design record
 * (docs/ANALYTICS_PLAN.md) deferred until there was data.
 *
 * The adapter side, like event-traffic.ts: Prisma, tenancy and the
 * Registration table live here; the arithmetic is in core/aggregate.ts.
 * The caller decides WHICH events (buildEventAccessWhere), so a role scoped to
 * some events sees only those.
 */

import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { EXCLUDE_FACULTY_WHERE } from "@/lib/faculty-filter";
import { summariseTraffic, summariseBySite, buildRegistrationFunnel } from "@/analytics/core/aggregate";
import type { TrafficSummary } from "@/analytics/core/aggregate";
import type { FunnelStep } from "@/analytics/core/funnel";
import type { AnalyticsHit } from "@/analytics/core/types";
import { measuredFrom, registrationsFrom } from "./measured-from";

export interface OrgEventTrafficRow {
  eventId: string;
  name: string;
  slug: string;
  startDate: string;
  visitors: number;
  pageviews: number;
  registerVisitors: number;
  /** Public-form registrations made within the window. */
  onlineRegistrations: number;
  /** onlineRegistrations / visitors, 0..1 (can exceed 1 when visits went unmeasured). */
  conversionRate: number;
  topSource: string | null;
  /** Pageviews per day across the window, oldest first. */
  daily: number[];
}

export interface OrgTraffic {
  summary: TrafficSummary;
  funnel: FunnelStep[];
  events: OrgEventTrafficRow[];
  onlineRegistrations: number;
  /** When visit measurement began (ISO), or null if nothing was ever measured; registrations count from here. */
  measuredFrom: string | null;
  hitsRead: number;
  truncated: boolean;
  timeZone: string;
}

/** Same ceiling as one event's read; production's whole fortnight is ~2,200 hits. */
const MAX_HITS = 100_000;

export async function getOrgTraffic(opts: {
  organizationId: string;
  events: { id: string; name: string; slug: string; startDate: Date }[];
  from: Date;
  to: Date;
  timeZone: string;
}): Promise<OrgTraffic> {
  const { timeZone } = opts;
  const eventIds = opts.events.map((e) => e.id);
  if (eventIds.length === 0) {
    return {
      summary: summariseTraffic([], { from: opts.from, to: opts.to, timeZone }),
      funnel: buildRegistrationFunnel([], 0),
      events: [],
      onlineRegistrations: 0,
      measuredFrom: null,
      hitsRead: 0,
      truncated: false,
      timeZone,
    };
  }

  return runWithTenant(opts.organizationId, async () => {
    const start = await measuredFrom(opts.organizationId);
    const regFrom = registrationsFrom(opts.from, start);
    const [rows, registrations] = await Promise.all([
      db.analyticsEvent.findMany({
        where: { organizationId: opts.organizationId, eventId: { in: eventIds }, createdAt: { gte: opts.from, lte: opts.to } },
        select: {
          eventId: true,
          name: true,
          path: true,
          routePattern: true,
          visitorHash: true,
          sessionHash: true,
          referrerHost: true,
          deviceType: true,
          durationMs: true,
          scrollDepth: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
        take: MAX_HITS + 1,
      }),
      // The funnel's last step, per event: public-form registrations inside
      // the window, as on the per-event card (see event-traffic.ts).
      // Counted from when measurement began, not from before it (measured-from.ts).
      regFrom
        ? db.registration.groupBy({
            by: ["eventId"],
            where: {
              eventId: { in: eventIds },
              createdSource: "PUBLIC_REGISTER",
              createdAt: { gte: regFrom, lte: opts.to },
              ...EXCLUDE_FACULTY_WHERE,
            },
            _count: { _all: true },
          })
        : Promise.resolve([] as { eventId: string; _count: { _all: number } }[]),
    ]);

    const truncated = rows.length > MAX_HITS;
    const used = truncated ? rows.slice(0, MAX_HITS) : rows;
    if (truncated) {
      apiLogger.warn({ organizationId: opts.organizationId, cap: MAX_HITS }, "analytics:org-traffic-window-truncated");
    }

    // siteId carries the eventId here, so the core can group by it.
    const hits: AnalyticsHit[] = used.map((r) => ({
      siteId: r.eventId ?? "",
      name: r.name,
      path: r.path,
      routePattern: r.routePattern,
      visitorHash: r.visitorHash,
      sessionHash: r.sessionHash,
      referrerHost: r.referrerHost,
      deviceType: (r.deviceType as AnalyticsHit["deviceType"]) ?? null,
      durationMs: r.durationMs,
      scrollDepth: r.scrollDepth,
      occurredAt: r.createdAt,
    }));

    const regsByEvent = new Map(registrations.map((g) => [g.eventId, g._count._all]));
    const onlineRegistrations = [...regsByEvent.values()].reduce((a, b) => a + b, 0);
    const sites = new Map(summariseBySite(hits, { from: opts.from, to: opts.to, timeZone }).map((s) => [s.siteId, s]));
    const emptyDaily = summariseTraffic([], { from: opts.from, to: opts.to, timeZone }).daily.map(() => 0);

    // An event appears when it had traffic or online registrations in the
    // window; the rest would be rows of zeros.
    const events: OrgEventTrafficRow[] = opts.events
      .map((e) => {
        const site = sites.get(e.id);
        const regs = regsByEvent.get(e.id) ?? 0;
        const visitors = site?.visitors ?? 0;
        return {
          eventId: e.id,
          name: e.name,
          slug: e.slug,
          startDate: e.startDate.toISOString(),
          visitors,
          pageviews: site?.pageviews ?? 0,
          registerVisitors: site?.registerVisitors ?? 0,
          onlineRegistrations: regs,
          conversionRate: visitors === 0 ? 0 : regs / visitors,
          topSource: site?.topSource ?? null,
          daily: site?.daily ?? emptyDaily,
        };
      })
      .filter((r) => r.visitors > 0 || r.onlineRegistrations > 0)
      .sort((a, b) => b.visitors - a.visitors || b.onlineRegistrations - a.onlineRegistrations || a.name.localeCompare(b.name));

    return {
      summary: summariseTraffic(hits, { from: opts.from, to: opts.to, timeZone }),
      funnel: buildRegistrationFunnel(hits, onlineRegistrations),
      events,
      onlineRegistrations,
      measuredFrom: start ? start.toISOString() : null,
      hitsRead: used.length,
      truncated,
      timeZone,
    };
  });
}
