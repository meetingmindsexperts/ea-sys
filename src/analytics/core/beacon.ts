/**
 * The browser half: deciding whether to report a hit, and getting it out.
 *
 * CLIENT-SAFE and framework-free. No node: imports, no React, no dependency.
 * The React wrapper is one level up in src/analytics/react/.
 *
 * Two rules govern everything here:
 *
 *  1. It must NEVER be able to break a page. A visitor is filling in a
 *     registration form; nothing about measuring that may throw, block paint,
 *     or surface an error. Every entry point swallows.
 *
 *  2. It must NEVER send anything from a page it is not allowed to measure.
 *     The server re-checks, so this is not the security boundary, but a request
 *     that is going to be rejected should not be made at all: the URL of a
 *     token-gated page should not leave the browser even to be refused.
 */

import { isMeasurable, normalisePath, referrerHost } from "./path-policy";

export interface BeaconPayload {
  /** Event slug. */
  site: string;
  /** "pageview", "page_engagement", or a conversion name. */
  name: string;
  /** Pathname. The query is passed separately and mostly discarded. */
  path: string;
  query?: string;
  /**
   * Referring HOST only, already reduced in the browser.
   *
   * Deliberately not the full referrer: a referring URL can carry a token or an
   * email in its own query, and that is somebody else's sensitive data. The
   * server reduces it again as defence in depth, but the reduction happens here
   * so the full URL never leaves the browser at all. Same principle this module
   * applies to our own paths.
   */
  referrerHost?: string;
  durationMs?: number;
  scrollDepth?: number;
  value?: number;
}

/**
 * Post a payload without blocking anything.
 *
 * navigator.sendBeacon first: it is the only mechanism the browser promises to
 * complete after the page is gone, which is exactly when the engagement hit is
 * sent. fetch with keepalive is the fallback, and a plain fetch the last
 * resort, because a measurement that sometimes misses is much better than one
 * that holds up an unload.
 */
export function postBeacon(endpoint: string, payload: BeaconPayload): void {
  try {
    const body = JSON.stringify(payload);

    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      // text/plain avoids a CORS preflight. The route parses the body itself
      // and does not care about the declared type.
      const blob = new Blob([body], { type: "text/plain;charset=UTF-8" });
      if (navigator.sendBeacon(endpoint, blob)) return;
    }

    void fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
      // No credentials: this endpoint is unauthenticated by design and should
      // never receive a session cookie it might be tempted to use.
      credentials: "omit",
    }).catch(() => {
      // Swallowed on purpose. See rule 1.
    });
  } catch {
    // Swallowed on purpose. See rule 1.
  }
}

export interface TrackOptions {
  endpoint?: string;
  /** Injectable for tests. */
  send?: (endpoint: string, payload: BeaconPayload) => void;
}

export const DEFAULT_ENDPOINT = "/api/public/track";

/**
 * Report a hit, if this page may be measured at all.
 *
 * Returns whether anything was sent, which is what the tests assert on. The
 * allow-list is checked BEFORE the query string or referrer are read, so on a
 * token-gated page those values are never even touched, let alone transmitted.
 */
export function track(
  site: string,
  name: string,
  location: { pathname: string; search: string },
  extras: Omit<BeaconPayload, "site" | "name" | "path" | "query" | "referrerHost"> = {},
  /** Raw document.referrer. Reduced to a host here and never sent whole. */
  referrer?: string,
  opts: TrackOptions = {},
  /** Hosts that count as our own, so internal navigation is not acquisition. */
  internalHosts: readonly string[] = [],
): boolean {
  try {
    if (!site) return false;

    const path = normalisePath(location.pathname);
    if (!path || !isMeasurable(path)) return false;

    (opts.send ?? postBeacon)(opts.endpoint ?? DEFAULT_ENDPOINT, {
      site,
      name,
      path,
      query: location.search || undefined,
      referrerHost: referrerHost(referrer, internalHosts) ?? undefined,
      ...extras,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * How far down the page the visitor got, 0-100.
 *
 * Returns 100 for a page shorter than the viewport rather than dividing by
 * zero: everything was visible, so it was all seen.
 */
export function scrollDepthPercent(win: {
  scrollY: number;
  innerHeight: number;
  documentHeight: number;
}): number {
  const scrollable = win.documentHeight - win.innerHeight;
  if (scrollable <= 0) return 100;
  const pct = Math.round(((win.scrollY + win.innerHeight) / win.documentHeight) * 100);
  return Math.max(0, Math.min(100, pct));
}
