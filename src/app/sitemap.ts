import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { catalogueBaseWhere, topicHref } from "@/lib/catalogue";
import { listTopicValues } from "@/lib/catalogue-data";
import { publicOrgScopeForHost } from "@/lib/public-event";
import { siteOrigin } from "@/lib/seo";

/**
 * sitemap.xml, per site address (Nov 4, 2026): the catalogue, its topic pages
 * (one per specialty and country with a listed event), and every event an
 * organiser listed in it, upcoming and past, for this site's organisation
 * only. An event left out of the catalogue is left out here too.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const h = await headers();
  const host = h.get("host");
  const origin = siteOrigin(host, h.get("x-forwarded-proto"));
  try {
    const scope = await publicOrgScopeForHost(host);
    const [events, topics] = await Promise.all([
      db.event.findMany({
        where: catalogueBaseWhere(scope),
        select: { slug: true, updatedAt: true },
        orderBy: { startDate: "desc" },
        take: 5000,
      }),
      listTopicValues(scope),
    ]);
    return [
      { url: `${origin}/catalogue`, changeFrequency: "daily", priority: 1 },
      ...topics.specialties.map((t) => ({ url: `${origin}${topicHref("specialty", t.label)}`, changeFrequency: "weekly" as const, priority: 0.7 })),
      ...topics.countries.map((t) => ({ url: `${origin}${topicHref("country", t.label)}`, changeFrequency: "weekly" as const, priority: 0.7 })),
      ...events.map((e) => ({ url: `${origin}/e/${e.slug}`, lastModified: e.updatedAt, changeFrequency: "weekly" as const, priority: 0.8 })),
    ];
  } catch (err) {
    apiLogger.error({ err, msg: "sitemap:failed", host });
    throw err;
  }
}
