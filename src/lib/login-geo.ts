/**
 * IP → approximate location, resolved LAZILY.
 *
 * WHY NOT AT LOGIN TIME
 * ---------------------
 * The obvious implementation is to look the IP up while recording the sign-in.
 * That would put an outbound HTTP call between the password check and session
 * creation: a slow provider makes signing in feel broken, and one that throws
 * would fail the login outright. Location is a field nobody reads in real time,
 * so it has no business being on the critical path of getting into the product.
 *
 * Instead `LoginEvent` stores the IP at sign-in and this module resolves it the
 * first time an admin actually opens the view. The answer is written back to
 * the row (`geoCity` / `geoCountry` / `geoResolvedAt`), so each distinct
 * address costs exactly one lookup, ever.
 *
 * PRIVACY NOTE
 * ------------
 * This sends a user's IP address — personal data — to a third-party service
 * outside the region. That is a deliberate trade for a feature that was asked
 * for, but it is a cross-border transfer, so it is behind a single switch:
 * set `LOGIN_GEO_ENABLED=false` and no address ever leaves the box. The admin
 * view degrades gracefully to showing the raw IP, which is the part that
 * actually matters for investigating something.
 *
 * ACCURACY
 * --------
 * IP geolocation resolves to the network, not the person. Country is usually
 * right; city is frequently the ISP's exchange rather than where anyone is
 * sitting, and mobile networks and VPNs can be far off. The UI labels it
 * "approximate" for that reason — it is a "does this look wrong?" signal, not
 * evidence.
 */

import { apiLogger } from "@/lib/logger";

export interface ResolvedLocation {
  city: string | null;
  country: string | null;
}

/**
 * `ok: false` means the lookup FAILED and should be retried later — the caller
 * must leave `geoResolvedAt` null. `ok: true` with null fields means "resolved,
 * and there genuinely is no location" (a private address), which the caller
 * should stamp as resolved so it is never retried.
 */
export type GeoLookup = { ok: true; location: ResolvedLocation } | { ok: false };

const LOOKUP_TIMEOUT_MS = 3000;

/** In-process memo so one page-load resolving many rows hits the provider once. */
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; location: ResolvedLocation }>();

export function isGeoEnabled(): boolean {
  // Enabled unless explicitly switched off, so the feature works on a fresh
  // deploy — but a single env var stops all outbound IP traffic.
  return process.env.LOGIN_GEO_ENABLED !== "false";
}

/**
 * Strict IPv4 / IPv6 shape check.
 *
 * `getClientIp` reads a header. nginx overwrites `X-Real-IP` with the real
 * socket peer so in practice it is trustworthy, but this string is about to be
 * interpolated into an outbound URL — validating the shape first means a
 * malformed or hostile value can never become a request to somewhere else.
 */
export function isValidIpAddress(ip: string): boolean {
  if (!ip || ip.length > 45) return false;

  // IPv4: four 0-255 octets, in canonical form.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    return v4.slice(1).every((part) => {
      const n = Number(part);
      if (!(n >= 0 && n <= 255)) return false;
      // Reject leading zeros: some resolvers read `0177.0.0.1` as OCTAL and
      // land on 127.0.0.1, so a non-canonical octet is a way to smuggle one
      // address past a check that reads it as another.
      return String(n) === part;
    });
  }

  // IPv6: hex groups and colons only, with at most one `::`.
  if (!/^[0-9a-fA-F:]+$/.test(ip)) return false;
  if ((ip.match(/::/g) ?? []).length > 1) return false;
  return ip.includes(":");
}

/**
 * Addresses that can never have a meaningful public location: loopback, the
 * RFC1918 private ranges, link-local, CGNAT, and IPv6 local scopes.
 *
 * These resolve to "no location" permanently rather than being retried — in
 * development every single row would otherwise queue a doomed lookup.
 */
export function isPrivateOrUnroutableIp(ip: string): boolean {
  if (!ip || ip === "unknown") return true;

  if (ip === "::1" || ip === "::") return true;
  const lower = ip.toLowerCase();
  // Unique-local (fc00::/7) and link-local (fe80::/10).
  if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe8")) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!v4) return false;

  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  // Carrier-grade NAT — routable on the carrier's network, not locatable.
  if (a === 100 && b >= 64 && b <= 127) return true;

  return false;
}

/**
 * Look up one address. NEVER throws — every failure path returns `ok: false`
 * and logs, so a provider outage can only mean "location column stays empty".
 */
export async function resolveIpLocation(ip: string): Promise<GeoLookup> {
  if (!isGeoEnabled()) return { ok: false };

  // Permanent non-answers: stamp as resolved so they're never retried.
  if (isPrivateOrUnroutableIp(ip)) {
    return { ok: true, location: { city: null, country: null } };
  }
  if (!isValidIpAddress(ip)) {
    apiLogger.warn({ msg: "login-geo:invalid-ip", ip });
    return { ok: true, location: { city: null, country: null } };
  }

  const cached = cache.get(ip);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ok: true, location: cached.location };
  }

  const token = process.env.LOGIN_GEO_TOKEN;
  const url = token
    ? `https://ipapi.co/${encodeURIComponent(ip)}/json/?key=${encodeURIComponent(token)}`
    : `https://ipapi.co/${encodeURIComponent(ip)}/json/`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      headers: { Accept: "application/json", "User-Agent": "EA-SYS/login-activity" },
    });

    if (!res.ok) {
      apiLogger.warn({ msg: "login-geo:lookup-failed", ip, status: res.status });
      return { ok: false };
    }

    const body = (await res.json()) as {
      city?: unknown;
      country_name?: unknown;
      error?: unknown;
      reason?: unknown;
    };

    // ipapi.co reports quota exhaustion and bad input as HTTP 200 with an
    // `error` flag, so a status check alone would silently store garbage.
    if (body.error) {
      apiLogger.warn({ msg: "login-geo:provider-error", ip, reason: String(body.reason ?? "unknown") });
      return { ok: false };
    }

    const location: ResolvedLocation = {
      city: typeof body.city === "string" && body.city.trim() ? body.city.trim() : null,
      country:
        typeof body.country_name === "string" && body.country_name.trim()
          ? body.country_name.trim()
          : null,
    };

    cache.set(ip, { at: Date.now(), location });
    return { ok: true, location };
  } catch (err) {
    // Timeout, DNS failure, malformed JSON — all transient, all retryable.
    apiLogger.warn({ err, msg: "login-geo:lookup-error", ip });
    return { ok: false };
  }
}

/** Test seam — drops the in-process memo. */
export function __resetGeoCacheForTests(): void {
  cache.clear();
}
