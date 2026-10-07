/**
 * Phase 6 review LOWs (Oct 7, 2026): a role change and the clearing of the
 * person's custom roles are one transaction, and it refuses to leave the
 * organisation without an active super admin.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    user: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), count: vi.fn() },
    userPermissionSet: { deleteMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $queryRaw: vi.fn(),
  },
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: (tx: typeof mockDb) => unknown) => fn(mockDb) }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/security", () => ({ getClientIp: vi.fn().mockReturnValue("1.2.3.4") }));
vi.mock("@/lib/event-settings", () => ({ removeUserFromEventSettings: vi.fn() }));

const ORG = "org-1";
const TARGET = "other-super";

async function put(body: unknown) {
  const { PUT } = await import("@/app/api/organization/users/[userId]/route");
  return PUT({ json: async () => body } as unknown as Request, { params: Promise.resolve({ userId: TARGET }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "me-super", role: "SUPER_ADMIN", organizationId: ORG } });
  const target = { id: TARGET, role: "SUPER_ADMIN", organizationId: ORG, email: "s@example.com" };
  mockDb.user.findFirst.mockResolvedValue(target);
  mockDb.user.findUnique.mockResolvedValue(target);
  mockDb.user.update.mockResolvedValue({ ...target, role: "ADMIN" });
  mockDb.userPermissionSet.deleteMany.mockResolvedValue({ count: 0 });
  mockDb.$queryRaw.mockResolvedValue([]);
});

describe("PUT /api/organization/users/[userId]: role change", () => {
  it("locks the super admin rows and refuses to leave none (409 LAST_SUPER_ADMIN)", async () => {
    mockDb.user.count.mockResolvedValue(0);
    const res = await put({ role: "ADMIN" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("LAST_SUPER_ADMIN");
    expect(mockDb.$queryRaw).toHaveBeenCalled();
  });

  it("allows it while another active super admin remains, clearing custom roles in the same transaction", async () => {
    mockDb.user.count.mockResolvedValue(1);
    const res = await put({ role: "ADMIN" });
    expect(res.status).toBe(200);
    expect(mockDb.userPermissionSet.deleteMany).toHaveBeenCalledWith({ where: { organizationId: ORG, userId: TARGET } });
    // The role write comes first, so it holds the row lock during the clear.
    expect(mockDb.user.update.mock.invocationCallOrder[0]).toBeLessThan(mockDb.userPermissionSet.deleteMany.mock.invocationCallOrder[0]);
  });

  it("locks the target row first, then every super admin in id order, both FOR UPDATE", async () => {
    mockDb.user.count.mockResolvedValue(1);
    await put({ role: "ADMIN" });
    const sql = mockDb.$queryRaw.mock.calls.map((c) => (c[0] as TemplateStringsArray).join("?"));
    expect(sql).toHaveLength(2);
    expect(sql[0]).toMatch(/WHERE id = \? FOR UPDATE$/);
    expect(sql[1]).toMatch(/role = 'SUPER_ADMIN' ORDER BY id FOR UPDATE$/);
  });

  it("takes no super-admin lock and runs no count for an ordinary role change", async () => {
    const admin = { id: TARGET, role: "ORGANIZER", organizationId: ORG, email: "o@example.com" };
    mockDb.user.findFirst.mockResolvedValue(admin);
    mockDb.user.findUnique.mockResolvedValue(admin);
    const res = await put({ role: "MEMBER" });
    expect(res.status).toBe(200);
    expect(mockDb.$queryRaw).not.toHaveBeenCalled();
    expect(mockDb.user.count).not.toHaveBeenCalled();
    expect(mockDb.userPermissionSet.deleteMany).toHaveBeenCalled();
  });
});
