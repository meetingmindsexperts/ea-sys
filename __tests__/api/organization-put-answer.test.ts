/**
 * PUT /api/organization answers with the saved profile, never the row (review
 * of d3e669030): the row's settings hold every encrypted credential, which the
 * GET was trimmed of on Oct 7, 2026 and this answer still carried. And the
 * columns ride in the settings' own locked update, so a save is one write.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockMerge } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockMerge: vi.fn(),
  mockDb: {
    organization: { findUnique: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));
vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/event-settings", () => ({ updateOrganizationSettings: mockMerge }));

import { PUT } from "@/app/api/organization/route";

const SECRET_ROW = { id: "org1", name: "MM Group", slug: "mm", logo: null, primaryColor: null, settings: { zoom: { clientSecret: "enc:abc" } } };

const put = (body: unknown) =>
  PUT(new Request("http://localhost/api/organization", { method: "PUT", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN", organizationId: "org1" } });
  mockDb.organization.update.mockResolvedValue(SECRET_ROW);
  // The existence check, then the answer: the route must ask for the profile columns only.
  mockDb.organization.findUnique.mockImplementation(async ({ select }: { select?: Record<string, boolean> }) =>
    Object.fromEntries(Object.entries(SECRET_ROW).filter(([k]) => !select || select[k])),
  );
  mockDb.auditLog.create.mockResolvedValue({});
  mockMerge.mockResolvedValue({});
});

describe("PUT /api/organization", () => {
  it("answers with the profile, without the settings and their credentials", async () => {
    const res = await put({ name: "MM Group" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ id: "org1", name: "MM Group", slug: "mm", logo: null, primaryColor: null });
    expect(JSON.stringify(body)).not.toContain("enc:");
  });

  it("a save of columns and settings is ONE locked write; columns alone are a plain update", async () => {
    await put({ name: "New name", settings: { website: "https://x.example" } });
    expect(mockMerge).toHaveBeenCalledWith("org1", { website: "https://x.example" }, { columns: { name: "New name" } });
    expect(mockDb.organization.update).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockMerge.mockResolvedValue({});
    await put({ name: "Only a name" });
    expect(mockMerge).not.toHaveBeenCalled();
    expect(mockDb.organization.update).toHaveBeenCalledWith({ where: { id: "org1" }, data: { name: "Only a name" } });
  });

  it("a failed audit row is logged and never turns a save that happened into a failure (review of d78d5ca60)", async () => {
    mockDb.auditLog.create.mockRejectedValue(new Error("audit policy"));
    const res = await put({ name: "MM Group" });
    expect(res.status).toBe(200);
  });
});
