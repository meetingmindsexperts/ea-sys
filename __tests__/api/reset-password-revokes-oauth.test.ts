/**
 * A password reset signs the account out everywhere, and "everywhere"
 * includes claude.ai (G6, docs/CUSTOM_ROLES_PLAN.md §2.4). The OAuth rows are
 * revoked INSIDE the reset transaction, so a reset that rolls back leaves the
 * connection as it was and a reset that commits cannot leave it connected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockTx } = vi.hoisted(() => {
  const mockTx = {
    user: { update: vi.fn() },
    verificationToken: { delete: vi.fn() },
    auditLog: { create: vi.fn() },
    mcpOAuthAccessToken: { updateMany: vi.fn() },
  };
  return {
    mockTx,
    mockDb: {
      verificationToken: { findFirst: vi.fn(), delete: vi.fn() },
      mcpOAuthAccessToken: { updateMany: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
    },
  };
});

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/security", () => ({
  checkRateLimit: () => ({ allowed: true, remaining: 9, retryAfterSeconds: 0 }),
  getClientIp: () => "1.2.3.4",
  hashVerificationToken: (t: string) => `h:${t}`,
}));
vi.mock("@/lib/tenant/user-lookup", () => ({
  scopeFromRequestHost: async () => ({ kind: "master" }),
  findUserByEmail: async () => ({ id: "u-1", organizationId: "org-1" }),
}));
vi.mock("bcryptjs", () => ({ default: { hash: async () => "hashed" } }));

import { POST } from "@/app/api/auth/reset-password/route";

const req = () =>
  new Request("http://localhost/api/auth/reset-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "t", email: "a@b.com", password: "secret12", confirmPassword: "secret12" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.verificationToken.findFirst.mockResolvedValue({ expires: new Date(Date.now() + 60_000) });
  mockTx.user.update.mockResolvedValue({});
  mockTx.verificationToken.delete.mockResolvedValue({});
  mockTx.auditLog.create.mockResolvedValue({});
  mockTx.mcpOAuthAccessToken.updateMany.mockResolvedValue({ count: 1 });
});

describe("reset-password and claude.ai connections", () => {
  it("revokes the user's OAuth grants inside the reset transaction", async () => {
    expect((await POST(req())).status).toBe(200);
    expect(mockTx.mcpOAuthAccessToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "u-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(mockDb.mcpOAuthAccessToken.updateMany).not.toHaveBeenCalled();
  });

  it("revokes nothing when the reset link is invalid", async () => {
    mockDb.verificationToken.findFirst.mockResolvedValue(null);
    expect((await POST(req())).status).toBe(400);
    expect(mockTx.mcpOAuthAccessToken.updateMany).not.toHaveBeenCalled();
  });
});
