/**
 * /api/registration-types had no permission key: any org-bound account read
 * every event's registration-type names (Phase 6 review, Oct 7, 2026). It now
 * asks tickets.read and lists only the events that grant covers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockOrgCtx, mockFindMany } = vi.hoisted(() => ({ mockOrgCtx: vi.fn(), mockFindMany: vi.fn() }));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b, headers: new Map() }),
  },
}));
vi.mock("@/lib/api-auth", () => ({ getOrgContext: () => mockOrgCtx() }));
vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/db", () => ({ db: { ticketType: { findMany: mockFindMany } } }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));

import { GET } from "@/app/api/registration-types/route";

const req = () => new Request("http://localhost/api/registration-types");

beforeEach(() => {
  vi.clearAllMocks();
  mockFindMany.mockResolvedValue([{ name: "Delegate" }]);
});

describe("GET /api/registration-types", () => {
  it("lists the names for a role that reads registration types", async () => {
    mockOrgCtx.mockResolvedValue({ organizationId: "org1", userId: "u1", role: "ORGANIZER", fromApiKey: false, fromMobile: false });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(["Delegate"]);
    const where = mockFindMany.mock.calls[0][0].where.event.AND;
    expect(where[0]).toEqual({ organizationId: "org1" });
  });

  it("gives a role without tickets.read an empty filter (no events), not every event's names", async () => {
    mockOrgCtx.mockResolvedValue({ organizationId: "org1", userId: "c1", role: "CRM_USER", fromApiKey: false, fromMobile: false });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(mockFindMany.mock.calls[0][0].where.event.AND[1]).toEqual({ id: { in: [] } });
  });
});
