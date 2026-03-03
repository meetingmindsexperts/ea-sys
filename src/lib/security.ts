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
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }

  return req.headers.get("x-real-ip") || "unknown";
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
  const pepper = process.env.NEXTAUTH_SECRET || "";
  return crypto.createHash("sha256").update(`${token}:${pepper}`).digest("hex");
}
