/**
 * Tests for the per-key `rateLimitTier` plumbing through `validateApiKey`.
 *
 * The MCP route at /api/mcp branches on the returned `rateLimitTier` to
 * decide whether to apply the 100/hr abuse backstop. If the validator
 * silently drops the field, every key would be treated as NORMAL — these
 * tests pin the contract so future refactors can't regress that path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    apiKey: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { validateApiKey } from "@/lib/api-key";

describe("validateApiKey — rateLimitTier propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns rateLimitTier=NORMAL for legacy / standard keys", async () => {
    mockDb.apiKey.findUnique.mockResolvedValueOnce({
      id: "key-1",
      organizationId: "org-1",
      isActive: true,
      expiresAt: null,
      rateLimitTier: "NORMAL",
    });

    const result = await validateApiKey("mmg_" + "a".repeat(64));

    expect(result).toEqual({ organizationId: "org-1", rateLimitTier: "NORMAL" });
  });

  it("returns rateLimitTier=INTERNAL for SUPER_ADMIN-issued internal keys", async () => {
    mockDb.apiKey.findUnique.mockResolvedValueOnce({
      id: "key-2",
      organizationId: "org-2",
      isActive: true,
      expiresAt: null,
      rateLimitTier: "INTERNAL",
    });

    const result = await validateApiKey("mmg_" + "b".repeat(64));

    expect(result).toEqual({ organizationId: "org-2", rateLimitTier: "INTERNAL" });
  });

  it("returns null when the key is inactive (tier irrelevant)", async () => {
    mockDb.apiKey.findUnique.mockResolvedValueOnce({
      id: "key-3",
      organizationId: "org-3",
      isActive: false,
      expiresAt: null,
      rateLimitTier: "INTERNAL",
    });

    expect(await validateApiKey("mmg_" + "c".repeat(64))).toBeNull();
  });

  it("returns null when the key has expired (tier irrelevant)", async () => {
    mockDb.apiKey.findUnique.mockResolvedValueOnce({
      id: "key-4",
      organizationId: "org-4",
      isActive: true,
      expiresAt: new Date(Date.now() - 1000),
      rateLimitTier: "INTERNAL",
    });

    expect(await validateApiKey("mmg_" + "d".repeat(64))).toBeNull();
  });

  it("returns null when the prefix is wrong (no DB lookup)", async () => {
    expect(await validateApiKey("wrong_prefix_key")).toBeNull();
    expect(mockDb.apiKey.findUnique).not.toHaveBeenCalled();
  });

  it("selects rateLimitTier from the row (not just the columns the caller wants)", async () => {
    mockDb.apiKey.findUnique.mockResolvedValueOnce({
      id: "key-5",
      organizationId: "org-5",
      isActive: true,
      expiresAt: null,
      rateLimitTier: "NORMAL",
    });

    await validateApiKey("mmg_" + "e".repeat(64));

    const call = mockDb.apiKey.findUnique.mock.calls[0][0];
    expect(call.select).toMatchObject({ rateLimitTier: true });
  });
});
