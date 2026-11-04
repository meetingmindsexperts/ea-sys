import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { ROBOTS_DISALLOW, siteOrigin } from "@/lib/seo";

/**
 * robots.txt, per site address (Nov 4, 2026). Every crawler, AI assistants'
 * included (owner: allow them, for answer engines), may read the public
 * catalogue and event pages; the rules in src/lib/seo.ts keep the dashboard,
 * sign-in, personal and secret-link pages out of indexes.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const h = await headers();
  const origin = siteOrigin(h.get("host"), h.get("x-forwarded-proto"));
  return {
    rules: [{ userAgent: "*", allow: ["/", "/catalogue", "/e/"], disallow: [...ROBOTS_DISALLOW] }],
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
