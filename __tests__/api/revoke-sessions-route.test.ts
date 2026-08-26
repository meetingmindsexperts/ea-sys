/**
 * POST /api/organization/users/[userId]/revoke-sessions
 *
 * The sharp counterpart to Deactivate. Until Aug 26 2026 the only lever an
 * admin had for "a laptop went missing" was deactivation, which also stopped
 * the legitimate owner signing back in.
 *
 * Two properties carry the feature and both are pinned below: the write is
 * bound to the caller's org (a cross-tenant session kill is the worst thing
 * this endpoint could be talked into), and it touches ONLY `tokenVersion` —
 * an implementation that also cleared `deactivatedAt`, reset the role, or
 * flipped a password would be a different, much more dangerous button wearing
 * this one's label.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockRateLimit } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    user: { updateMany: vi.fn(), findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockRateLimit: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/security", () => ({
  checkRateLimit: (...a: unknown[]) => mockRateLimit(...a),
  getClientIp: () => "1.2.3.4",
}));
vi.mock("@/lib/api-errors", () => ({
  rateLimited: () => ({ status: 429, json: async () => ({ error: "Too many requests" }) }),
}));
vi.mock("@/lib/require-org", () => ({
  requireOrgId: (session: { user?: { organizationId?: string | null } } | null) =>
    session?.user?.organizationId
      ? { orgId: session.user.organizationId }
      : { error: { status: 403, json: async () => ({ error: "Forbidden" }) } },
}));

import { POST } from "@/app/api/organization/users/[userId]/revoke-sessions/route";

const req = () => new Request("http://localhost/x", { method: "POST" });
const params = (userId = "target-1") => ({ params: Promise.resolve({ userId }) });

function session(role: string, id = "admin-1", organizationId: string | null = "org-1") {
  return { user: { id, role, organizationId } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(session("ADMIN"));
  mockRateLimit.mockReturnValue({ allowed: true, remaining: 29, retryAfterSeconds: 3600 });
  mockDb.user.updateMany.mockResolvedValue({ count: 1 });
  mockDb.user.findFirst.mockResolvedValue({
    email: "victim@x.com",
    firstName: "Vi",
    lastName: "Ctim",
    tokenVersion: 3,
  });
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("who may revoke", () => {
  it("401s an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await POST(req(), params())).status).toBe(401);
    expect(mockDb.user.updateMany).not.toHaveBeenCalled();
  });

  it("403s an org-null caller before touching the database", async () => {
    mockAuth.mockResolvedValue(session("ADMIN", "admin-1", null));
    expect((await POST(req(), params())).status).toBe(403);
    expect(mockDb.user.updateMany).not.toHaveBeenCalled();
  });

  it.each(["ADMIN", "SUPER_ADMIN"])("lets %s revoke another user", async (role) => {
    mockAuth.mockResolvedValue(session(role));
    expect((await POST(req(), params())).status).toBe(200);
  });

  it.each(["ORGANIZER", "MEMBER", "ONSITE", "CRM_USER", "WEBINARS"])(
    "403s %s revoking someone else",
    async (role) => {
      mockAuth.mockResolvedValue(session(role, "someone-1"));
      const res = await POST(req(), params());
      expect(res.status).toBe(403);
      expect(mockDb.user.updateMany).not.toHaveBeenCalled();
    },
  );

  it("lets a non-admin sign THEMSELVES out everywhere", async () => {
    // Deliberately unlike deactivation, which refuses self: signing yourself
    // out is undone by signing back in, locking yourself out is not.
    mockAuth.mockResolvedValue(session("ORGANIZER", "self-1"));
    const res = await POST(req(), params("self-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ revoked: true, self: true });
  });
});

describe("what it actually writes", () => {
  it("binds the WRITE to the caller's org, not just a preceding read", async () => {
    await POST(req(), params("target-1"));
    expect(mockDb.user.updateMany).toHaveBeenCalledWith({
      where: { id: "target-1", organizationId: "org-1" },
      data: { tokenVersion: { increment: 1 } },
    });
  });

  it("touches ONLY tokenVersion", async () => {
    // The whole point of this button is that it is not Deactivate. If it ever
    // learns to write deactivatedAt, role or a password hash, that is a
    // different and far more dangerous action wearing this label.
    await POST(req(), params());
    const data = mockDb.user.updateMany.mock.calls[0][0].data;
    expect(Object.keys(data)).toEqual(["tokenVersion"]);
  });

  it("404s when the target is in another org, and writes nothing further", async () => {
    mockDb.user.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(req(), params("foreign-1"));
    expect(res.status).toBe(404);
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("audits with the counter the database actually landed on", async () => {
    // Read back rather than computed: two admins reacting to one incident is
    // the normal case, so the audit row should carry the real value.
    await POST(req(), params("target-1"));
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "REVOKE_SESSIONS",
          entityType: "User",
          entityId: "target-1",
          changes: expect.objectContaining({ tokenVersion: 3, self: false }),
        }),
      }),
    );
  });

  it("still reports success when the audit write fails", async () => {
    // The revocation has already committed; failing the request would tell the
    // admin it did not happen when it did.
    mockDb.auditLog.create.mockRejectedValue(new Error("pool timeout"));
    const res = await POST(req(), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ revoked: true });
  });
});

describe("rate limiting", () => {
  it("429s past the ceiling without revoking", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterSeconds: 120 });
    expect((await POST(req(), params())).status).toBe(429);
    expect(mockDb.user.updateMany).not.toHaveBeenCalled();
  });

  it("keys the bucket on the CALLER, so one admin cannot spray the org", async () => {
    await POST(req(), params());
    expect(mockRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ key: "revoke-sessions:admin-1" }),
    );
  });
});
