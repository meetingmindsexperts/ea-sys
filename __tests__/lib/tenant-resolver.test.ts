/**
 * Host → org tenant resolver (multi-tenancy Phase 0 spine).
 * Pins: host normalization, the verified-row match, the three-stage unknown-
 * host safety ramp (default-env / unscoped / enforced), the never-throw DB
 * error fallback, and the bounded negative-caching micro-cache — Host is
 * attacker-controlled, so cache behavior is a security property here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDb, mockLogger } = vi.hoisted(() => ({
  mockDb: {
    tenantDomain: { findUnique: vi.fn() },
  },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));

import {
  normalizeHost,
  resolveTenantOrg,
  clearTenantResolverCache,
} from "@/lib/tenant/resolver";

const ENV_KEYS = ["TENANCY_ENFORCE_HOST", "DEFAULT_ORG_ID"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  clearTenantResolverCache();
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.useRealTimers();
});

describe("normalizeHost", () => {
  it("lowercases and strips the port", () => {
    expect(normalizeHost("Events.Example.COM:3113")).toBe("events.example.com");
  });

  it("strips a trailing dot", () => {
    expect(normalizeHost("events.example.com.")).toBe("events.example.com");
  });

  it("null / empty / whitespace → null", () => {
    expect(normalizeHost(null)).toBeNull();
    expect(normalizeHost("")).toBeNull();
    expect(normalizeHost("   ")).toBeNull();
  });

  it("garbage with separators is not a hostname", () => {
    expect(normalizeHost("evil.com/phish")).toBeNull();
    expect(normalizeHost("a b.com")).toBeNull();
    expect(normalizeHost("user@evil.com")).toBeNull();
  });
});

describe("resolveTenantOrg", () => {
  it("verified TenantDomain row → its org (source: domain)", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue({
      organizationId: "org-a",
      verifiedAt: new Date(),
    });
    const res = await resolveTenantOrg("a.example.com");
    expect(res).toEqual({ orgId: "org-a", source: "domain" });
    expect(mockDb.tenantDomain.findUnique).toHaveBeenCalledWith({
      where: { domain: "a.example.com" },
      select: { organizationId: true, verifiedAt: true },
    });
  });

  it("UNVERIFIED row never routes — falls back and warns host-unverified", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue({
      organizationId: "org-a",
      verifiedAt: null,
    });
    const res = await resolveTenantOrg("a.example.com");
    expect(res).toEqual({ orgId: null, source: "unscoped" });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "tenant:host-unverified" }),
    );
  });

  it("unknown host + DEFAULT_ORG_ID → default-env fallback with warn", async () => {
    process.env.DEFAULT_ORG_ID = "org-default";
    mockDb.tenantDomain.findUnique.mockResolvedValue(null);
    const res = await resolveTenantOrg("stranger.example.com");
    expect(res).toEqual({ orgId: "org-default", source: "default-env" });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "tenant:host-unresolved-default" }),
    );
  });

  it("unknown host, no default → unscoped (legacy behavior) with warn", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue(null);
    const res = await resolveTenantOrg("stranger.example.com");
    expect(res).toEqual({ orgId: null, source: "unscoped" });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "tenant:host-unresolved-unscoped" }),
    );
  });

  it("unknown host + TENANCY_ENFORCE_HOST=1 → unknown-enforced (enforce wins over default)", async () => {
    process.env.TENANCY_ENFORCE_HOST = "1";
    process.env.DEFAULT_ORG_ID = "org-default";
    mockDb.tenantDomain.findUnique.mockResolvedValue(null);
    const res = await resolveTenantOrg("stranger.example.com");
    expect(res).toEqual({ orgId: null, source: "unknown-enforced" });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "tenant:host-rejected" }),
    );
  });

  it("null host skips the DB entirely and takes the ramp", async () => {
    const res = await resolveTenantOrg(null);
    expect(res).toEqual({ orgId: null, source: "unscoped" });
    expect(mockDb.tenantDomain.findUnique).not.toHaveBeenCalled();
  });

  it("DB error → never throws, falls back, logs resolve-failed", async () => {
    process.env.DEFAULT_ORG_ID = "org-default";
    mockDb.tenantDomain.findUnique.mockRejectedValue(new Error("pooler blip"));
    const res = await resolveTenantOrg("a.example.com");
    expect(res).toEqual({ orgId: "org-default", source: "default-env" });
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "tenant:resolve-failed" }),
    );
  });

  it("a DB-error result is NOT cached — the next call retries the lookup", async () => {
    mockDb.tenantDomain.findUnique
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce({ organizationId: "org-a", verifiedAt: new Date() });
    await resolveTenantOrg("a.example.com");
    const res = await resolveTenantOrg("a.example.com");
    expect(res).toEqual({ orgId: "org-a", source: "domain" });
    expect(mockDb.tenantDomain.findUnique).toHaveBeenCalledTimes(2);
  });

  it("caches positive results within the TTL (1 query for 2 calls)", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue({
      organizationId: "org-a",
      verifiedAt: new Date(),
    });
    await resolveTenantOrg("a.example.com");
    await resolveTenantOrg("a.example.com");
    expect(mockDb.tenantDomain.findUnique).toHaveBeenCalledTimes(1);
  });

  it("caches NEGATIVE results too — a garbage-host flood can't become a query flood", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue(null);
    await resolveTenantOrg("stranger.example.com");
    await resolveTenantOrg("stranger.example.com");
    await resolveTenantOrg("stranger.example.com");
    expect(mockDb.tenantDomain.findUnique).toHaveBeenCalledTimes(1);
    // warn fired once, not per call (warn-once-per-cache-entry)
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });

  it("cache expires after the TTL and re-queries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T10:00:00Z"));
    mockDb.tenantDomain.findUnique.mockResolvedValue({
      organizationId: "org-a",
      verifiedAt: new Date(),
    });
    await resolveTenantOrg("a.example.com");
    vi.setSystemTime(new Date("2026-07-22T10:01:01Z")); // 61s later
    await resolveTenantOrg("a.example.com");
    expect(mockDb.tenantDomain.findUnique).toHaveBeenCalledTimes(2);
  });

  it("cache is bounded: the oldest entry is evicted past 500 hosts", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue(null);
    for (let i = 0; i < 500; i++) {
      await resolveTenantOrg(`h${i}.example.com`);
    }
    expect(mockDb.tenantDomain.findUnique).toHaveBeenCalledTimes(500);
    // h0 is still cached (500 entries fit exactly)
    await resolveTenantOrg("h0.example.com");
    expect(mockDb.tenantDomain.findUnique).toHaveBeenCalledTimes(500);
    // 501st distinct host evicts h0 …
    await resolveTenantOrg("overflow.example.com");
    expect(mockDb.tenantDomain.findUnique).toHaveBeenCalledTimes(501);
    // … so h0 now misses the cache and re-queries
    await resolveTenantOrg("h0.example.com");
    expect(mockDb.tenantDomain.findUnique).toHaveBeenCalledTimes(502);
  });
});
