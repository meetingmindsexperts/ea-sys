/**
 * The "Base role" with a Marketing custom role (docs/BASE_ROLE_PLAN.md) may
 * export registrations, and the file leaves money and barcodes blank: the role
 * holds neither finance.view nor barcode.view, so the redaction an organiser
 * never sees applies. A plain Base role person is refused the export.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockOrgCtx, mockAuth } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findMany: vi.fn(), findFirst: vi.fn() },
    surveyResponse: { findMany: vi.fn().mockResolvedValue([]) },
    survey: { findFirst: vi.fn() },
    // Every export is audited (audit-data-transfer.ts).
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  mockOrgCtx: vi.fn(),
  mockAuth: vi.fn(),
}));

vi.mock("@/lib/sponsors", () => ({
  getSponsors: vi.fn(async () => []),
  getSponsorNameMap: vi.fn(async () => new Map()),
  sponsorExistsOnEvent: vi.fn(async () => false),
}));
vi.mock("next/server", () => {
  class NextResponse {
    status: number;
    body: string;
    headers = { set: () => {} };
    constructor(body: string, init?: { status?: number }) {
      this.body = body;
      this.status = init?.status ?? 200;
    }
    async text() {
      return this.body;
    }
    static json(b: unknown, i?: { status?: number }) {
      return { status: i?.status ?? 200, json: async () => b, headers: { set: () => {} } };
    }
  }
  return { NextResponse };
});
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api-auth", () => ({ getOrgContext: () => mockOrgCtx() }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4", checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }) }));
// The real schemas: the export row formats titles and roles through them.
vi.mock("@/lib/module-flags", async () => ({ ...(await vi.importActual<object>("@/lib/module-flags")), isCustomRolesEnabled: () => true }));

import { GET } from "@/app/api/events/[eventId]/registrations/route";

const MARKETING = ["events.read@ALL", "registrations.read@ALL", "registrations.export@ALL", "contacts.read", "contacts.export"];
const REG = {
  id: "r1",
  status: "CONFIRMED",
  paymentStatus: "PAID",
  originalPrice: 500,
  discountAmount: 0,
  qrCode: "ENTRY-SECRET",
  dtcmBarcode: "DTCM-SECRET",
  attendee: { firstName: "Asha", lastName: "Rao", email: "asha@example.com", phone: "+971501234567", country: "Oman", organization: "Clinic" },
  ticketType: { name: "Delegate", currency: "USD", price: 500 },
  payments: [{ status: "PAID", amount: 500 }],
};
const params = { params: Promise.resolve({ eventId: "ev1" }) };
const exportReq = () => new Request("http://localhost/x?export=csv");

function asBase(keys: string[]) {
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "BASE", organizationId: "org1", procurementPermissions: keys } });
  mockOrgCtx.mockResolvedValue({ organizationId: "org1", role: "BASE", userId: "u1" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", name: "Summit", taxRate: 5, taxLabel: "VAT", settings: {}, timezone: "Asia/Dubai" });
  mockDb.registration.findMany.mockResolvedValue([{ ...REG, payments: REG.payments.map((p) => ({ ...p })) }]);
});

describe("Base role + Marketing: registrations export", () => {
  it("downloads, with no money and no barcodes in the file", async () => {
    asBase(MARKETING);
    const res = (await GET(exportReq(), params)) as unknown as { status: number; text: () => Promise<string> };
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).toContain("Asha");
    expect(csv).toContain("asha@example.com");
    expect(csv).not.toContain("ENTRY-SECRET");
    expect(csv).not.toContain("DTCM-SECRET");
    expect(csv).not.toMatch(/\b500(\.00)?\b/);
    // The phone is a private detail in files (D4): blank without the key.
    expect(csv).not.toContain("+971501234567");
  });

  it("with Export private contact details, the phone is in the file", async () => {
    asBase([...MARKETING, "contacts.export.sensitive"]);
    const csv = await ((await GET(exportReq(), params)) as unknown as { text: () => Promise<string> }).text();
    expect(csv).toContain("+971501234567");
  });

  it("the blanks come from the missing keys: with finance and barcode access the same row carries them", async () => {
    asBase([...MARKETING, "finance.view", "barcode.view"]);
    const res = (await GET(exportReq(), params)) as unknown as { status: number; text: () => Promise<string> };
    const csv = await res.text();
    // The entry code is never in the CSV; the DTCM code is, behind barcode.view.
    expect(csv).toContain("DTCM-SECRET");
    expect(csv).toMatch(/\b500(\.00)?\b/);
  });

  it("a plain Base role person is refused, before any query", async () => {
    asBase([]);
    const res = (await GET(exportReq(), params)) as unknown as { status: number };
    expect(res.status).toBe(403);
    expect(mockDb.registration.findMany).not.toHaveBeenCalled();
  });
});
