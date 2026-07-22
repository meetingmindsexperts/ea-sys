/**
 * Host → organization tenant resolver (multi-tenancy Phase 0 spine).
 *
 * Maps the request's Host header to an organization via the TenantDomain
 * table, with a safety ramp so the single-tenant master deployment can never
 * 404 its own traffic (docs/MULTI_TENANCY.md §0):
 *
 *   1. Host matches a VERIFIED TenantDomain row → that org.
 *   2. No match and TENANCY_ENFORCE_HOST is not "1" (master, always):
 *      DEFAULT_ORG_ID set → fall back to it; unset → resolve to NO org, which
 *      makes downstream where-builders emit the legacy, org-unscoped query —
 *      byte-identical to pre-tenancy behavior.
 *   3. No match and TENANCY_ENFORCE_HOST === "1" (platform instance only) →
 *      unresolved; downstream lookups miss naturally (404 semantics).
 *
 * A resolver DB error NEVER fails the request — it logs and takes the stage-2
 * fallback. Lookups are micro-cached per container (bounded, negative results
 * included) because Host is attacker-controlled: a garbage-host flood must not
 * become a DB-query flood or unbounded memory growth.
 *
 * Deliberately a library, not middleware: the public-event where-builder
 * (src/lib/public-event.ts) calls this internally so the resolver and the
 * org-scoped slug lookups land/execute atomically, and src/proxy.ts stays
 * decoupled from Prisma.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

export type TenantResolution =
  /** Host matched a verified TenantDomain row. */
  | { orgId: string; source: "domain" }
  /** Unknown host, non-enforcing: fell back to DEFAULT_ORG_ID. */
  | { orgId: string; source: "default-env" }
  /** Unknown host, non-enforcing, no default: legacy org-unscoped behavior. */
  | { orgId: null; source: "unscoped" }
  /** Unknown host with TENANCY_ENFORCE_HOST=1: request resolves nothing. */
  | { orgId: null; source: "unknown-enforced" };

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 500;

interface CacheEntry {
  res: TenantResolution;
  at: number;
}

// Per-container micro-cache (same pattern as the lobby-status cache, but
// bounded + negative-caching because the key is attacker-controlled).
const cache = new Map<string, CacheEntry>();

/** Test hook — resets the per-container cache. */
export function clearTenantResolverCache(): void {
  cache.clear();
}

/**
 * Normalize a raw Host header for TenantDomain lookup: lowercase, strip the
 * port and any trailing dot. Returns null for absent/empty/garbage values
 * (whitespace or path separators — not a hostname).
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const host = raw.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (!host || /[\s/\\@]/.test(host)) return null;
  return host;
}

function fallbackResolution(host: string | null): TenantResolution {
  if (process.env.TENANCY_ENFORCE_HOST === "1") {
    apiLogger.warn({ host, msg: "tenant:host-rejected" });
    return { orgId: null, source: "unknown-enforced" };
  }
  const defaultOrgId = process.env.DEFAULT_ORG_ID;
  if (defaultOrgId) {
    apiLogger.warn({ host, defaultOrgId, msg: "tenant:host-unresolved-default" });
    return { orgId: defaultOrgId, source: "default-env" };
  }
  apiLogger.warn({ host, msg: "tenant:host-unresolved-unscoped" });
  return { orgId: null, source: "unscoped" };
}

/**
 * Resolve the tenant org for a (normalized) host. Pass the output of
 * `normalizeHost()`. Never throws.
 */
export async function resolveTenantOrg(host: string | null): Promise<TenantResolution> {
  // No usable host at all → straight to the ramp (nothing to look up or cache).
  if (!host) return fallbackResolution(host);

  const cached = cache.get(host);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.res;

  let res: TenantResolution;
  try {
    const row = await db.tenantDomain.findUnique({
      where: { domain: host },
      select: { organizationId: true, verifiedAt: true },
    });
    if (row?.verifiedAt) {
      res = { orgId: row.organizationId, source: "domain" };
    } else {
      if (row) {
        // Unverified rows never route (domain-takeover guard) — distinct log
        // so an operator who forgot --verified can see why.
        apiLogger.warn({ host, msg: "tenant:host-unverified" });
      }
      res = fallbackResolution(host);
    }
  } catch (err) {
    // The resolver must never fail a request that would otherwise work.
    apiLogger.error({ err, host, msg: "tenant:resolve-failed" });
    return fallbackResolution(host); // deliberately uncached — retry next request
  }

  // Bounded insert: evict the oldest entry (Map preserves insertion order).
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(host, { res, at: Date.now() });
  return res;
}
