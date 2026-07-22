/**
 * publicEventWhere / publicEventWhereForHost — the tenant-scoped where builder
 * behind the Phase-0 slug cut.
 *
 * THE LOAD-BEARING TESTS HERE ARE THE EQUIVALENCE ONES: while resolution is
 * "unscoped" (master today — no TenantDomain row, no DEFAULT_ORG_ID), the
 * builder's output must deep-equal the exact legacy hand-rolled where shapes,
 * per shape. That equivalence is the behavior-preservation proof for the whole
 * ~21-file sweep: swapping `where:` for this builder changes nothing until an
 * operator seeds a domain row / env var.
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

import { clearTenantResolverCache } from "@/lib/tenant/resolver";
import {
  publicEventWhere,
  publicEventWhereForHost,
  UNRESOLVED_TENANT_SENTINEL,
} from "@/lib/public-event";

const ENV_KEYS = ["TENANCY_ENFORCE_HOST", "DEFAULT_ORG_ID"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  clearTenantResolverCache();
  mockDb.tenantDomain.findUnique.mockResolvedValue(null); // default: unknown host
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
});

describe("unscoped equivalence — the sweep's behavior-preservation proof", () => {
  it("Shape A: allowIdFallback + statuses deep-equals the legacy where", async () => {
    const where = await publicEventWhereForHost("events.example.com", "acabc-2026", {
      allowIdFallback: true,
      statuses: ["PUBLISHED", "LIVE"],
    });
    // Legacy: { OR: [{ slug }, { id: slug }], status: { in: ["PUBLISHED", "LIVE"] } }
    expect(where).toEqual({
      OR: [{ slug: "acabc-2026" }, { id: "acabc-2026" }],
      status: { in: ["PUBLISHED", "LIVE"] },
    });
    expect(where).not.toHaveProperty("organizationId");
  });

  it("Shape B: slug + statuses deep-equals the legacy where", async () => {
    const where = await publicEventWhereForHost("events.example.com", "acabc-2026", {
      statuses: ["PUBLISHED"],
    });
    expect(where).toEqual({ slug: "acabc-2026", status: { in: ["PUBLISHED"] } });
  });

  it("bare slug (no options) deep-equals the minimal legacy where", async () => {
    const where = await publicEventWhereForHost("events.example.com", "acabc-2026");
    expect(where).toEqual({ slug: "acabc-2026" });
  });

  it("null host (absent header) is also plain unscoped", async () => {
    const where = await publicEventWhereForHost(null, "acabc-2026", {
      statuses: ["PUBLISHED", "LIVE"],
    });
    expect(where).toEqual({ slug: "acabc-2026", status: { in: ["PUBLISHED", "LIVE"] } });
  });
});

describe("resolved tenant — org bind lands in the where", () => {
  beforeEach(() => {
    mockDb.tenantDomain.findUnique.mockResolvedValue({
      organizationId: "org-a",
      verifiedAt: new Date(),
    });
  });

  it("binds organizationId alongside the slug", async () => {
    const where = await publicEventWhereForHost("a.example.com", "shared-slug");
    expect(where).toEqual({ organizationId: "org-a", slug: "shared-slug" });
  });

  it("binds organizationId with the id-fallback OR + statuses", async () => {
    const where = await publicEventWhereForHost("a.example.com", "shared-slug", {
      allowIdFallback: true,
      statuses: ["PUBLISHED", "LIVE"],
    });
    expect(where).toEqual({
      organizationId: "org-a",
      OR: [{ slug: "shared-slug" }, { id: "shared-slug" }],
      status: { in: ["PUBLISHED", "LIVE"] },
    });
  });
});

describe("DEFAULT_ORG_ID fallback", () => {
  it("unknown host binds the default org", async () => {
    process.env.DEFAULT_ORG_ID = "org-mmg";
    const where = await publicEventWhereForHost("unknown.example.com", "acabc-2026");
    expect(where).toEqual({ organizationId: "org-mmg", slug: "acabc-2026" });
  });
});

describe("TENANCY_ENFORCE_HOST=1 — 404 semantics with no route branching", () => {
  it("unknown host yields the impossible-sentinel org bind", async () => {
    process.env.TENANCY_ENFORCE_HOST = "1";
    const where = await publicEventWhereForHost("unknown.example.com", "acabc-2026", {
      statuses: ["PUBLISHED"],
    });
    expect(where).toEqual({
      organizationId: UNRESOLVED_TENANT_SENTINEL,
      slug: "acabc-2026",
      status: { in: ["PUBLISHED"] },
    });
  });

  it("a KNOWN host still resolves normally under enforcement", async () => {
    process.env.TENANCY_ENFORCE_HOST = "1";
    mockDb.tenantDomain.findUnique.mockResolvedValue({
      organizationId: "org-a",
      verifiedAt: new Date(),
    });
    const where = await publicEventWhereForHost("a.example.com", "acabc-2026");
    expect(where).toEqual({ organizationId: "org-a", slug: "acabc-2026" });
  });
});

describe("publicEventWhere (Request entry point)", () => {
  it("reads the Host header off the request", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue({
      organizationId: "org-a",
      verifiedAt: new Date(),
    });
    const req = new Request("http://ignored.example/api/x", {
      headers: { host: "A.Example.com:3113" }, // normalization applies
    });
    const where = await publicEventWhere(req, "acabc-2026");
    expect(mockDb.tenantDomain.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { domain: "a.example.com" } }),
    );
    expect(where).toEqual({ organizationId: "org-a", slug: "acabc-2026" });
  });
});
