/**
 * PUT /api/organization `settings.defaultRegistrationTypes`: the per-org list
 * of registration types a new event starts with (Settings → General). Pins
 * that it is validated, saved through the locked settings merge, gated by
 * org.settings, and returned by the GET.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockMerge, mockWarn } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    organization: { findUnique: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockMerge: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: mockWarn, error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/event-settings", () => ({ updateOrganizationSettings: mockMerge }));

import { GET, PUT } from "@/app/api/organization/route";

const put = (body: unknown) =>
  PUT(new Request("http://localhost/api/organization", { method: "PUT", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN", organizationId: "org1" } });
  mockDb.organization.findUnique.mockResolvedValue({ id: "org1", settings: {} });
  mockDb.organization.update.mockResolvedValue({ id: "org1" });
  mockDb.auditLog.create.mockResolvedValue({});
  mockMerge.mockResolvedValue({});
});

describe("PUT /api/organization defaultRegistrationTypes", () => {
  it("saves a trimmed list through the settings merge", async () => {
    const res = await put({ settings: { defaultRegistrationTypes: [" Delegate ", "Exhibitor"] } });
    expect(res.status).toBe(200);
    expect(mockMerge).toHaveBeenCalledWith("org1", { defaultRegistrationTypes: ["Delegate", "Exhibitor"] });
  });

  it("saves an empty list (no starting types)", async () => {
    const res = await put({ settings: { defaultRegistrationTypes: [] } });
    expect(res.status).toBe(200);
    expect(mockMerge).toHaveBeenCalledWith("org1", { defaultRegistrationTypes: [] });
  });

  it.each([
    ["a duplicate", ["Delegate", "delegate"]],
    ["a blank name", [""]],
    ["a non-list", "Delegate"],
  ])("refuses %s with a logged 400", async (_label, value) => {
    const res = await put({ settings: { defaultRegistrationTypes: value } });
    expect(res.status).toBe(400);
    expect(mockMerge).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(expect.objectContaining({ msg: "organization:zod-validation-failed" }));
  });

  it("is refused for a role without org.settings", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", organizationId: "org1" } });
    const res = await put({ settings: { defaultRegistrationTypes: ["Delegate"] } });
    expect(res.status).toBe(403);
    expect(mockMerge).not.toHaveBeenCalled();
  });
});

describe("GET /api/organization defaultRegistrationTypes", () => {
  it("returns the list with the general settings", async () => {
    mockDb.organization.findUnique.mockResolvedValue({
      id: "org1",
      settings: { timezone: "Asia/Dubai", defaultRegistrationTypes: ["Physician"], ai: { apiKey: "enc:k" } },
      _count: { events: 0, users: 1 },
    });
    const body = await (await GET(new Request("http://localhost/api/organization"))).json();
    expect(body.settings).toEqual({ timezone: "Asia/Dubai", defaultRegistrationTypes: ["Physician"] });
  });
});
