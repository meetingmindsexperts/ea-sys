import crypto from "crypto";

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

// In-memory rate limiting: works reliably on EC2/Docker (single process).
// On Vercel serverless, state persists within warm Lambda invocations but resets
// on cold starts. For stricter limits on Vercel, migrate to Redis (Vercel KV / Upstash).
const RATE_LIMIT_STORE_KEY = "__ea_sys_rate_limit_store";
const RATE_LIMIT_CLEANUP_KEY = "__ea_sys_rate_limit_last_cleanup";
const CLEANUP_INTERVAL_MS = 60_000; // Run cleanup at most once per minute
const MAX_STORE_SIZE = 10_000; // Force cleanup if store exceeds this size

function getRateLimitStore(): Map<string, RateLimitEntry> {
  const globalRef = globalThis as typeof globalThis & {
    [RATE_LIMIT_STORE_KEY]?: Map<string, RateLimitEntry>;
    [RATE_LIMIT_CLEANUP_KEY]?: number;
  };

  if (!globalRef[RATE_LIMIT_STORE_KEY]) {
    globalRef[RATE_LIMIT_STORE_KEY] = new Map<string, RateLimitEntry>();
  }

  const store = globalRef[RATE_LIMIT_STORE_KEY];
  const now = Date.now();
  const lastCleanup = globalRef[RATE_LIMIT_CLEANUP_KEY] ?? 0;

  // Periodic cleanup: remove expired entries
  if (now - lastCleanup > CLEANUP_INTERVAL_MS || store.size > MAX_STORE_SIZE) {
    globalRef[RATE_LIMIT_CLEANUP_KEY] = now;
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) {
        store.delete(key);
      }
    }
  }

  return store;
}

export function getClientIp(req: Request): string {
  // nginx is the ONLY proxy in front of the app and sets `X-Real-IP` to the
  // real socket peer (`$remote_addr`), overwriting anything the client sent —
  // so it's the trustworthy source. We are NOT behind a CDN/Cloudflare, so we
  // must NOT trust `CF-Connecting-IP` or the *first* `X-Forwarded-For` entry:
  // on a directly-exposed origin both are attacker-supplied, and a client
  // could forge a different value per request to bypass IP rate limiting.
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  // Fallback only if X-Real-IP is somehow absent: nginx APPENDS the real peer
  // to X-Forwarded-For (`$proxy_add_x_forwarded_for`), so the trustworthy
  // value is the LAST entry — earlier entries are client-controlled.
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const parts = forwardedFor.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }

  return "unknown";
}

export function checkRateLimit({
  key,
  limit,
  windowMs,
}: {
  key: string;
  limit: number;
  windowMs: number;
}): RateLimitResult {
  const now = Date.now();
  const store = getRateLimitStore();
  const current = store.get(key);

  if (!current || current.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return {
      allowed: true,
      remaining: limit - 1,
      retryAfterSeconds: Math.ceil(windowMs / 1000),
    };
  }

  if (current.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }

  current.count += 1;
  store.set(key, current);

  return {
    allowed: true,
    remaining: Math.max(0, limit - current.count),
    retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
  };
}

export function hashVerificationToken(token: string): string {
  const pepper = process.env.NEXTAUTH_SECRET;
  if (!pepper) {
    throw new Error("NEXTAUTH_SECRET environment variable is required for token hashing");
  }
  return crypto.createHash("sha256").update(`${token}:${pepper}`).digest("hex");
}

export type SameOriginCheck = { ok: true } | { ok: false; reason: string };

/**
 * Assert that a cookie-authenticated, state-changing POST came from our own
 * page (Aug 12, 2026).
 *
 * WHY THIS IS NEEDED AT ALL, given `src/proxy.ts` already does an Origin/Host
 * check on API mutations: that check EXCLUDES `/api/mcp/**`, deliberately, so
 * browser-based MCP clients are not blocked by the mobile-only CORS allow-list.
 * The exclusion is correct for the transport endpoint, which authenticates by
 * Bearer token and is therefore not CSRF-able. It is NOT correct for the OAuth
 * consent decision route, which sits under the same prefix but authenticates by
 * SESSION COOKIE and mints an authorization code.
 *
 * That route was safe only because Auth.js defaults the session cookie to
 * `SameSite=Lax`, which browsers do not attach to a cross-site POST. That is a
 * real protection, but it is a protection we INHERITED rather than wrote: one
 * `sameSite: "none"` in the auth config (to embed the dashboard, to support a
 * webview) would silently re-open it, and nothing in the repo would fail. A
 * guarantee you did not write is a guarantee you cannot test, so we write it.
 *
 * Modern browsers send `Origin` on every POST, same-origin included. `Referer`
 * is the fallback for older clients and for the rare privacy setting that
 * strips Origin. Neither present means it is not a browser form post, which is
 * the only legitimate caller here, so it is refused: same posture the proxy
 * takes for an origin-less mutation with no API key.
 */
export function isSameOriginRequest(req: Request): SameOriginCheck {
  const host = req.headers.get("host");
  if (!host) return { ok: false, reason: "no-host-header" };

  const origin = req.headers.get("origin");
  if (origin) {
    // "null" is what a sandboxed iframe or a redirect-laundered form sends. It
    // is not our origin, and treating it as absent would fall through to the
    // Referer branch an attacker also controls.
    if (origin === "null") return { ok: false, reason: "opaque-origin" };
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return { ok: false, reason: "unparseable-origin" };
    }
    return originHost === host ? { ok: true } : { ok: false, reason: "origin-mismatch" };
  }

  const referer = req.headers.get("referer");
  if (referer) {
    let refererHost: string;
    try {
      refererHost = new URL(referer).host;
    } catch {
      return { ok: false, reason: "unparseable-referer" };
    }
    return refererHost === host ? { ok: true } : { ok: false, reason: "referer-mismatch" };
  }

  return { ok: false, reason: "no-origin-or-referer" };
}
