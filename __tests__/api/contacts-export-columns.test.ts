/**
 * GET /api/contacts/export with the column picker (Oct 23, 2026): the select,
 * the header row and the cells follow the chosen columns; an unknown column is
 * refused before it can spend the org's export budget; every cell is still
 * formula-guarded; the audit row records the columns.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, rateLimit, recordExport, warn } = vi.hoisted(() => ({
  mockDb: { contact: { findMany: vi.fn() } },
  rateLimit: vi.fn(() => ({ allowed: true })),
  recordExport: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn, error: vi.fn() } }));
vi.mock("@/lib/audit-data-transfer", () => ({ recordExport }));
vi.mock("@/lib/security", () => ({ checkRateLimit: rateLimit }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }));
vi.mock("@/lib/api-auth", () => ({
  getOrgContext: vi.fn(async () => ({ organizationId: "org1", userId: "u1", role: "ORGANIZER", fromApiKey: false })),
}));
vi.mock("@/lib/permissions/require-permission", () => ({
  principalFromCaller: () => ({}),
  requirePermission: () => ({ ok: true }),
}));

import { GET } from "@/app/api/contacts/export/route";
import { EXPORT_COLUMNS } from "@/lib/contact-export";

const get = (query = "") => GET(new Request(`http://localhost/api/contacts/export${query}`));

beforeEach(() => {
  vi.clearAllMocks();
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
