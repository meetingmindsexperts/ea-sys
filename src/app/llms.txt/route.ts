import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { catalogueBaseWhere, topicHref, topicTitle } from "@/lib/catalogue";
import { listTopicValues } from "@/lib/catalogue-data";
import { publicOrgScopeForHost } from "@/lib/public-event";
import { normalizeHost, resolveTenantOrg } from "@/lib/tenant/resolver";
import { formatEventDateRange } from "@/lib/event-time";
import { llmsText, siteOrigin } from "@/lib/seo";

/**
 * GET /llms.txt (llmstxt.org), per site address (Nov 4, 2026): a short plain
 * map for AI assistants of what this organisation runs and how a person
 * registers. Only catalogue-listed upcoming events, as the catalogue shows.
 */
export async function GET(req: Request) {
  const host = req.headers.get("host");
  const origin = siteOrigin(host, req.headers.get("x-forwarded-proto"));
  try {
    const [scope, tenant] = await Promise.all([publicOrgScopeForHost(host), resolveTenantOrg(normalizeHost(host))]);
    const [events, organization, topics] = await Promise.all([
      db.event.findMany({
        where: { ...catalogueBaseWhere(scope), status: { in: ["PUBLISHED", "LIVE"] }, endDate: { gte: new Date() } },
        orderBy: { startDate: "asc" },
        take: 100,
        select: {
          slug: true, name: true, startDate: true, endDate: true, timezone: true, venue: true, city: true,
          country: true, eventType: true, specialty: true, bannerImage: true, cmeHours: true,
        },
      }),
      tenant.orgId ? db.organization.findUnique({ where: { id: tenant.orgId }, select: { name: true } }) : null,
      listTopicValues(scope),
    ]);
    const body = llmsText({
      origin,
      organizationName: organization?.name ?? null,
      events,
      formatDates: (e) => formatEventDateRange(e.startDate, e.endDate, e.timezone),
      topics: [
        ...topics.specialties.map((v): [string, string] => [topicTitle("specialty", v), topicHref("specialty", v)]),
        ...topics.countries.map((v): [string, string] => [topicTitle("country", v), topicHref("country", v)]),
      ],
    });
    return new NextResponse(body, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
    });
  } catch (err) {
    apiLogger.error({ err, msg: "llms-txt:failed", host });
    return new NextResponse("Temporarily unavailable\n", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
