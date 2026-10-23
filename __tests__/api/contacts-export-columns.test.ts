/**
 * GET /api/contacts/export with the column picker (Oct 23, 2026): the select,
 * the header row and the cells follow the chosen columns; an unknown column is
 * refused before it can spend the org's export budget; every cell is still
 * formula-guarded; the audit row records the columns.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, rateLimit, recordExport, warn, gatePrincipal } = vi.hoisted(() => ({
  mockDb: { contact: { findMany: vi.fn(), count: vi.fn() } },
  rateLimit: vi.fn(() => ({ allowed: true })),
  recordExport: vi.fn(),
  warn: vi.fn(),
  // The principal the gate hands the route; set per test (real `can()` reads it).
  gatePrincipal: { current: null as unknown },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn, error: vi.fn() } }));
vi.mock("@/lib/audit-data-transfer", () => ({ recordExport, fingerprintSearchTerm: () => "fp123" }));
vi.mock("@/lib/security", () => ({ checkRateLimit: rateLimit }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }));
vi.mock("@/lib/api-auth", () => ({
  getOrgContext: vi.fn(async () => ({ organizationId: "org1", userId: "u1", role: "ORGANIZER", fromApiKey: false })),
}));
vi.mock("@/lib/permissions/require-permission", async () => ({
  ...(await vi.importActual<object>("@/lib/permissions/require-permission")),
  principalFromCaller: () => ({}),
  requirePermission: () => ({ ok: true, principal: gatePrincipal.current }),
}));
vi.mock("@/lib/module-flags", async () => ({ ...(await vi.importActual<object>("@/lib/module-flags")), isCustomRolesEnabled: () => true }));

import { GET } from "@/app/api/contacts/export/route";
import { EXPORT_COLUMNS, SENSITIVE_EXPORT_COLUMNS } from "@/lib/contact-export";
import { principalFromUser } from "@/lib/permissions/can";
import { principalFromApiKey } from "@/lib/permissions/require-permission";

const organizer = principalFromUser({ id: "u1", role: "ORGANIZER", organizationId: "org1" });
/** The Base role with a Marketing custom role: export, but not the private columns. */
const marketing = principalFromUser({ id: "u2", role: "BASE", organizationId: "org1", procurementPermissions: ["contacts.read", "contacts.export"] });

const get = (query = "") => GET(new Request(`http://localhost/api/contacts/export${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  gatePrincipal.current = organizer;
  mockDb.contact.findMany.mockResolvedValue([
    { firstName: "Amina", email: "a@x.com", city: "=HYPERLINK(\"x\")", country: "United Arab Emirates" },
  ]);
});

describe("GET /api/contacts/export", () => {
  it("selects and writes only the chosen columns, in file order", async () => {
    const res = await get("?columns=country,city,email,firstName");
    expect(res.status).toBe(200);
    expect(Object.keys(mockDb.contact.findMany.mock.calls[0][0].select)).toEqual(["firstName", "email", "city", "country"]);
    const [header, row] = (await res.text()).split("\n");
    expect(header).toBe("firstName,email,city,country");
    // The formula guard still applies to the new columns.
    expect(row).toBe(`Amina,a@x.com,"'=HYPERLINK(""x"")",United Arab Emirates`);
    expect(recordExport.mock.calls[0][1].filters).toEqual({ columns: ["firstName", "email", "city", "country"] });
  });

  it("with no columns returns every column", async () => {
    const res = await get();
    expect((await res.text()).split("\n")[0]).toBe(EXPORT_COLUMNS.join(","));
  });

  it("refuses an unknown column with a logged 400 and does not spend the rate limit", async () => {
    const res = await get("?columns=email,password");
    expect(res.status).toBe(400);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "contacts-export:invalid-columns", unknown: ["password"] }));
    expect(rateLimit).not.toHaveBeenCalled();
    expect(mockDb.contact.findMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/contacts/export with the page's filters", () => {
  it("applies specialty, country and role and audits them, search as a fingerprint", async () => {
    const res = await get("?columns=email&specialty=Cardiology&country=India&role=PHYSICIAN&search=amina");
    expect(res.status).toBe(200);
    const where = mockDb.contact.findMany.mock.calls[0][0].where;
    expect(where.organizationId).toBe("org1");
    expect(where.AND).toEqual(expect.arrayContaining([
      { OR: [{ specialty: { equals: "Cardiology", mode: "insensitive" } }] },
      { OR: [{ country: { equals: "India", mode: "insensitive" } }] },
      { role: "PHYSICIAN" },
    ]));
    const audit = recordExport.mock.calls[0][1].filters;
    expect(audit).toMatchObject({ specialty: ["Cardiology"], country: ["India"], role: "PHYSICIAN", q: "fp123" });
    expect(JSON.stringify(audit)).not.toContain("amina");
  });

  it("refuses an unknown role with a logged 400 before the rate limit", async () => {
    const res = await get("?role=astronaut");
    expect(res.status).toBe(400);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "contacts-export:invalid-filter", field: "role" }));
    expect(rateLimit).not.toHaveBeenCalled();
  });
});

describe("GET /api/contacts/export row headers", () => {
  it("reports the row count, and the matching total when the cap cuts the file", async () => {
    const small = await get("?columns=email");
    expect(small.headers.get("X-Export-Rows")).toBe("1");
    expect(small.headers.get("X-Export-Truncated")).toBeNull();

    mockDb.contact.findMany.mockResolvedValueOnce(Array.from({ length: 25_000 }, () => ({ email: "a@x.com" })));
    mockDb.contact.count.mockResolvedValueOnce(31_400);
    const big = await get("?columns=email");
    expect(big.headers.get("X-Export-Rows")).toBe("25000");
    expect(big.headers.get("X-Export-Truncated")).toBe("25000");
    expect(big.headers.get("X-Export-Matching")).toBe("31400");
  });

  it("every refusal is JSON, so the dialog can show it", async () => {
    const res = await get("?columns=nope");
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });
});

describe("private columns need contacts.export.sensitive (D4, Oct 23, 2026)", () => {
  it("an organiser holds it: phone and notes export as before", async () => {
    const res = await get("?columns=email,phone,notes");
    expect(res.status).toBe(200);
    expect((await res.text()).split("\n")[0]).toBe("email,phone,notes");
  });

  it("Marketing naming a private column is refused with the names, logged, before the rate limit", async () => {
    gatePrincipal.current = marketing;
    const res = await get("?columns=email,phone,notes");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("phone, notes");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "contacts-export:sensitive-columns-refused" }));
    expect(rateLimit).not.toHaveBeenCalled();
    expect(mockDb.contact.findMany).not.toHaveBeenCalled();
  });

  it("Marketing with no column list gets every column except the private ones", async () => {
    gatePrincipal.current = marketing;
    const res = await get();
    expect(res.status).toBe(200);
    const header = (await res.text()).split("\n")[0].split(",");
    expect(header).toEqual(EXPORT_COLUMNS.filter((c) => !SENSITIVE_EXPORT_COLUMNS.includes(c)));
    expect(Object.keys(mockDb.contact.findMany.mock.calls[0][0].select)).not.toContain("notes");
  });

  it("Marketing's basic columns export normally", async () => {
    gatePrincipal.current = marketing;
    const res = await get("?columns=firstName,email,country");
    expect(res.status).toBe(200);
  });
});

describe("API keys and the private columns", () => {
  it("a full API key keeps them", async () => {
    gatePrincipal.current = principalFromApiKey("org1");
    const res = await get("?columns=email,phone");
    expect(res.status).toBe(200);
  });

  it("a key bound to a role without the key gets the ordinary columns only", async () => {
    gatePrincipal.current = principalFromApiKey("org1", [{ permission: "contacts.export" }]);
    expect((await get("?columns=email,phone")).status).toBe(403);
    const res = await get();
    expect((await res.text()).split("\n")[0].split(",")).not.toContain("phone");
  });
});

describe("GET /api/contacts/export with several countries", () => {
  it("matches any of the chosen countries", async () => {
    await get("?columns=email&country=UAE&country=United%20Arab%20Emirates");
    const where = mockDb.contact.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([
      {
        OR: [
          { country: { equals: "UAE", mode: "insensitive" } },
          { country: { equals: "United Arab Emirates", mode: "insensitive" } },
        ],
      },
    ]);
  });
});

describe("the export budget is per person (owner, Oct 23, 2026)", () => {
  it("keys the rate limit on the person, not the whole organisation", async () => {
    await get("?columns=email");
    expect(rateLimit).toHaveBeenCalledWith(expect.objectContaining({ key: "contacts-export:org1:u1", limit: 10 }));
  });
});
