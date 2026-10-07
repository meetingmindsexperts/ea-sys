/**
 * GET /api/organization is reachable by any signed-in account in the org. It
 * returned the whole row: the settings JSON with the encrypted Zoom, Stripe
 * and AI credentials, and the staff list with emails (Phase 6 review, Oct 7,
 * 2026). It now returns what the Settings screens show.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockFindUnique } = vi.hoisted(() => ({ mockAuth: vi.fn(), mockFindUnique: vi.fn() }));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: { organization: { findUnique: mockFindUnique } } }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));

import { GET } from "@/app/api/organization/route";

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "o1", role: "ONSITE", organizationId: "org1" } });
  mockFindUnique.mockResolvedValue({
    id: "org1", name: "MMG", slug: "mmg", logo: null, primaryColor: null,
    settings: { timezone: "Asia/Dubai", currency: "AED", zoom: { clientSecret: "enc:abc" }, stripe: { secretKey: "enc:sk" }, ai: { apiKey: "enc:k" } },
    taxId: "TRN-123", companyEmail: "accounts@mmg.example", companyPhone: "+971",
    _count: { events: 3, users: 9 },
  });
});

describe("GET /api/organization", () => {
  it("selects no staff list and returns only the general settings", async () => {
    const res = await GET(new Request("http://localhost/api/organization"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings).toEqual({ timezone: "Asia/Dubai", currency: "AED" });
    expect(JSON.stringify(body)).not.toContain("enc:");
    const args = mockFindUnique.mock.calls[0][0];
    expect(args).not.toHaveProperty("include");
    expect(args.select).not.toHaveProperty("users");
  });

  it("keeps the company and tax details for the people whose Billing screen uses them", async () => {
    const onsite = await (await GET(new Request("http://localhost/api/organization"))).json();
    expect(onsite).not.toHaveProperty("taxId");
    expect(onsite).not.toHaveProperty("companyEmail");
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN", organizationId: "org1" } });
    const admin = await (await GET(new Request("http://localhost/api/organization"))).json();
    expect(admin.taxId).toBe("TRN-123");
  });
});
