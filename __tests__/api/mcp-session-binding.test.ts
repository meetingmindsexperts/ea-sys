/**
 * An MCP session is bound to the credential that opened it and to what that
 * credential could do then (custom-roles review L1, Oct 6, 2026). Before, a
 * request carrying a known `mcp-session-id` reused the session's server
 * whatever credential it came with, and a key whose role was narrowed kept its
 * old tool set until the 30-minute TTL; any session id also ended a session.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockValidateApiKey, mockLogger, transports } = vi.hoisted(() => ({
  mockValidateApiKey: vi.fn(),
  mockLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  transports: [] as { sessionId?: string; handled: number }[],
}));

vi.mock("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js", () => ({
  WebStandardStreamableHTTPServerTransport: class {
    sessionId?: string;
    handled = 0;
    onclose?: () => void;
    constructor() {
      transports.push(this);
    }
    async handleRequest() {
      this.handled++;
      this.sessionId ??= `s-${transports.length}`;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
  },
}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/api-key", () => ({ validateApiKey: (...a: unknown[]) => mockValidateApiKey(...a), apiKeyUseContext: () => ({}) }));
vi.mock("@/lib/mcp-oauth", () => ({ validateOAuthAccessToken: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true }) }));
vi.mock("@/lib/agent/mcp-server-builder", () => ({ buildMcpServer: () => ({ connect: async () => {} }) }));
vi.mock("@/lib/mcp-cors", () => ({
  handlePreflight: vi.fn(),
  withCors: (_req: Request, res: Response) => res,
  publicBaseUrl: () => "https://example.test",
}));

import { DELETE, POST } from "@/app/api/mcp/route";

const key = (id: string, grants: unknown = null) => ({
  organizationId: "org-1",
  keyPrefix: `mmg_${id}`,
  rateLimitTier: "NORMAL",
  apiKeyId: id,
  apiKeyName: id,
  grants,
});
const call = (method: "POST" | "DELETE", sessionId?: string) =>
  (method === "POST" ? POST : DELETE)(
    new Request("http://localhost/api/mcp", {
      method,
      headers: { "x-api-key": "mmg_x", accept: "application/json, text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MCP session binding", () => {
  it("reuses a session for the credential that opened it", async () => {
    mockValidateApiKey.mockResolvedValue(key("k1"));
    await call("POST");
    const sid = transports.at(-1)!.sessionId!;
    expect((await call("POST", sid)).status).toBe(200);
    expect(transports.at(-1)!.handled).toBe(2);
  });

  it("refuses the session to a different key", async () => {
    mockValidateApiKey.mockResolvedValue(key("k2"));
    await call("POST");
    const opened = transports.at(-1)!;
    mockValidateApiKey.mockResolvedValue(key("intruder"));
    expect((await call("POST", opened.sessionId)).status).toBe(404);
    expect(opened.handled).toBe(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "mcp:session-credential-mismatch" }));
  });

  it("ends the session when the key's role changed, so the client reconnects", async () => {
    mockValidateApiKey.mockResolvedValue(key("k3", [{ permission: "events.read", scope: "ALL" }]));
    await call("POST");
    const opened = transports.at(-1)!;
    mockValidateApiKey.mockResolvedValue(key("k3", []));
    expect((await call("POST", opened.sessionId)).status).toBe(404);
    expect(opened.handled).toBe(1);
    // Gone for good: the same id is now simply stale.
    mockValidateApiKey.mockResolvedValue(key("k3", [{ permission: "events.read", scope: "ALL" }]));
    expect((await call("POST", opened.sessionId)).status).toBe(404);
  });

  it("lets only the opening credential end a session", async () => {
    mockValidateApiKey.mockResolvedValue(key("k4"));
    await call("POST");
    const sid = transports.at(-1)!.sessionId!;
    mockValidateApiKey.mockResolvedValue(null);
    expect((await call("DELETE", sid)).status).toBe(401);
    mockValidateApiKey.mockResolvedValue(key("other"));
    expect((await call("DELETE", sid)).status).toBe(404);
    mockValidateApiKey.mockResolvedValue(key("k4"));
    expect((await call("DELETE", sid)).status).toBe(204);
  });
});
