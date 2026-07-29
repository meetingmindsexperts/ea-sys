/**
 * CRM companies (accounts) — the tag filter + the distinct-tags endpoint that
 * feeds it. Mirrors the contacts tag filter: `?tags=a,b` → a hasSome (any-of)
 * where, omitted when absent; GET /companies/tags returns the org's tags deduped
 * + sorted (exact stored strings, so the Select value matches on hasSome).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: { crmCompany: { findMany: vi.fn() } },
}));

vi.mock("@/crm/lib/crm-route", () => ({
  requireCrmRead: vi.fn(async () => ({
    ctx: { organizationId: "org-1", userId: "u-1", role: "ADMIN", fromApiKey: false },
  })),
  // Passthrough — the list maps rows through this for MEMBER money redaction.
  redactForCaller: (x: unknown) => x,
}));

import { db } from "@/lib/db";
import { GET as listCompanies } from "@/app/api/crm/companies/route";
import { GET as listTags } from "@/app/api/crm/companies/tags/route";

beforeEach(() => vi.clearAllMocks());

const whereOf = () => vi.mocked(db.crmCompany.findMany).mock.calls[0]![0]!.where as Record<string, unknown>;

describe("GET /api/crm/companies — tag filter", () => {
  it("turns ?tags=a,b into a hasSome any-of predicate", async () => {
    vi.mocked(db.crmCompany.findMany).mockResolvedValue([] as never);
    await listCompanies(new Request("http://x/api/crm/companies?tags=key-account,multi-year"));
    expect(whereOf().tags).toEqual({ hasSome: ["key-account", "multi-year"] });
  });

  it("trims + drops blanks", async () => {
    vi.mocked(db.crmCompany.findMany).mockResolvedValue([] as never);
    await listCompanies(new Request("http://x/api/crm/companies?tags=%20key-account%20,,"));
    expect(whereOf().tags).toEqual({ hasSome: ["key-account"] });
  });

  it("omits the tags predicate when none is passed", async () => {
    vi.mocked(db.crmCompany.findMany).mockResolvedValue([] as never);
    await listCompanies(new Request("http://x/api/crm/companies"));
    expect(whereOf().tags).toBeUndefined();
  });
});

describe("GET /api/crm/companies/tags — distinct tags", () => {
  it("returns the org's tags deduped + sorted", async () => {
    vi.mocked(db.crmCompany.findMany).mockResolvedValue([
      { tags: ["multi-year", "key-account"] },
      { tags: ["key-account", "agency"] },
      { tags: [] },
    ] as never);
    const res = await listTags(new Request("http://x/api/crm/companies/tags"));
    expect(await res.json()).toEqual({ tags: ["agency", "key-account", "multi-year"] });
  });

  it("scopes to the org's non-archived companies", async () => {
    vi.mocked(db.crmCompany.findMany).mockResolvedValue([] as never);
    await listTags(new Request("http://x/api/crm/companies/tags"));
    expect(whereOf()).toEqual({ organizationId: "org-1", archivedAt: null });
  });
});
