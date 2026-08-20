/**
 * Resolve a site key (an event slug) to the organisation and event it belongs
 * to, with a short in-memory cache.
 *
 * WHY CACHED
 * The ingest endpoint runs on every pageview of every public page. A database
 * round trip per beacon would defeat the point of buffering the writes: we
 * would have moved the load from INSERTs to SELECTs and still be competing with
 * the registration desk for the same connection pool.
 *
 * The mapping barely changes. A slug points at one event for that event's whole
 * life, so a short TTL is generous, and the failure mode of a stale entry is
 * that a hit is attributed to the event it was actually on.
 *
 * WHY NEGATIVE RESULTS ARE CACHED TOO
 * The site key comes from an unauthenticated request body, so anyone can ask
 * about a slug that does not exist. Without caching the misses, a loop over
 * random slugs is a free way to make us run one query per request, which is
 * exactly the thing the cache exists to prevent. Misses get a shorter TTL so a
 * genuinely new event becomes measurable quickly.
 */

import { db } from "@/lib/db";
import { publicEventWhereForHost } from "@/lib/public-event";
import { apiLogger } from "@/lib/logger";
import type { SiteBinding } from "@/analytics/store/prisma-store";

const HIT_TTL_MS = 5 * 60_000;
const MISS_TTL_MS = 60_000;
/** Bounded because the key is attacker-supplied. */
const MAX_ENTRIES = 500;

type Entry = { at: number; binding: SiteBinding | null };
const cache = new Map<string, Entry>();

function cacheKey(host: string | null, siteId: string): string {
  // Host is part of the key: on a multi-tenant instance the same slug can exist
  // for two tenants, and resolving one under the other's domain would file a
  // hit against the wrong organisation.
  return `${(host ?? "").toLowerCase()}|${siteId}`;
}

function remember(key: string, binding: SiteBinding | null): void {
  if (cache.size >= MAX_ENTRIES) {
    // Cheap eviction: drop the oldest inserted key. Map preserves insertion
    // order, and this only matters under a slug-spraying load where every entry
    // is junk anyway.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), binding });
}

/**
 * Returns the binding, or null when the slug does not resolve.
 *
 * A null means the hit must be DROPPED, not stored with a null organisation.
 * Every stored row carries an organisation, which is what lets the RLS policy
 * be strict in both directions rather than admitting orphan rows.
 */
export async function resolveSite(
  host: string | null,
  siteId: string,
): Promise<SiteBinding | null> {
  const key = cacheKey(host, siteId);
  const hit = cache.get(key);
  if (hit) {
    const ttl = hit.binding ? HIT_TTL_MS : MISS_TTL_MS;
    if (Date.now() - hit.at < ttl) return hit.binding;
    cache.delete(key);
  }

  try {
    // Same tenancy resolution as every other public route, so a slug that
    // belongs to another tenant on this host does not resolve here either.
    const where = await publicEventWhereForHost(host, siteId);
    const event = await db.event.findFirst({
      where,
      select: { id: true, organizationId: true },
    });

    const binding =
      event && event.organizationId
        ? { organizationId: event.organizationId, eventId: event.id }
        : null;
    remember(key, binding);
    return binding;
  } catch (err) {
    // Do NOT cache an error as a miss: the slug may be perfectly valid and the
    // database merely unavailable, and a cached miss would keep it unmeasurable
    // after recovery.
    apiLogger.error({ err, siteId }, "analytics:site-resolve-failed");
    return null;
  }
}

/** Test seam. Not for production use. */
export function __resetSiteCacheForTests(): void {
  cache.clear();
}
