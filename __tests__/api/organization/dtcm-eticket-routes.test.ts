/**
 * The organisation's DET eTicketing credentials and connection test
 * (docs/DTCM_ETICKET_PLAN.md step 1). Pins: no secret or ciphertext in any
 * response, secrets stored encrypted, first save needs both secrets, blank
 * keeps the stored value, one environment per save, the active environment,
 * and the test route's refusals. DET itself is never called (the client is
 * mocked).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, orgFindUnique, mockUpdateOrgSettings, mockCheckRateLimit, mockApiLogger, client } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  orgFindUnique: vi.fn(),
  mockUpdateOrgSettings: vi.fn(),
  mockCheckRateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  client: { getDetAccessToken: vi.fn(), getDetPerformance: vi.fn(), clearDetTokenCache: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({
  db: { organization: { findUnique: orgFindUnique }, auditLog: { create: vi.fn().mockResolvedValue({}) } },
}));
vi.mock("@/lib/event-settings", () => ({ updateOrganizationSettings: mockUpdateOrgSettings }));
vi.mock("@/lib/security", () => ({ checkRateLimit: mockCheckRateLimit, getClientIp: () => "127.0.0.1" }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/dtcm-eticket/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dtcm-eticket/client")>()),
  getDetAccessToken: client.getDetAccessToken,
  getDetPerformance: client.getDetPerformance,
  clearDetTokenCache: client.clearDetTokenCache,
}));

import { GET, PUT, DELETE } from "@/app/api/organization/dtcm-eticket/credentials/route";
import { POST as TEST } from "@/app/api/organization/dtcm-eticket/test-connection/route";
import { DetApiError } from "@/lib/dtcm-eticket/client";
import { decryptSecret, encryptSecret } from "@/lib/eventsair-client";

const ORG = "org1";
const adminSession = { user: { id: "u1", organizationId: ORG, role: "ADMIN" } };
const json = (method: string, body: unknown) =>
  new Request("http://localhost/api", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** The org settings as stored; the update mock applies patches to it, as the real helper does. */
let stored: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || "test-secret-for-crypto";
  stored = { other: "kept" };
  mockAuth.mockResolvedValue(adminSession);
  mockCheckRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  orgFindUnique.mockImplementation(async () => ({ settings: stored }));
  mockUpdateOrgSettings.mockImplementation(async (_id: string, patch: unknown) => {
    stored = typeof patch === "function" ? (patch as (c: Record<string, unknown>) => Record<string, unknown>)(stored) : { ...stored, ...(patch as object) };
    return stored;
  });
});

const det = () => stored.dtcmEticket as Record<string, Record<string, string> | string>;

describe("credentials", () => {
  it("refuses callers without org.credentials, and without an organisation", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u2", organizationId: ORG, role: "MEMBER" } });
    expect((await GET()).status).toBe(403);
    mockAuth.mockResolvedValue({ user: { id: "u3", organizationId: null, role: "SUPER_ADMIN" } });
    expect((await PUT(json("PUT", { environment: "staging", clientId: "AMMEE1" }))).status).toBe(401);
  });

  it("refuses a first save without both secrets, and writes nothing", async () => {
    const res = await PUT(json("PUT", { environment: "staging", clientId: "AMMEE1", clientSecret: "s" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("CREDENTIALS_INCOMPLETE");
    expect(stored.dtcmEticket).toBeUndefined();
  });

  it("stores the secrets encrypted, makes the environment active, keeps other settings", async () => {
    const res = await PUT(json("PUT", { environment: "staging", clientId: " AMMEE1 ", clientSecret: " sec-1\n", apiKey: "key-abcd" }));
    expect(res.status).toBe(200);
    const staging = det().staging as Record<string, string>;
    expect(staging.clientId).toBe("AMMEE1");
    expect(staging.clientSecretEncrypted).not.toContain("sec-1");
    expect(decryptSecret(staging.clientSecretEncrypted)).toBe("sec-1");
    expect(decryptSecret(staging.apiKeyEncrypted)).toBe("key-abcd");
    expect(det().activeEnvironment).toBe("staging");
    expect(stored.other).toBe("kept");
    expect(client.clearDetTokenCache).toHaveBeenCalled();
  });

  it("never returns a secret or its ciphertext", async () => {
    await PUT(json("PUT", { environment: "staging", clientId: "AMMEE1", clientSecret: "sec-1", apiKey: "key-abcd" }));
    const body = JSON.stringify(await (await GET()).json());
    expect(body).not.toContain("sec-1");
    expect(body).not.toContain("key-abcd");
    expect(body).not.toContain((det().staging as Record<string, string>).clientSecretEncrypted);
    expect(JSON.parse(body)).toMatchObject({
      activeEnvironment: "staging",
      staging: { configured: true, clientId: "AMMEE1", hasClientSecret: true, apiKeyLast4: "abcd" },
      production: { configured: false },
    });
  });

  it("keeps stored secrets when a later save leaves them blank, and leaves the other environment alone", async () => {
    stored = {
      dtcmEticket: {
        activeEnvironment: "staging",
        staging: { clientId: "AMMEE1", clientSecretEncrypted: encryptSecret("old"), apiKeyEncrypted: encryptSecret("k1"), apiKeyLast4: "k1" },
      },
    };
    const before = det().staging;
    await PUT(json("PUT", { environment: "production", clientId: "AMMEE1", clientSecret: "prod-s", apiKey: "prod-k" }));
    expect(det().staging).toEqual(before);
    expect(det().activeEnvironment).toBe("production");

    await PUT(json("PUT", { environment: "staging", clientId: "AMMEE2" }));
    const staging = det().staging as Record<string, string>;
    expect(staging.clientId).toBe("AMMEE2");
    expect(decryptSecret(staging.clientSecretEncrypted)).toBe("old");
    expect(det().activeEnvironment).toBe("staging");
  });

  it("DELETE removes only the DET block", async () => {
    stored = { other: "kept", dtcmEticket: { activeEnvironment: "staging" } };
    expect((await DELETE(new Request("http://localhost/api", { method: "DELETE" }))).status).toBe(200);
    expect(stored).toEqual({ other: "kept" });
  });

  it("rate-limits saves with Retry-After", async () => {
    mockCheckRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 42 });
    const res = await PUT(json("PUT", { environment: "staging", clientId: "AMMEE1" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
  });
});

describe("test connection", () => {
  const saveStaging = () =>
    PUT(json("PUT", { environment: "staging", clientId: "AMMEE1", clientSecret: "sec-1", apiKey: "key-abcd" }));

  it("refuses an environment with no saved credentials, without calling DET", async () => {
    const res = await TEST(json("POST", { environment: "production" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NOT_CONFIGURED");
    expect(client.getDetAccessToken).not.toHaveBeenCalled();
  });

  it("refuses a malformed performance code before calling DET", async () => {
    await saveStaging();
    const res = await TEST(json("POST", { performanceCode: "PDUB 01" }));
    expect(res.status).toBe(400);
    expect(client.getDetAccessToken).not.toHaveBeenCalled();
  });

  it("checks the token and the performance with the decrypted credentials", async () => {
    await saveStaging();
    client.getDetAccessToken.mockResolvedValue("tok");
    client.getDetPerformance.mockResolvedValue({ performanceCode: "PDUB01DEC2023B", name: "Batch 3", sections: [], priceTypes: [] });
    const res = await TEST(json("POST", { performanceCode: "pdub01dec2023b" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, environment: "staging", performance: { name: "Batch 3" } });
    const [credsArg, code] = client.getDetPerformance.mock.calls[0];
    expect(credsArg).toMatchObject({ clientId: "AMMEE1", clientSecret: "sec-1", apiKey: "key-abcd", environment: "staging" });
    expect(code).toBe("PDUB01DEC2023B");
  });

  it("explains a production token failure as the IP whitelist", async () => {
    await PUT(json("PUT", { environment: "production", clientId: "AMMEE1", clientSecret: "s", apiKey: "k" }));
    client.getDetAccessToken.mockRejectedValue(new DetApiError("DET token could not be reached", "token", null));
    const res = await TEST(json("POST", {}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, environment: "production", stage: "token" });
    expect(body.error).toContain("whitelisted");
    expect(mockApiLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "dtcm-eticket:test-connection-failed" }));
  });
});
