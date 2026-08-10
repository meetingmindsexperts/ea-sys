/**
 * The list routes report the TRUE total, not just the capped page.
 *
 * `listMeta` is unit-tested next door; what this pins is that the routes
 * actually CALL it, and that the count runs against the SAME `where` as the
 * page. A count against a different predicate would be worse than no count —
 * the banner would confidently state a wrong number.
 *
 * This also covers the shape the UI reads: `{ deals|contacts|companies, total,
 * truncated }`. The banner is driven off `truncated`, so a route that quietly
 * stopped returning it would make the board silently lie again.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: {
    crmDeal: { findMany: vi.fn(), count: vi.fn() },
    crmContact: { findMany: vi.fn(), count: vi.fn() },
    crmCompany: { findMany: vi.fn(), count: vi.fn() },
  },
}));

vi.mock("@/crm/lib/crm-route", () => ({
  requireCrmRead: vi.fn(async () => ({
    ctx: { organizationId: "org-1", userId: "u-1", role: "ADMIN", fromApiKey: false },
  })),
  redactForCaller: (x: unknown) => x,
  crmErrorResponse: vi.fn(),
}));

import { db } from "@/lib/db";
import { GET as listDeals } from "@/app/api/crm/deals/route";
import { GET as listContacts } from "@/app/api/crm/contacts/route";
import { GET as listCompanies } from "@/app/api/crm/companies/route";
import { CRM_DEALS_LIST_CAP } from "@/crm/lib/list-caps";

beforeEach(() => vi.clearAllMocks());

/** A capped page: `take` rows back, but many more match. */
function seed(model: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> }, returned: number, total: number) {
  model.findMany.mockResolvedValue(
    Array.from({ length: returned }, (_, i) => ({ id: `r-${i}`, deals: [], contacts: [], tags: [] })) as never,
  );
  model.count.mockResolvedValue(total as never);
}

describe("GET /api/crm/deals", () => {
  it("returns the true total and flags truncation", async () => {
    seed(vi.mocked(db.crmDeal), 3, 10_412);
    const res = await listDeals(new Request("http://x/api/crm/deals"));
    await expect(res.json()).resolves.toMatchObject({ total: 10_412, truncated: true });
  });

  it("does not flag a board that fits", async () => {
    seed(vi.mocked(db.crmDeal), 3, 3);
    const res = await listDeals(new Request("http://x/api/crm/deals"));
    await expect(res.json()).resolves.toMatchObject({ total: 3, truncated: false });
  });

  it("counts against the SAME where as the page — a divergent count would state a wrong number", async () => {
    seed(vi.mocked(db.crmDeal), 1, 5);
    await listDeals(new Request("http://x/api/crm/deals?status=OPEN"));

    const pageWhere = vi.mocked(db.crmDeal.findMany).mock.calls[0]![0]!.where;
    const countWhere = vi.mocked(db.crmDeal.count).mock.calls[0]![0]!.where;
    expect(countWhere).toBe(pageWhere); // identical object, not merely equal
  });

  it("applies the shared cap rather than a hand-written literal", async () => {
    seed(vi.mocked(db.crmDeal), 1, 1);
    await listDeals(new Request("http://x/api/crm/deals"));
    expect(vi.mocked(db.crmDeal.findMany).mock.calls[0]![0]!.take).toBe(CRM_DEALS_LIST_CAP);
  });
});

describe("GET /api/crm/contacts", () => {
  it("returns the true total and flags truncation", async () => {
    seed(vi.mocked(db.crmContact), 2, 4_400);
    const res = await listContacts(new Request("http://x/api/crm/contacts"));
    await expect(res.json()).resolves.toMatchObject({ total: 4_400, truncated: true });
  });

  it("counts against the same where", async () => {
    seed(vi.mocked(db.crmContact), 1, 1);
    await listContacts(new Request("http://x/api/crm/contacts?q=abbott"));
    expect(vi.mocked(db.crmContact.count).mock.calls[0]![0]!.where).toBe(
      vi.mocked(db.crmContact.findMany).mock.calls[0]![0]!.where,
    );
  });
});

describe("GET /api/crm/companies", () => {
  it("returns the true total and flags truncation", async () => {
    seed(vi.mocked(db.crmCompany), 2, 1_500);
    const res = await listCompanies(new Request("http://x/api/crm/companies"));
    await expect(res.json()).resolves.toMatchObject({ total: 1_500, truncated: true });
  });

  it("counts against the same where", async () => {
    seed(vi.mocked(db.crmCompany), 1, 1);
    await listCompanies(new Request("http://x/api/crm/companies?q=abbott"));
    expect(vi.mocked(db.crmCompany.count).mock.calls[0]![0]!.where).toBe(
      vi.mocked(db.crmCompany.findMany).mock.calls[0]![0]!.where,
    );
  });
});
