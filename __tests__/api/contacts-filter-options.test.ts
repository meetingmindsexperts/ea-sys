/**
 * GET /api/contacts/filter-options (Oct 23, 2026): each picker's counts follow
 * the OTHER filters, case variants merge, blanks become notSet, and the list
 * route refuses an unknown role like the export does.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, warn } = vi.hoisted(() => ({
  mockDb: { contact: { groupBy: vi.fn(), count: vi.fn(), findMany: vi.fn() } },
  warn: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b, headers: new Headers() }),
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn, error: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }));
vi.mock("@/lib/api-auth", () => ({
  getOrgContext: vi.fn(async () => ({ organizationId: "org1", userId: "u1", role: "ORGANIZER", fromApiKey: false })),
}));
vi.mock("@/lib/permissions/require-permission", () => ({
  principalFromCaller: () => ({}),
  requirePermission: () => ({ ok: true }),
}));

import { GET } from "@/app/api/contacts/filter-options/route";
import { GET as listGET } from "@/app/api/contacts/route";

type GroupArgs = { by: string[]; where: { AND?: unknown[] } };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.contact.count.mockResolvedValue(500);
  mockDb.contact.groupBy.mockImplementation(async ({ by }: GroupArgs) => {
    const col = by[0];
    if (col === "country") return [
      { country: "India", _count: { _all: 40 } },
      { country: "INDIA", _count: { _all: 2 } },
      { country: null, _count: { _all: 5 } },
    ];
    if (col === "specialty") return [{ specialty: "Cardiology", _count: { _all: 12 } }];
    return [{ role: "PHYSICIAN", _count: { _all: 3 } }, { role: null, _count: { _all: 39 } }];
  });
});

describe("GET /api/contacts/filter-options", () => {
  it("groups case variants, counts blanks and reports the whole book", async () => {
    const res = await GET(new Request("http://localhost/api/contacts/filter-options"));
    const body = await res.json();
    expect(body.total).toBe(500);
    expect(body.countries).toEqual([{ value: "India", count: 42 }]);
    expect(body.countryNotSet).toBe(5);
    expect(body.roles).toEqual([{ value: "PHYSICIAN", count: 3 }]);
    expect(body.roleNotSet).toBe(39);
  });

  it("counts each picker under the other filters but not its own", async () => {
    await GET(new Request("http://localhost/api/contacts/filter-options?country=India&specialty=Cardiology"));
    const whereFor = (col: string) =>
      (mockDb.contact.groupBy.mock.calls.find(([a]) => (a as GroupArgs).by[0] === col)![0] as GroupArgs).where;
    expect(JSON.stringify(whereFor("specialty"))).toContain("India");
    expect(JSON.stringify(whereFor("specialty"))).not.toContain("Cardiology");
    expect(JSON.stringify(whereFor("country"))).toContain("Cardiology");
    expect(JSON.stringify(whereFor("country"))).not.toContain("India");
    expect(JSON.stringify(whereFor("role"))).toContain("India");
  });

  it("refuses an unknown role with a logged 400", async () => {
    const res = await GET(new Request("http://localhost/api/contacts/filter-options?role=astronaut"));
    expect(res.status).toBe(400);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "contacts/filter-options:invalid-filter" }));
  });
});

describe("GET /api/contacts with a bad role", () => {
  it("refuses it with a logged 400 instead of returning the whole book", async () => {
    const res = await listGET(new Request("http://localhost/api/contacts?role=astronaut"));
    expect(res.status).toBe(400);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "contacts:invalid-filter", field: "role" }));
    expect(mockDb.contact.findMany).not.toHaveBeenCalled();
  });
});
