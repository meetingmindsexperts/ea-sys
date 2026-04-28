/**
 * Tests for the OAuth-client tier propagation through validateOAuthAccessToken.
 *
 * The MCP route at /api/mcp branches on the returned `rateLimitTier` to
 * decide whether to apply the 100/hr abuse backstop. For OAuth grants,
 * the tier comes off the parent McpOAuthClient row (one row per claude.ai
 * "Add integration" event). SUPER_ADMIN flips the row to INTERNAL after
 * the user has connected once via DCR — every subsequent token minted
 * from that client inherits the bypass.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    mcpOAuthAccessToken: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { validateOAuthAccessToken } from "@/lib/mcp-oauth";

const MOCK_TOKEN = "mcp_at_" + "a".repeat(64);

describe("validateOAuthAccessToken — rateLimitTier propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns rateLimitTier=NORMAL for a default OAuth grant", async () => {
    mockDb.mcpOAuthAccessToken.findUnique.mockResolvedValueOnce({
      id: "tok-1",
      organizationId: "org-1",
      userId: "user-1",
      clientId: "client-default",
      expiresAt: new Date(Date.now() + 1_000_000),
      revokedAt: null,
      client: { rateLimitTier: "NORMAL" },
    });

    const result = await validateOAuthAccessToken(MOCK_TOKEN);

    expect(result).toEqual({
      organizationId: "org-1",
      userId: "user-1",
      clientId: "client-default",
      rateLimitTier: "NORMAL",
    });
  });

  it("returns rateLimitTier=INTERNAL when the parent client was flipped to INTERNAL", async () => {
    mockDb.mcpOAuthAccessToken.findUnique.mockResolvedValueOnce({
      id: "tok-2",
      organizationId: "org-2",
      userId: "user-2",
      clientId: "client-flipped",
      expiresAt: new Date(Date.now() + 1_000_000),
      revokedAt: null,
      client: { rateLimitTier: "INTERNAL" },
    });

    const result = await validateOAuthAccessToken(MOCK_TOKEN);

    expect(result?.rateLimitTier).toBe("INTERNAL");
  });

  it("returns null when the token is revoked (tier irrelevant)", async () => {
    mockDb.mcpOAuthAccessToken.findUnique.mockResolvedValueOnce({
      id: "tok-3",
      organizationId: "org-3",
      userId: "user-3",
      clientId: "c-3",
      expiresAt: new Date(Date.now() + 1_000_000),
      revokedAt: new Date(),
      client: { rateLimitTier: "INTERNAL" },
    });

    expect(await validateOAuthAccessToken(MOCK_TOKEN)).toBeNull();
  });

  it("returns null when the token has expired (tier irrelevant)", async () => {
    mockDb.mcpOAuthAccessToken.findUnique.mockResolvedValueOnce({
      id: "tok-4",
      organizationId: "org-4",
      userId: "user-4",
      clientId: "c-4",
      expiresAt: new Date(Date.now() - 1_000),
      revokedAt: null,
      client: { rateLimitTier: "INTERNAL" },
    });

    expect(await validateOAuthAccessToken(MOCK_TOKEN)).toBeNull();
  });

  it("returns null for a wrong-prefix token (no DB call)", async () => {
    expect(await validateOAuthAccessToken("not-a-token")).toBeNull();
    expect(mockDb.mcpOAuthAccessToken.findUnique).not.toHaveBeenCalled();
  });

  it("selects client.rateLimitTier in the same query", async () => {
    mockDb.mcpOAuthAccessToken.findUnique.mockResolvedValueOnce({
      id: "tok-5",
      organizationId: "org-5",
      userId: "user-5",
      clientId: "c-5",
      expiresAt: new Date(Date.now() + 1_000_000),
      revokedAt: null,
      client: { rateLimitTier: "NORMAL" },
    });

    await validateOAuthAccessToken(MOCK_TOKEN);

    const call = mockDb.mcpOAuthAccessToken.findUnique.mock.calls[0][0];
    expect(call.select.client).toEqual({ select: { rateLimitTier: true } });
  });
});
