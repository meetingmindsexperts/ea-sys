/**
 * Tenant resolver against the REAL harness DB (TenantDomain rows seeded for
 * two tenants). Complements the mocked unit suite: this proves the actual
 * Prisma lookup + ramp against actual rows. TenantDomain carries no RLS, so
 * the app_user connection reads it directly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { resolveTenantOrg, clearTenantResolverCache } from "@/lib/tenant/resolver";
import { publicEventWhereForHost } from "@/lib/public-event";
import { ORG_A_ID, ORG_B_ID, HOST_A, HOST_B, SHARED_SLUG } from "./constants";

const ENV_KEYS = ["TENANCY_ENFORCE_HOST", "DEFAULT_ORG_ID"] as const;

beforeEach(() => {
  clearTenantResolverCache();
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("resolver against real TenantDomain rows", () => {
  it("resolves each tenant's host to its own org", async () => {
    expect(await resolveTenantOrg(HOST_A)).toEqual({ orgId: ORG_A_ID, source: "domain" });
    expect(await resolveTenantOrg(HOST_B)).toEqual({ orgId: ORG_B_ID, source: "domain" });
  });

  it("unknown host + DEFAULT_ORG_ID → default-env fallback", async () => {
    process.env.DEFAULT_ORG_ID = ORG_A_ID;
    expect(await resolveTenantOrg("stranger.tenancy.test")).toEqual({
      orgId: ORG_A_ID,
      source: "default-env",
    });
  });

  it("unknown host, no default → unscoped, and the builder emits the legacy where", async () => {
    expect(await resolveTenantOrg("stranger.tenancy.test")).toEqual({
      orgId: null,
      source: "unscoped",
    });
    clearTenantResolverCache();
    const where = await publicEventWhereForHost("stranger.tenancy.test", SHARED_SLUG, {
      statuses: ["PUBLISHED", "LIVE"],
    });
    expect(where).toEqual({ slug: SHARED_SLUG, status: { in: ["PUBLISHED", "LIVE"] } });
  });

  it("TENANCY_ENFORCE_HOST=1: unknown host yields a where that misses every real event", async () => {
    process.env.TENANCY_ENFORCE_HOST = "1";
    const where = await publicEventWhereForHost("stranger.tenancy.test", SHARED_SLUG);
    // Query as the OWNER (bypasses the pilot RLS) so the miss is provably the
    // sentinel's doing, not the policy's.
    const owner = new PrismaClient({ datasourceUrl: process.env.TENANCY_DIRECT_URL });
    try {
      const hit = await owner.event.findFirst({ where, select: { id: true } });
      expect(hit).toBeNull();
    } finally {
      await owner.$disconnect();
    }
  });
});
