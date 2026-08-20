/**
 * The Prisma adapter: the only place the analytics module knows EA-SYS exists.
 *
 * Everything under src/analytics/core/ is forbidden from importing the app (see
 * the eslint zone). This file is the other side of that boundary and may import
 * whatever it likes. If core seems to need something from here, the answer is
 * almost always to pass it in as a parameter.
 */

import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import type { AnalyticsHit, AnalyticsQuery, AnalyticsWriter } from "@/analytics/core/types";

/** Resolved identity of a site, cached by the ingest route. */
export interface SiteBinding {
  organizationId: string;
  eventId: string;
}

type Row = {
  organizationId: string;
  eventId: string | null;
  siteId: string;
  name: string;
  path: string;
  routePattern: string;
  visitorHash: string;
  sessionHash: string;
  referrerHost: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  deviceType: string | null;
  browser: string | null;
  os: string | null;
  country: string | null;
  durationMs: number | null;
  scrollDepth: number | null;
  value: number | null;
  createdAt: Date;
};

/**
 * A hit carries its own organisation, resolved from the site at ingest time.
 * Hits without one are dropped by the caller and never reach here, which is
 * what lets the RLS policy be strict in both directions.
 */
export interface WritableHit extends AnalyticsHit {
  organizationId: string;
  eventId: string | null;
}

function toRow(hit: WritableHit): Row {
  return {
    organizationId: hit.organizationId,
    eventId: hit.eventId,
    siteId: hit.siteId,
    name: hit.name,
    path: hit.path,
    routePattern: hit.routePattern,
    visitorHash: hit.visitorHash,
    sessionHash: hit.sessionHash,
    referrerHost: hit.referrerHost ?? null,
    utmSource: hit.utmSource ?? null,
    utmMedium: hit.utmMedium ?? null,
    utmCampaign: hit.utmCampaign ?? null,
    deviceType: hit.deviceType ?? null,
    browser: hit.browser ?? null,
    os: hit.os ?? null,
    country: hit.country ?? null,
    durationMs: hit.durationMs ?? null,
    scrollDepth: hit.scrollDepth ?? null,
    value: hit.value ?? null,
    createdAt: hit.occurredAt,
  };
}

/**
 * Persist a batch.
 *
 * Grouped by organisation, one createMany per group inside that org's tenant
 * lane. One container serves every tenant, so a single buffer can hold hits for
 * several of them, and writing the whole batch under one lane would be rejected
 * by the RLS policy. That rejection would be correct, which is precisely why
 * the grouping has to happen here rather than being discovered later.
 *
 * createMany rather than create(): create() issues INSERT..RETURNING, which the
 * strict USING clause rejects even for a row WITH CHECK admits.
 *
 * NEVER THROWS. Analytics must not be able to take anything else down, and a
 * lost batch of pageviews is not worth an error path anywhere upstream. It
 * logs, which is how a persistent failure becomes visible.
 */
export async function recordHits(hits: readonly WritableHit[]): Promise<number> {
  if (hits.length === 0) return 0;

  const byOrg = new Map<string, Row[]>();
  for (const hit of hits) {
    const rows = byOrg.get(hit.organizationId);
    if (rows) rows.push(toRow(hit));
    else byOrg.set(hit.organizationId, [toRow(hit)]);
  }

  let written = 0;
  for (const [organizationId, rows] of byOrg) {
    try {
      await runWithTenant(organizationId, async () => {
        await db.analyticsEvent.createMany({ data: rows });
      });
      written += rows.length;
    } catch (err) {
      // Per-org, so one tenant's failure cannot discard another's batch.
      apiLogger.error(
        { err, organizationId, count: rows.length },
        "analytics:write-failed",
      );
    }
  }
  return written;
}

export const prismaAnalyticsWriter: AnalyticsWriter<WritableHit> = {
  async record(hits) {
    await recordHits(hits);
  },
};

/**
 * Read hits back for a site.
 *
 * The caller is responsible for being inside the right tenant lane; this does
 * not wrap, because the dashboard route already resolves the event and its
 * organisation before it gets here and wrapping twice would hide which one is
 * authoritative.
 */
export async function queryHits(q: AnalyticsQuery): Promise<AnalyticsHit[]> {
  const rows = await db.analyticsEvent.findMany({
    where: {
      siteId: q.siteId,
      createdAt: { gte: q.from, lte: q.to },
      ...(q.name ? { name: q.name } : {}),
      ...(q.routePattern ? { routePattern: q.routePattern } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: Math.min(q.limit ?? 5000, 20000),
  });

  return rows.map((r) => ({
    siteId: r.siteId,
    name: r.name,
    path: r.path,
    routePattern: r.routePattern,
    visitorHash: r.visitorHash,
    sessionHash: r.sessionHash,
    referrerHost: r.referrerHost,
    utmSource: r.utmSource,
    utmMedium: r.utmMedium,
    utmCampaign: r.utmCampaign,
    deviceType: (r.deviceType as AnalyticsHit["deviceType"]) ?? null,
    browser: r.browser,
    os: r.os,
    country: r.country,
    durationMs: r.durationMs,
    scrollDepth: r.scrollDepth,
    value: r.value === null ? null : Number(r.value),
    occurredAt: r.createdAt,
  }));
}
