/**
 * Which paths may be measured, and what is allowed to survive into storage.
 *
 * CLIENT-SAFE. No node: imports. The beacon needs this in the browser to decide
 * whether to send at all, and the ingest route needs it on the server to decide
 * whether to accept. Both sides run the SAME rules, so a tampered payload is
 * rejected by the same predicate the client used.
 *
 * ALLOW-LIST, NEVER EXCLUDE-LIST. This is the load-bearing decision in the
 * file. An exclude-list fails OPEN: add a public route in six months and it is
 * measured by default, leaking whatever its URL carries until somebody
 * remembers. An allow-list fails CLOSED: the new route is invisible until
 * someone deliberately adds it. EA-SYS has eight public routes whose URLs carry
 * bearer tokens or a person's name, so failing open is not a theoretical cost.
 * The same inversion was applied to the /uploads deny-list on 2026-08-19.
 */

/** A matched route, with the parameters the caller needs to resolve a site. */
export interface MatchedRoute {
  /** The canonical pattern, e.g. "/e/:slug/register/:category". */
  pattern: string;
  /** Named segments captured from the path. */
  params: Record<string, string>;
}

/**
 * Every measurable route. Anything not listed here is unmeasurable, including
 * every token-gated route, which is the point.
 *
 * Deliberately absent, and they must stay absent:
 *   /e/:slug/rsvp/:token          the token IS the identity
 *   /e/:slug/reimbursement/:token gates passport scans and bank details
 *   /e/:slug/speaker-form/:token  same class
 *   /e/:slug/reset-password       carries a live reset token and an email
 *   /e/:slug/complete-registration, /presenter-agreement, /survey
 *   /e/:slug/confirmation         its query carries a registrant's first name
 */
export const MEASURABLE_ROUTES: readonly string[] = [
  "/e/:slug",
  "/e/:slug/agenda",
  "/e/:slug/register",
  "/e/:slug/register/:category",
  "/e/:slug/session/:sessionId",
];

/**
 * The only query parameters that survive. Everything else in the query string
 * is discarded before storage rather than filtered later, which kills the
 * ?name= and ?token= exposure at source instead of depending on a redaction
 * step somebody has to maintain.
 */
export const KEPT_QUERY_PARAMS = ["utm_source", "utm_medium", "utm_campaign"] as const;

export interface Utm {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
}

const MAX_PARAM_LENGTH = 255;

function clean(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().slice(0, MAX_PARAM_LENGTH);
  return trimmed === "" ? null : trimmed;
}

/**
 * Split a path into segments, tolerating a trailing slash and repeated
 * separators. Returns null for anything that is not an absolute path, so a full
 * URL or a protocol-relative string cannot slip through as a path.
 */
function segmentsOf(pathname: string): string[] | null {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return null;
  if (pathname.startsWith("//")) return null;
  return pathname.split("/").filter((s) => s !== "");
}

/**
 * Match a pathname against the allow-list.
 *
 * Returns null when nothing matches, and null means unmeasurable. Callers must
 * treat that as "drop the hit", never as "store it uncategorised".
 */
export function matchRoute(pathname: string): MatchedRoute | null {
  const segs = segmentsOf(pathname);
  if (!segs) return null;

  for (const pattern of MEASURABLE_ROUTES) {
    const parts = pattern.split("/").filter((s) => s !== "");
    if (parts.length !== segs.length) continue;

    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const seg = segs[i];
      if (part.startsWith(":")) {
        // A parameter matches any single non-empty segment. It cannot contain a
        // slash, because segmentsOf already split on those.
        params[part.slice(1)] = seg;
      } else if (part !== seg) {
        ok = false;
        break;
      }
    }
    if (ok) return { pattern, params };
  }
  return null;
}

/** True when this path may be measured at all. */
export function isMeasurable(pathname: string): boolean {
  return matchRoute(pathname) !== null;
}

/**
 * Reduce a raw URL to the pathname we are willing to store.
 *
 * The returned path NEVER contains a query string or a fragment. That is an
 * invariant rather than a convention, and it is asserted by a test: it is what
 * stops ?name= and ?token= reaching the database no matter what a caller sends.
 *
 * Accepts a full URL or a bare path, because the beacon reports
 * location.pathname while a server-side caller may hold the whole thing.
 */
export function normalisePath(rawUrl: string): string | null {
  if (typeof rawUrl !== "string" || rawUrl === "") return null;
  let pathname = rawUrl;

  // Strip an origin if one is present, without using the URL constructor, which
  // would also happily accept "javascript:" and other non-http schemes.
  const schemeEnd = pathname.indexOf("://");
  if (schemeEnd !== -1) {
    const afterScheme = pathname.slice(schemeEnd + 3);
    const slash = afterScheme.indexOf("/");
    pathname = slash === -1 ? "/" : afterScheme.slice(slash);
  }

  const cut = Math.min(
    ...[pathname.indexOf("?"), pathname.indexOf("#")]
      .filter((i) => i !== -1)
      .concat([pathname.length]),
  );
  pathname = pathname.slice(0, cut);

  // Normalise a trailing slash so "/e/x/" and "/e/x" are one path rather than
  // two rows that look like different pages.
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);

  return pathname.startsWith("/") ? pathname : null;
}

/**
 * Pull the three UTM values out of a query string, discarding everything else.
 *
 * Takes the raw query (with or without a leading "?") rather than a parsed
 * object, so the caller cannot accidentally hand us a bag that still contains
 * the parameters we are trying to drop.
 */
export function extractUtm(rawQuery: string | null | undefined): Utm {
  const result: Utm = { utmSource: null, utmMedium: null, utmCampaign: null };
  if (!rawQuery) return result;

  const query = rawQuery.startsWith("?") ? rawQuery.slice(1) : rawQuery;
  const params = new URLSearchParams(query);
  result.utmSource = clean(params.get("utm_source"));
  result.utmMedium = clean(params.get("utm_medium"));
  result.utmCampaign = clean(params.get("utm_campaign"));
  return result;
}

/**
 * Referrer reduced to a host.
 *
 * Host only, never the full referrer URL: a referring URL can carry a path and
 * a query of its own, which is somebody else's data and none of our business.
 *
 * `internalHosts` is a parameter rather than a constant because on a
 * multi-tenant instance each tenant has its own domain. Hardcoding one would
 * count every other tenant's internal navigation as acquisition.
 */
export function referrerHost(
  rawReferrer: string | null | undefined,
  internalHosts: readonly string[] = [],
): string | null {
  if (!rawReferrer) return null;

  let host = rawReferrer.trim();
  host = host.replace(/^https?:\/\//i, "");
  const slash = host.indexOf("/");
  if (slash !== -1) host = host.slice(0, slash);
  host = host.split("@").pop() ?? host; // strip any userinfo
  host = host.split(":")[0]; // strip the port
  host = host.replace(/^www\./i, "").toLowerCase();

  // Must look like a hostname. This also rejects the empty string and anything
  // that survived the stripping above as junk.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/.test(host)) return null;

  // A bare IPv4 is never legitimate acquisition: it is our own box reached by
  // address, a scanner, or something misconfigured. Nobody links to you from an
  // IP-addressed page.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;

  for (const internal of internalHosts) {
    const h = internal.trim().toLowerCase().replace(/^www\./, "");
    if (h === "") continue;
    // Suffix match anchored on a dot, so "notclaude.ai" does not count as
    // internal for "claude.ai" and neither does "claude.ai.evil.com".
    if (host === h || host.endsWith(`.${h}`)) return null;
  }

  return host.slice(0, 120);
}
