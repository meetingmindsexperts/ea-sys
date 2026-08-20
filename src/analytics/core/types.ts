/**
 * Analytics core: the shared vocabulary.
 *
 * NOTHING in `src/analytics/core/` may import from EA-SYS. Not `@/lib/db`, not
 * the logger, not `next/server`. That rule is enforced in eslint.config.mjs and
 * it is what keeps this directory extractable as a standalone package later.
 * See docs/ANALYTICS_PLAN.md §7.
 *
 * The corollary that matters when reading these types: the core does not know
 * what a conference is. There is no `eventId` here and no `organizationId`.
 * A tenant is an opaque `siteId` string that the core hashes and passes
 * through. Binding that string to an EA-SYS organisation is the adapter's job,
 * not the library's.
 */

/**
 * Coarse device classification. Deliberately three buckets: this is used to
 * answer "is our register page usable on a phone", not to fingerprint. A finer
 * taxonomy would be a maintenance treadmill for no extra decision-making value.
 */
export type DeviceType = "mobile" | "tablet" | "desktop";

/**
 * One recorded hit. A pageview is just a hit whose `name` is "pageview";
 * conversions are hits with a different name and optionally a `value`.
 *
 * Note what is absent and must stay absent: there is no IP address field and no
 * raw user-agent field. Both are consumed at the request boundary to derive
 * `visitorHash`, `deviceType`, `browser` and `os`, and then discarded. A column
 * that does not exist cannot be filled in by a well-meaning future change.
 */
export interface AnalyticsHit {
  /** Opaque tenant/site key. In EA-SYS this is the event slug. */
  siteId: string;
  /** "pageview" or a conversion event name such as "register_submitted". */
  name: string;
  /** Pathname only. NEVER contains a query string (see path-policy.ts). */
  path: string;
  /** The allow-listed pattern this path matched, e.g. "/e/:slug/register". */
  routePattern: string;

  /** Rotating-salt visitor identity. Unlinkable across days by construction. */
  visitorHash: string;
  /** Derived 30-minute session window. Not stored client-side. */
  sessionHash: string;

  /** Referrer HOST only, never the full referrer URL (which can carry a path). */
  referrerHost?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;

  deviceType?: DeviceType | null;
  browser?: string | null;
  os?: string | null;
  /** ISO 3166-1 alpha-2. Phase 2; always null in v1. */
  country?: string | null;

  durationMs?: number | null;
  /** 0-100. */
  scrollDepth?: number | null;
  /** Conversion value, e.g. a ticket price. */
  value?: number | null;

  /**
   * When the hit happened, not when it was flushed. Writes are buffered up to
   * two seconds (see the plan §4.5), so relying on a database `now()` default
   * would silently smear timestamps across the flush window.
   */
  occurredAt: Date;
}

/**
 * The write half of storage.
 *
 * Split from the read half deliberately: the ingest path (Phase 2) needs only
 * this, and a narrower interface is a smaller thing for an adapter to get
 * right. It takes an array because every real caller batches.
 */
export interface AnalyticsWriter<H extends AnalyticsHit = AnalyticsHit> {
  record(hits: readonly H[]): Promise<void>;
}

/**
 * The read half. Kept minimal on purpose until the dashboard exists (Phase 4);
 * guessing at a query language before there is a consumer is how interfaces
 * end up with fields nobody uses.
 */
export interface AnalyticsReader<H extends AnalyticsHit = AnalyticsHit> {
  query(q: AnalyticsQuery): Promise<H[]>;
}

export interface AnalyticsQuery {
  siteId: string;
  from: Date;
  to: Date;
  /** Omit for all hit types. */
  name?: string;
  routePattern?: string;
  limit?: number;
}

export type AnalyticsStore<H extends AnalyticsHit = AnalyticsHit> =
  AnalyticsWriter<H> & AnalyticsReader<H>;
