/**
 * API-key usage logging (Sep 4, 2026).
 *
 * "Which key is being used, when, from where, for what" must be answerable
 * from /logs. Until this landed the only trace of a key's use was
 * `ApiKey.lastUsedAt` (the LAST timestamp, nothing else) and the REST path
 * through `getOrgContext` logged nothing at all. These tests pin:
 *
 *   - every successful use logs `api-key:used` at INFO with the key's id,
 *     name, display prefix, org, tier and the request context;
 *   - every refused `mmg_` credential logs `api-key:refused` at WARN with a
 *     reason (warn is what reaches the SystemLog table, so the integrations
 *     still presenting a rotated key show up on /logs and /admin/infra);
 *   - the credential itself, and its hash, NEVER appear in any line: the log
 *     is read by every admin, and a key in a log line is a key in a log file,
 *     in CloudWatch and in the SystemLog table;
 *   - a non-`mmg_` string (a mobile JWT, an OAuth token) produces no line and
 *     no database read, because those pass through the validator first and are
 *     not API-key failures;
 *   - `apiKeyUseContext` records the pathname and NOT the query string, because
 *     `?q=` on the registrations list can carry an email address.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockLogger } = vi.hoisted(() => ({
  mockDb: {
    apiKey: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
  mockLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));

import { apiKeyUseContext, hashApiKey, validateApiKey } from "@/lib/api-key";

const RAW = "mmg_" + "f".repeat(64);
const ROW = {
  id: "key-usage-1",
  organizationId: "org-1",
  name: "n8n Webflow sync",
  prefix: "mmg_ffffffff",
  isActive: true,
  expiresAt: null,
  rateLimitTier: "NORMAL",
};
const CTX = {
  surface: "rest" as const,
  method: "GET",
  route: "/api/events/evt-1/speakers",
  ip: "203.0.113.9",
  userAgent: "n8n/1.0",
};

function allLogPayloads(): string {
  return [...mockLogger.info.mock.calls, ...mockLogger.warn.mock.calls, ...mockLogger.error.mock.calls]
    .map((c) => JSON.stringify(c[0]))
    .join("\n");
}

describe("validateApiKey usage log", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs api-key:used at info with the key identity and the request context", async () => {
    mockDb.apiKey.findUnique.mockResolvedValueOnce(ROW);

    const result = await validateApiKey(RAW, CTX);

    expect(result).toEqual({
      organizationId: "org-1",
      rateLimitTier: "NORMAL",
      apiKeyId: "key-usage-1",
      apiKeyName: "n8n Webflow sync",
      keyPrefix: "mmg_ffffffff",
    });
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    expect(mockLogger.info.mock.calls[0][0]).toEqual({
      msg: "api-key:used",
      apiKeyId: "key-usage-1",
      apiKeyName: "n8n Webflow sync",
      keyPrefix: "mmg_ffffffff",
      organizationId: "org-1",
      tier: "NORMAL",
      ...CTX,
    });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("still validates and logs without a context (script or test caller)", async () => {
    mockDb.apiKey.findUnique.mockResolvedValueOnce(ROW);

    const result = await validateApiKey(RAW);

    expect(result?.apiKeyId).toBe("key-usage-1");
    expect(mockLogger.info.mock.calls[0][0]).toMatchObject({ msg: "api-key:used", apiKeyId: "key-usage-1" });
    expect(mockLogger.info.mock.calls[0][0]).not.toHaveProperty("route");
  });

  it("never writes the credential or its hash into any log line", async () => {
    mockDb.apiKey.findUnique.mockResolvedValueOnce(ROW);
    await validateApiKey(RAW, CTX);

    mockDb.apiKey.findUnique.mockResolvedValueOnce({ ...ROW, isActive: false });
    await validateApiKey(RAW, CTX);

    mockDb.apiKey.findUnique.mockResolvedValueOnce(null);
    await validateApiKey(RAW, CTX);

    const payloads = allLogPayloads();
    expect(payloads.length).toBeGreaterThan(0);
    expect(payloads).not.toContain(RAW);
    expect(payloads).not.toContain(hashApiKey(RAW));
    // The 12-char display prefix is the identity the UI shows; it is fine.
    expect(payloads).toContain("mmg_ffffffff");
  });

  it("logs api-key:refused reason=inactive at warn and does not bump lastUsedAt", async () => {
    mockDb.apiKey.findUnique.mockResolvedValueOnce({ ...ROW, isActive: false });

    expect(await validateApiKey(RAW, CTX)).toBeNull();

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn.mock.calls[0][0]).toMatchObject({
      msg: "api-key:refused",
      reason: "inactive",
      apiKeyId: "key-usage-1",
      apiKeyName: "n8n Webflow sync",
      keyPrefix: "mmg_ffffffff",
      organizationId: "org-1",
      route: CTX.route,
      ip: CTX.ip,
    });
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockDb.apiKey.update).not.toHaveBeenCalled();
  });

  it("logs api-key:refused reason=expired with the expiry", async () => {
    const expiresAt = new Date(Date.now() - 60_000);
    mockDb.apiKey.findUnique.mockResolvedValueOnce({ ...ROW, expiresAt });

    expect(await validateApiKey(RAW, CTX)).toBeNull();

    expect(mockLogger.warn.mock.calls[0][0]).toMatchObject({
      msg: "api-key:refused",
      reason: "expired",
      apiKeyId: "key-usage-1",
      expiresAt: expiresAt.toISOString(),
    });
    expect(mockDb.apiKey.update).not.toHaveBeenCalled();
  });

  it("logs api-key:refused reason=unknown with only the presented prefix", async () => {
    mockDb.apiKey.findUnique.mockResolvedValueOnce(null);

    expect(await validateApiKey(RAW, CTX)).toBeNull();

    const line = mockLogger.warn.mock.calls[0][0];
    expect(line).toMatchObject({ msg: "api-key:refused", reason: "unknown", keyPrefix: "mmg_ffffffff", ...CTX });
    expect(line).not.toHaveProperty("apiKeyId");
    expect(line).not.toHaveProperty("organizationId");
  });

  it("logs nothing and reads nothing for a credential that is not mmg_-shaped", async () => {
    expect(await validateApiKey("eyJhbGciOi.some.jwt", CTX)).toBeNull();
    expect(await validateApiKey("oauth-token-value", CTX)).toBeNull();

    expect(mockDb.apiKey.findUnique).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});

describe("apiKeyUseContext", () => {
  it("records the pathname, method, real client ip and a capped user agent, never the query string", () => {
    const req = new Request("https://events.meetingmindsgroup.com/api/events/evt-1/registrations?q=someone%40hospital.org&status=PAID", {
      method: "GET",
      headers: {
        "x-real-ip": "198.51.100.4",
        "x-forwarded-for": "10.0.0.1, 198.51.100.4",
        "user-agent": "x".repeat(500),
      },
    });

    const ctx = apiKeyUseContext(req, "rest");

    expect(ctx).toEqual({
      surface: "rest",
      method: "GET",
      route: "/api/events/evt-1/registrations",
      ip: "198.51.100.4",
      userAgent: "x".repeat(200),
    });
    expect(JSON.stringify(ctx)).not.toContain("hospital.org");
  });

  it("marks the MCP surface and tolerates a missing user agent", () => {
    const req = new Request("https://events.meetingmindsgroup.com/api/mcp", { method: "POST" });

    expect(apiKeyUseContext(req, "mcp")).toEqual({
      surface: "mcp",
      method: "POST",
      route: "/api/mcp",
      ip: "unknown",
      userAgent: null,
    });
  });
});
