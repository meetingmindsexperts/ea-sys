/**
 * /api/mcp refuses an OAuth grant whose granting user is deactivated
 * (G6, docs/CUSTOM_ROLES_PLAN.md §2.4).
 *
 * The grant is a database row that never consulted the user's state, so a
 * deactivated person's claude.ai connection kept working. Deactivation now
 * revokes the rows too (users-procurement-delegate.test.ts); this pins the
 * per-request check that covers grants made before that revocation existed.
 *
 * An ACTIVE grantee is shown to pass authentication by reaching the rate
 * limiter (forced to refuse, so the MCP server is never built).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockValidateOAuth, mockRateLimit, mockLogger } = vi.hoisted(() => ({
  mockDb: { user: { findUnique: vi.fn() } },
  mockValidateOAuth: vi.fn(),
  mockRateLimit: vi.fn(),
  mockLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/api-key", () => ({
  validateApiKey: vi.fn().mockResolvedValue(null),
  apiKeyUseContext: () => ({}),
}));
vi.mock("@/lib/mcp-oauth", () => ({ validateOAuthAccessToken: (...a: unknown[]) => mockValidateOAuth(...a) }));
vi.mock("@/lib/security", () => ({ checkRateLimit: (...a: unknown[]) => mockRateLimit(...a) }));
vi.mock("@/lib/agent/mcp-server-builder", () => ({
  buildMcpServer: () => {
    throw new Error("must not be reached");
  },
}));
vi.mock("@/lib/mcp-cors", () => ({
  handlePreflight: vi.fn(),
  withCors: (_req: Request, res: Response) => res,
  publicBaseUrl: () => "https://example.test",
}));

import { POST } from "@/app/api/mcp/route";

const req = () =>
  new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: { authorization: "Bearer mcp_at_" + "a".repeat(40) },
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockValidateOAuth.mockResolvedValue({ organizationId: "org-1", userId: "u-1", clientId: "c-1", rateLimitTier: "NORMAL" });
  mockRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 60 });
});

describe("MCP OAuth grantee status", () => {
  it("lets an active grantee through authentication", async () => {
    mockDb.user.findUnique.mockResolvedValue({ role: "ORGANIZER", organizationId: "org-1", deactivatedAt: null });
    expect((await POST(req())).status).toBe(429);
  });

  it("refuses a deactivated grantee with 401 and logs it", async () => {
    mockDb.user.findUnique.mockResolvedValue({ role: "ADMIN", organizationId: "org-1", deactivatedAt: new Date() });
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "mcp:oauth-grantee-deactivated", userId: "u-1" }));
  });

  it("reads deactivatedAt, not only the role", async () => {
    mockDb.user.findUnique.mockResolvedValue({ role: "ADMIN", organizationId: "org-1", deactivatedAt: null });
    await POST(req());
    expect(mockDb.user.findUnique.mock.calls[0][0].select).toMatchObject({ deactivatedAt: true });
  });
});
