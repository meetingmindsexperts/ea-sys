/**
 * ?paged=1 on the contacts and accounts list routes (Oct 29, 2026): the
 * server sorts, sends 100 rows plus a cursor, and refuses a cursor that does
 * not belong to the sort. Without paged=1 the capped list the pickers use is
 * unchanged (crm-list-truncation-routes.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: {
    crmContact: { findMany: vi.fn(), count: vi.fn() },
    crmCompany: { findMany: vi.fn(), count: vi.fn() },
  },
}));

vi.mock("@/crm/lib/crm-route", async () => ({
  crmCan: (await vi.importActual<typeof import("@/crm/lib/crm-visibility")>("@/crm/lib/crm-visibility")).crmCan,
  requireCrmRead: vi.fn(async () => ({
    ctx: { organizationId: "org-1", userId: "u-1", role: "ADMIN", fromApiKey: false },
  })),
  redactForCaller: (x: unknown) => x,
  crmErrorResponse: vi.fn(),
}));

import { db } from "@/lib/db";
import { GET as listContacts } from "@/app/api/crm/contacts/route";
import { GET as listCompanies } from "@/app/api/crm/companies/route";
import { CRM_LIST_PAGE_SIZE, decodeListCursor, encodeListCursor } from "@/crm/lib/crm-list-paging";

beforeEach(() => vi.clearAllMocks());

const contact = (i: number, over: Record<string, unknown> = {}) => ({
  id: `c-${String(i).padStart(4, "0")}`,
  firstName: "Ana",
  lastName: `Last${String(i).padStart(4, "0")}`,
  score: 0,
  deals: [{ deal: { status: "OPEN", archivedAt: null } }],
  tags: [],
  ...over,
});

const findArgs = () => vi.mocked(db.crmContact.findMany).mock.calls[0]![0]!;

describe("GET /api/crm/contacts?paged=1", () => {
  it("first page: 100 rows sorted by name on the server, the total, and a keyset cursor", async () => {
    vi.mocked(db.crmContact.findMany).mockResolvedValue(Array.from({ length: CRM_LIST_PAGE_SIZE + 1 }, (_, i) => contact(i)) as never);
    vi.mocked(db.crmContact.count).mockResolvedValue(3340 as never);

    const res = await listContacts(new Request("http://x/api/crm/contacts?paged=1"));
    const body = await res.json();

    expect(body.contacts).toHaveLength(CRM_LIST_PAGE_SIZE);
    expect(body.total).toBe(3340);
    expect(findArgs()).toMatchObject({
      take: CRM_LIST_PAGE_SIZE + 1,
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
    });
    // The last row SHOWN (index 99), never the look-ahead row.
    expect(decodeListCursor(body.nextCursor, "name", "asc")).toMatchObject({ m: "k", v: ["Last0099", "Ana", "c-0099"] });
    // The row shows the LIVE score (one open deal = 30), not the stored copy (0).
    expect(body.contacts[0].score).toBe(30);
  });

  it("a later page continues after the cursor and skips the count", async () => {
    vi.mocked(db.crmContact.findMany).mockResolvedValue([contact(1)] as never);
    const cursor = encodeListCursor({ m: "k", s: "score", d: "desc", v: [40, "Doe", "Jane", "c-9"] });

    const res = await listContacts(new Request(`http://x/api/crm/contacts?paged=1&sort=score&dir=desc&cursor=${cursor}`));
    const body = await res.json();

    expect(body).toMatchObject({ total: null, nextCursor: null });
    expect(db.crmContact.count).not.toHaveBeenCalled();
    const where = findArgs().where as { AND: unknown[] };
    expect(where.AND[1]).toEqual({
      OR: [
        { score: { lt: 40 } },
        { score: 40, lastName: { lt: "Doe" } },
        { score: 40, lastName: "Doe", firstName: { lt: "Jane" } },
        { score: 40, lastName: "Doe", firstName: "Jane", id: { lt: "c-9" } },
      ],
    });
  });

  it("the deals sort pages by offset, ordered on the relation count", async () => {
    vi.mocked(db.crmContact.findMany).mockResolvedValue(Array.from({ length: CRM_LIST_PAGE_SIZE + 1 }, (_, i) => contact(i)) as never);
    const cursor = encodeListCursor({ m: "o", s: "deals", d: "desc", o: 100 });

    const res = await listContacts(new Request(`http://x/api/crm/contacts?paged=1&sort=deals&dir=desc&cursor=${cursor}`));
    const body = await res.json();

    expect(findArgs()).toMatchObject({ skip: 100, orderBy: [{ deals: { _count: "desc" } }, { lastName: "asc" }, { firstName: "asc" }, { id: "asc" }] });
    expect(decodeListCursor(body.nextCursor, "deals", "desc")).toEqual({ m: "o", s: "deals", d: "desc", o: 200 });
  });

  it("refuses a cursor from another sort with 400, logged", async () => {
    const cursor = encodeListCursor({ m: "k", s: "name", d: "asc", v: ["a", "b", "c"] });
    const res = await listContacts(new Request(`http://x/api/crm/contacts?paged=1&sort=score&cursor=${cursor}`));
    expect(res.status).toBe(400);
    expect(db.crmContact.findMany).not.toHaveBeenCalled();
  });

  it("an unknown sort falls back to name", async () => {
    vi.mocked(db.crmContact.findMany).mockResolvedValue([] as never);
    vi.mocked(db.crmContact.count).mockResolvedValue(0 as never);
    await listContacts(new Request("http://x/api/crm/contacts?paged=1&sort=email"));
    expect(findArgs().orderBy).toEqual([{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }]);
  });
});

describe("GET /api/crm/companies?paged=1", () => {
  const company = (i: number) => ({ id: `co-${i}`, name: `Acct ${String(i).padStart(4, "0")}`, deals: [], contacts: [], tags: [] });

  it("name sort pages by keyset on (name, id)", async () => {
    vi.mocked(db.crmCompany.findMany).mockResolvedValue(Array.from({ length: CRM_LIST_PAGE_SIZE + 1 }, (_, i) => company(i)) as never);
    vi.mocked(db.crmCompany.count).mockResolvedValue(529 as never);

    const res = await listCompanies(new Request("http://x/api/crm/companies?paged=1"));
    const body = await res.json();

    expect(body.companies).toHaveLength(CRM_LIST_PAGE_SIZE);
    expect(body.total).toBe(529);
    expect(vi.mocked(db.crmCompany.findMany).mock.calls[0]![0]!.orderBy).toEqual([{ name: "asc" }, { id: "asc" }]);
    expect(decodeListCursor(body.nextCursor, "name", "asc")).toMatchObject({ v: ["Acct 0099", "co-99"] });
  });

  it("the contacts count sort pages by offset", async () => {
    vi.mocked(db.crmCompany.findMany).mockResolvedValue([company(1)] as never);
    vi.mocked(db.crmCompany.count).mockResolvedValue(1 as never);
    await listCompanies(new Request("http://x/api/crm/companies?paged=1&sort=contacts&dir=desc"));
    expect(vi.mocked(db.crmCompany.findMany).mock.calls[0]![0]!.orderBy).toEqual([
      { contacts: { _count: "desc" } },
      { name: "asc" },
      { id: "asc" },
    ]);
  });
});
