/**
 * Tests for the API key POST route's rateLimitTier RBAC.
 *
 * INTERNAL-tier keys bypass the MCP rate limit, so issuing one is a
 * privileged capability gated to SUPER_ADMIN. ADMIN must be able to keep
 * issuing NORMAL keys for everyday automation, and any attempt by ADMIN
 * to set tier=INTERNAL must be rejected with 403, not silently
 * downgraded — silent downgrades hide misconfigured callers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    apiKey: {
      create: vi.fn().mockResolvedValue({ id: "key-1" }),
    },
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/auth-guards", () => ({
  denyReviewer: (session: { user?: { role?: string } } | null) => {
    const role = session?.user?.role;
    if (role === "REVIEWER" || role === "SUBMITTER" || role === "REGISTRANT") {
      return { status: 403, json: async () => ({ error: "Forbidden" }) };
    }
    return null;
  },
}));

vi.mock("@/lib/api-key", () => ({
  generateApiKey: () => "mmg_" + "a".repeat(64),
  hashApiKey: (k: string) => `hash:${k}`,
  keyPrefix: (k: string) => k.slice(0, 12),
}));

import { POST } from "@/app/api/organization/api-keys/route";

function makeReq(body: unknown) {
  return new Request("http://localhost/api/organization/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/organization/api-keys — rateLimitTier RBAC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ADMIN can create a NORMAL-tier key (default)", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u1", role: "ADMIN", organizationId: "org-1" },
    });

    const res = await POST(makeReq({ name: "n8n bot" }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.rateLimitTier).toBe("NORMAL");
    expect(mockDb.apiKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ rateLimitTier: "NORMAL" }),
      }),
    );
  });

  it("ADMIN explicitly requesting INTERNAL is rejected with 403, not silently downgraded", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u1", role: "ADMIN", organizationId: "org-1" },
    });

    const res = await POST(
      makeReq({ name: "wants internal", rateLimitTier: "INTERNAL" }),
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toMatch(/SUPER_ADMIN/);
    expect(mockDb.apiKey.create).not.toHaveBeenCalled();
  });

  it("SUPER_ADMIN can create an INTERNAL-tier key", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u1", role: "SUPER_ADMIN", organizationId: "org-1" },
    });

    const res = await POST(
      makeReq({ name: "internal automation", rateLimitTier: "INTERNAL" }),
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.rateLimitTier).toBe("INTERNAL");
    expect(mockDb.apiKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ rateLimitTier: "INTERNAL" }),
      }),
    );
  });

  it("SUPER_ADMIN omitting tier defaults to NORMAL", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u1", role: "SUPER_ADMIN", organizationId: "org-1" },
    });

    const res = await POST(makeReq({ name: "no tier specified" }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.rateLimitTier).toBe("NORMAL");
  });

  it("ORGANIZER (non-admin) is rejected before tier check", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u1", role: "ORGANIZER", organizationId: "org-1" },
    });

    const res = await POST(makeReq({ name: "x" }));
    expect(res.status).toBe(403);
    expect(mockDb.apiKey.create).not.toHaveBeenCalled();
  });

  it("unauthenticated request is rejected with 401", async () => {
    mockAuth.mockResolvedValueOnce(null);

    const res = await POST(makeReq({ name: "x" }));
    expect(res.status).toBe(401);
  });

  it("invalid tier value fails Zod (400)", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u1", role: "SUPER_ADMIN", organizationId: "org-1" },
    });

    const res = await POST(
      makeReq({ name: "x", rateLimitTier: "GODMODE" }),
    );
    expect(res.status).toBe(400);
    expect(mockDb.apiKey.create).not.toHaveBeenCalled();
  });
});
