/**
 * Tests for PATCH /api/organization/oauth-clients/[clientId].
 *
 * Flipping an OAuth client to INTERNAL bypasses the MCP rate limit for every
 * token minted from that DCR registration. SUPER_ADMIN-only — same threat
 * model as INTERNAL API keys. The route also enforces an org-ownership
 * check (at least one token from this client must belong to caller's org)
 * so a SUPER_ADMIN in org A can't flip a client claude.ai registered for
 * a user in org B.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    mcpOAuthAccessToken: { findFirst: vi.fn() },
    mcpOAuthClient: { update: vi.fn() },
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

import { PATCH } from "@/app/api/organization/oauth-clients/[clientId]/route";

function makeReq(body: unknown) {
  return new Request("http://localhost/api/organization/oauth-clients/abc", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ clientId: "abc-client-id" });

describe("PATCH /api/organization/oauth-clients/[clientId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("SUPER_ADMIN can flip a client they own to INTERNAL", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u1", role: "SUPER_ADMIN", organizationId: "org-1" },
    });
    mockDb.mcpOAuthAccessToken.findFirst.mockResolvedValueOnce({ id: "t1" });
    mockDb.mcpOAuthClient.update.mockResolvedValueOnce({
      clientId: "abc-client-id",
      clientName: "claude.ai integration",
      rateLimitTier: "INTERNAL",
    });

    const res = await PATCH(makeReq({ rateLimitTier: "INTERNAL" }), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.rateLimitTier).toBe("INTERNAL");
    expect(mockDb.mcpOAuthClient.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientId: "abc-client-id" },
        data: { rateLimitTier: "INTERNAL" },
      }),
    );
  });

  it("ADMIN is rejected with 403 (only SUPER_ADMIN can flip tier)", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u1", role: "ADMIN", organizationId: "org-1" },
    });

    const res = await PATCH(makeReq({ rateLimitTier: "INTERNAL" }), { params });
    expect(res.status).toBe(403);
    expect(mockDb.mcpOAuthClient.update).not.toHaveBeenCalled();
  });

  it("SUPER_ADMIN cannot flip a client that has no tokens in their org (404)", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u1", role: "SUPER_ADMIN", organizationId: "org-1" },
    });
    mockDb.mcpOAuthAccessToken.findFirst.mockResolvedValueOnce(null);

    const res = await PATCH(makeReq({ rateLimitTier: "INTERNAL" }), { params });
    expect(res.status).toBe(404);
    expect(mockDb.mcpOAuthClient.update).not.toHaveBeenCalled();
  });

  it("SUPER_ADMIN can revert an INTERNAL client back to NORMAL", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u1", role: "SUPER_ADMIN", organizationId: "org-1" },
    });
    mockDb.mcpOAuthAccessToken.findFirst.mockResolvedValueOnce({ id: "t1" });
    mockDb.mcpOAuthClient.update.mockResolvedValueOnce({
      clientId: "abc-client-id",
      clientName: null,
      rateLimitTier: "NORMAL",
    });

    const res = await PATCH(makeReq({ rateLimitTier: "NORMAL" }), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.rateLimitTier).toBe("NORMAL");
  });

  it("invalid tier value fails Zod (400)", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u1", role: "SUPER_ADMIN", organizationId: "org-1" },
    });

    const res = await PATCH(makeReq({ rateLimitTier: "GODMODE" }), { params });
    expect(res.status).toBe(400);
  });

  it("missing body fails Zod (400)", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u1", role: "SUPER_ADMIN", organizationId: "org-1" },
    });

    const res = await PATCH(makeReq({}), { params });
    expect(res.status).toBe(400);
  });

  it("unauthenticated request is rejected with 401 before DB lookup", async () => {
    mockAuth.mockResolvedValueOnce(null);

    const res = await PATCH(makeReq({ rateLimitTier: "INTERNAL" }), { params });
    expect(res.status).toBe(401);
    expect(mockDb.mcpOAuthAccessToken.findFirst).not.toHaveBeenCalled();
  });

  it("ORGANIZER is rejected with 403", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u1", role: "ORGANIZER", organizationId: "org-1" },
    });

    const res = await PATCH(makeReq({ rateLimitTier: "INTERNAL" }), { params });
    expect(res.status).toBe(403);
  });

  it("REVIEWER is rejected by denyReviewer", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u1", role: "REVIEWER", organizationId: null },
    });

    const res = await PATCH(makeReq({ rateLimitTier: "INTERNAL" }), { params });
    expect(res.status).toBe(403);
  });
});
