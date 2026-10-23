/**
 * Contacts CSV import reads every column the export writes (Oct 23, 2026).
 * It read only twelve, so city, country and nine other fields in a file were
 * dropped while the import reported success.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    contact: {
      count: vi.fn(),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  },
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/audit-data-transfer", () => ({ recordImport: vi.fn() }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true }) }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }));
vi.mock("@/lib/api-auth", () => ({
  getOrgContext: vi.fn(async () => ({ organizationId: "org1", userId: "u1", role: "ORGANIZER", fromApiKey: false })),
}));
vi.mock("@/lib/permissions/require-permission", () => ({
  principalFromCaller: () => ({}),
  requirePermission: () => ({ ok: true }),
}));

import { POST } from "@/app/api/contacts/import/route";

function upload(csv: string) {
  const form = new FormData();
  form.set("file", new File([csv], "contacts.csv", { type: "text/csv" }));
  return new Request("http://localhost/api/contacts/import", { method: "POST", body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.contact.count.mockResolvedValueOnce(10).mockResolvedValueOnce(11);
});

describe("POST /api/contacts/import columns", () => {
  it("carries city, country and the other newer fields", async () => {
    const csv = [
      "firstName,lastName,email,additionalEmail,city,state,zipCode,country,associationName,memberId,studentId,studentIdExpiry,customSpecialty,registrationType",
      "Amina,Khan,a@x.com,Alt@X.com,Dubai,Dubai,00000,United Arab Emirates,ESC,M-1,S-2,2027-06-30,Echo,Physician",
    ].join("\n");
    const res = await POST(upload(csv));
    expect(res.status).toBe(200);
    const row = mockDb.contact.createMany.mock.calls[0][0].data[0];
    expect(row).toMatchObject({
      additionalEmail: "alt@x.com",
      city: "Dubai",
      state: "Dubai",
      zipCode: "00000",
      country: "United Arab Emirates",
      associationName: "ESC",
      memberId: "M-1",
      studentId: "S-2",
      customSpecialty: "Echo",
      registrationType: "Physician",
    });
    expect(row.studentIdExpiry.toISOString().slice(0, 10)).toBe("2027-06-30");
  });

  it("imports an exported file back (export header names)", async () => {
    const csv = [
      "title,firstName,lastName,email,country,tags,createdAt",
      'DR,Sam,Lee,s@x.com,India,"vip,faculty",2026-09-29',
    ].join("\n");
    await POST(upload(csv));
    const row = mockDb.contact.createMany.mock.calls[0][0].data[0];
    expect(row).toMatchObject({ title: "DR", country: "India", tags: ["vip", "faculty"] });
    expect(row).not.toHaveProperty("createdAt");
  });

  it("leaves an unreadable expiry and a bad second email empty, and says so", async () => {
    const csv = ["firstName,lastName,email,additionalEmail,studentIdExpiry", "A,B,a@x.com,not-an-email,31/12/2027"].join("\n");
    const res = await POST(upload(csv));
    const body = await res.json();
    const row = mockDb.contact.createMany.mock.calls[0][0].data[0];
    expect(row.studentIdExpiry).toBeNull();
    expect(row).not.toHaveProperty("additionalEmail");
    expect(body.errors.join(" ")).toMatch(/expiry.*YYYY-MM-DD/);
    expect(body.errors.join(" ")).toMatch(/additional email/);
  });

  it("an empty cell writes nothing for that column", async () => {
    await POST(upload(["firstName,lastName,email,city,country", "A,B,a@x.com,,"].join("\n")));
    const row = mockDb.contact.createMany.mock.calls[0][0].data[0];
    expect(row).not.toHaveProperty("city");
    expect(row).not.toHaveProperty("country");
  });
});

describe("POST /api/contacts/import limits and round trip", () => {
  it("leaves a value over the form's cap empty and reports it", async () => {
    const csv = ["firstName,lastName,email,city,memberId,country", `A,B,a@x.com,${"x".repeat(256)},${"m".repeat(101)},India`].join("\n");
    const body = await (await POST(upload(csv))).json();
    const row = mockDb.contact.createMany.mock.calls[0][0].data[0];
    expect(row).not.toHaveProperty("city");
    expect(row).not.toHaveProperty("memberId");
    expect(row.country).toBe("India");
    expect(body.errors.join(" ")).toMatch(/2 value\(s\) were longer/);
  });

  it("fails a row whose name is over 100 characters", async () => {
    const csv = ["firstName,lastName,email", `${"n".repeat(101)},B,a@x.com`].join("\n");
    const body = await (await POST(upload(csv))).json();
    expect(mockDb.contact.createMany).not.toHaveBeenCalled();
    expect(body.errors[0]).toMatch(/Row 2: name over 100/);
  });

  it("strips the export's formula guard on the way back in", async () => {
    const csv = ["firstName,lastName,email,memberId,notes", "A,B,a@x.com,'-A123,'=SUM(1)"].join("\n");
    await POST(upload(csv));
    const row = mockDb.contact.createMany.mock.calls[0][0].data[0];
    expect(row.memberId).toBe("-A123");
    expect(row.notes).toBe("=SUM(1)");
  });
});
