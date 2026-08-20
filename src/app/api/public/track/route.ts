/**
 * Analytics ingest. The only write surface for the measurement feature.
 *
 *   POST /api/public/track   ->  204, always
 *
 * DESIGN RULES, all of which are load-bearing:
 *
 *  1. It ALWAYS answers 204. Not on success, not on valid input: always. A
 *     visitor is on a registration page, and a beacon that returns an error is
 *     an error in their console and possibly a broken page. Every rejection
 *     below is silent to the caller and logged for us.
 *
 *  2. The visitor identity is computed HERE, server-side, from the request's own
 *     IP and user agent. The client never sends or sees it, and the raw IP never
 *     leaves this function: it is consumed to derive a rotating-salt hash and
 *     then discarded. There is no ipAddress column to put it in.
 *
 *  3. The path is checked against the SAME allow-list the browser used. A
 *     tampered body claiming to be on a token route is rejected by the same
 *     predicate, so the client-side check is an optimisation rather than the
 *     guard.
 *
 *  4. Nothing is awaited on the database. The hit goes into a buffer and this
 *     returns. See src/analytics/buffer.ts for why (a pageview burst must never
 *     compete with the registration desk for the connection pool).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { identifyVisitor } from "@/analytics/core/visitor-hash";
import { matchRoute, normalisePath, extractUtm, referrerHost } from "@/analytics/core/path-policy";
import { isBot } from "@/analytics/core/bots";
import { parseUserAgent } from "@/analytics/core/user-agent";
import { enqueueHit } from "@/analytics/buffer";
import { resolveSite } from "@/analytics/store/site-resolver";

/**
 * Latched so the "no secret configured" alarm is raised once per container
 * rather than once per request. See where it is used.
 */
let warnedMissingSecret = false;

/** Answered for every outcome. See rule 1. */
const NO_CONTENT = new NextResponse(null, { status: 204 });
function noContent() {
  return new NextResponse(null, { status: 204 });
}

/**
 * Conversion names we accept. An allow-list rather than a free string: the name
 * is attacker-supplied and ends up grouped in a dashboard, so an open field
 * would let anyone create unlimited junk series and make the chart useless.
 */
const EVENT_NAMES = [
  "pageview",
  // Sent on departure with time-on-page and scroll depth. Separate from
  // "pageview" so the count is not doubled by amending it.
  "page_engagement",
  "register_viewed",
  "register_step2",
  "register_submitted",
  "checkout_started",
  "payment_completed",
  "agenda_viewed",
  "session_viewed",
  "abstract_started",
  "abstract_submitted",
] as const;

const bodySchema = z.object({
  /** Event slug. */
  site: z.string().min(1).max(200),
  /** Defaults to a pageview. */
  name: z.enum(EVENT_NAMES).default("pageview"),
  /** Pathname or full URL; the query is stripped before storage either way. */
  path: z.string().min(1).max(2000),
  /** Raw query string, so the three utm keys can be extracted and the rest dropped. */
  query: z.string().max(2000).optional(),
  /**
   * Referring HOST, already reduced in the browser so a referring URL's own
   * path and query never reach us. Re-reduced below as defence in depth, since
   * this body is client-supplied.
   */
  referrerHost: z.string().max(300).optional(),
  /**
   * Legacy full referrer. Kept only so a browser holding the previous bundle
   * during a deploy still reports acquisition rather than silently losing it;
   * it is reduced identically. Remove once no old bundle can be in flight.
   */
  referrer: z.string().max(2000).optional(),
  /** Time on page, reported on unload. */
  durationMs: z.number().int().min(0).max(24 * 3600_000).optional(),
  scrollDepth: z.number().int().min(0).max(100).optional(),
  /** Conversion value, e.g. a ticket price. */
  value: z.number().min(0).max(1_000_000).optional(),
});

export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const userAgent = req.headers.get("user-agent");

    // Sized for a VENUE, not for a person. A whole conference hall arrives
    // through one NAT address, so this budget is shared by everyone in the
    // room: 1,000 attendees at roughly fifteen hits each is 15,000 in a single
    // busy hour. The earlier 2,000 would have been exhausted mid-morning and
    // then silently dropped the traffic we are trying to measure, at the exact
    // moment it matters most. That is the same failure the survey ipHash dedup
    // had, where the guard fired hardest during intended use.
    //
    // It is a bound on a runaway client, not a quota. The real limits on junk
    // are the bot filter, the path allow-list, and the 400-day prune.
    const { allowed } = checkRateLimit({
      key: `analytics-track:${ip}`,
      limit: 20_000,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ ip }, "analytics:track-rate-limited");
      return noContent();
    }

    // Bots never reach storage. The beacon is JavaScript so most crawlers never
    // run it, but headless browsers and link-preview fetchers do.
    if (isBot(userAgent)) return noContent();

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      apiLogger.warn(
        { ip, fieldErrors: parsed.error.flatten().fieldErrors },
        "analytics:track-invalid-input",
      );
      return noContent();
    }
    const body = parsed.data;

    // Rule 3: re-check the path server-side. A body claiming to be on a token
    // route dies here regardless of what the browser believed.
    const path = normalisePath(body.path);
    const route = path ? matchRoute(path) : null;
    if (!path || !route) {
      apiLogger.warn({ ip, site: body.site }, "analytics:track-path-not-measurable");
      return noContent();
    }

    const binding = await resolveSite(req.headers.get("host"), body.site);
    if (!binding) {
      // Dropped rather than stored org-less. An unattributable hit is worth
      // nothing, and admitting one would force the RLS policy to allow orphan
      // rows for no benefit.
      apiLogger.warn({ ip, site: body.site }, "analytics:track-unresolved-site");
      return noContent();
    }

    const secret = process.env.ANALYTICS_SALT_SECRET;
    if (!secret) {
      // Refuse rather than fall back to a constant: a known salt makes every
      // visitor hash reproducible by anyone who reads the source, which is the
      // one outcome this design must never have.
      //
      // Error level, because the feature is silently collecting nothing and
      // that should page. But ONCE per process, not once per pageview: this is
      // the ordinary state between deploying the code and setting the variable,
      // and at a few thousand hits a day an unguarded error here would bury
      // /logs and hammer the SES admin alert with the same sentence. One line
      // per container is the whole signal; repeating it adds nothing.
      if (!warnedMissingSecret) {
        warnedMissingSecret = true;
        apiLogger.error(
          {},
          "analytics:missing-salt-secret — set ANALYTICS_SALT_SECRET; no traffic is being recorded",
        );
      }
      return noContent();
    }

    const now = new Date();
    const { visitorHash, sessionHash } = identifyVisitor({
      secret,
      ip,
      userAgent: userAgent ?? "",
      siteId: body.site,
      now,
    });

    const ua = parseUserAgent(userAgent);
    const utm = extractUtm(body.query);

    enqueueHit({
      organizationId: binding.organizationId,
      eventId: binding.eventId,
      siteId: body.site,
      name: body.name,
      path,
      routePattern: route.pattern,
      visitorHash,
      sessionHash,
      // Re-reduced even though the browser already did it: this body is
      // client-supplied, so a tampered or legacy payload carrying a full URL
      // must still be cut down to a host. referrerHost is idempotent, so a
      // value that is already a bare host passes through unchanged.
      //
      // The internal host is this request's own, so on a multi-tenant instance
      // each tenant's own navigation is excluded from its acquisition figures
      // rather than one hardcoded domain being excluded from everyone's.
      referrerHost: referrerHost(body.referrerHost ?? body.referrer, [
        req.headers.get("host") ?? "",
      ]),
      utmSource: utm.utmSource,
      utmMedium: utm.utmMedium,
      utmCampaign: utm.utmCampaign,
      deviceType: ua.deviceType,
      browser: ua.browser,
      os: ua.os,
      country: null, // Phase 2 of the plan; deliberately not guessed.
      durationMs: body.durationMs ?? null,
      scrollDepth: body.scrollDepth ?? null,
      value: body.value ?? null,
      occurredAt: now,
    });

    return noContent();
  } catch (err) {
    // Rule 1 holds even here. Nothing a visitor does on a registration page
    // should be affected by analytics failing.
    apiLogger.error({ err }, "analytics:track-failed");
    return NO_CONTENT;
  }
}
