/**
 * Fetch an event's traffic and roll it up for the dashboard.
 *
 * The adapter side of the boundary: this knows about Prisma, tenancy and the
 * Registration table. The arithmetic lives in src/analytics/core/aggregate.ts
 * and knows about none of them.
 */

import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { EXCLUDE_FACULTY_WHERE } from "@/lib/faculty-filter";
import { summariseTraffic, buildRegistrationFunnel } from "@/analytics/core/aggregate";
import type { TrafficSummary } from "@/analytics/core/aggregate";
import type { FunnelStep } from "@/analytics/core/funnel";
import type { AnalyticsHit } from "@/analytics/core/types";
import { measuredFrom, registrationsFrom } from "./measured-from";

export interface EventTraffic {
  summary: TrafficSummary;
  funnel: FunnelStep[];
  /** Hits considered. Surfaced so a truncated window is never silent. */
  /** When visit measurement began (ISO), or null if nothing was ever measured; registrations count from here. */
  measuredFrom: string | null;
  hitsRead: number;
  truncated: boolean;
  timeZone: string;
}

/**
 * Ceiling on one dashboard query. Production's ENTIRE public traffic for a
 * fortnight is about 2,200 hits, so this is generous by a wide margin, but a
 * cap that is never hit still has to exist: without one, a single scripted
 * flood would turn opening the Analytics page into a query that reads the
 * table. If it is ever reached the UI says so rather than quietly charting a
 * slice as though it were everything.
 */
const MAX_HITS = 100_000;

export async function getEventTraffic(opts: {
  eventId: string;
  organizationId: string;
  from: Date;
  to: Date;
  timeZone?: string;
}): Promise<EventTraffic> {
  const timeZone = opts.timeZone || "UTC";

  return runWithTenant(opts.organizationId, async () => {
    const start = await measuredFrom(opts.organizationId);
    const regFrom = registrationsFrom(opts.from, start);
    const [rows, registrationCount] = await Promise.all([
      db.analyticsEvent.findMany({
        where: {
          eventId: opts.eventId,
          createdAt: { gte: opts.from, lte: opts.to },
        },
        // Slim on purpose. The wide columns (utm, browser, os) are not part of
        // any figure on this page, and reading them would multiply the transfer
        // for nothing.
        select: {
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
      // The funnel's last step: registrations made through the PUBLIC FORM in
      // the SAME WINDOW as the hits (Sep 25, 2026). Counting every
      // registration the event ever had (CSV imports, admin adds, rows from
      // before tracking) against one window's visitors pushed conversion past
      // 100% on imported events. A later cancellation still counts: the
      // person did convert. Faculty cannot arrive this way; the filter stays
      // as a guard so a companion row is never counted as a conversion.
      // ...and from when measurement began, not before it (measured-from.ts).
      regFrom
        ? db.registration.count({
            where: {
              eventId: opts.eventId,
              createdSource: "PUBLIC_REGISTER",
              createdAt: { gte: regFrom, lte: opts.to },
              ...EXCLUDE_FACULTY_WHERE,
            },
          })
        : Promise.resolve(0),
    ]);

    const truncated = rows.length > MAX_HITS;
    const used = truncated ? rows.slice(0, MAX_HITS) : rows;
    if (truncated) {
      apiLogger.warn(
        { eventId: opts.eventId, cap: MAX_HITS },
        "analytics:traffic-window-truncated",
      );
    }

    const hits: AnalyticsHit[] = used.map((r) => ({
      siteId: "",
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

    return {
      summary: summariseTraffic(hits, { from: opts.from, to: opts.to, timeZone }),
      funnel: buildRegistrationFunnel(hits, registrationCount),
      measuredFrom: start ? start.toISOString() : null,
      hitsRead: used.length,
      truncated,
      timeZone,
    };
  });
}
