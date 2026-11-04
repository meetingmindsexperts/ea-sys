/**
 * EventsAir credentials and connection test (Nov 4, 2026 integrations review,
 * INT-4): both are rate limited per organisation like their Zoom, Stripe and
 * AI siblings, and a save leaves an AuditLog row that names who changed the
 * client id and that the secret rotated, never the secret or its ciphertext.
 *
 * NEXTAUTH_SECRET is stubbed because the route encrypts: the local run picks
 * one up from .env through the Prisma client, CI does not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockAuth, mockDb, mockUpdateOrgSettings, mockRateLimit, mockTest, logger } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { organization: { findUnique: vi.fn() }, auditLog: { create: vi.fn(async () => ({})) } },
  mockUpdateOrgSettings: vi.fn(),
  mockRateLimit: vi.fn(),
  mockTest: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/event-settings", () => ({ updateOrganizationSettings: mockUpdateOrgSettings }));
vi.mock("@/lib/permissions/require-permission", () => ({ requirePermission: () => ({ ok: true }) }));
// The real limiter is a per-process bucket; stubbed open, with tests that pin the refusal.
vi.mock("@/lib/security", async () => {
  const actual = await vi.importActual<typeof import("@/lib/security")>("@/lib/security");
  return { ...actual, checkRateLimit: mockRateLimit };
});
vi.mock("@/lib/eventsair-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/eventsair-client")>("@/lib/eventsair-client");
  return { ...actual, testConnection: mockTest };
});

import { PUT } from "@/app/api/organization/eventsair/credentials/route";
import { POST as testPost } from "@/app/api/organization/eventsair/test-connection/route";
import { encryptSecret } from "@/lib/eventsair-client";

const SECRET = "test-secret-for-eventsair-credentials-tests";

function put(body: unknown) {
  return PUT(new Request("https://app.test/api/organization/eventsair/credentials", { method: "PUT", body: JSON.stringify(body) }));
}

/** Run the real merge the way `updateOrganizationSettings` would, and hand back what was written. */
function captureSave(current: Record<string, unknown>) {
  let written: Record<string, unknown> | null = null;
  mockUpdateOrgSettings.mockImplementation(async (_org: string, patch: unknown) => {
    written = typeof patch === "function" ? (patch as (c: Record<string, unknown>) => Record<string, unknown>)(current) : { ...current, ...(patch as object) };
    return written;
  });
  return () => written;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXTAUTH_SECRET", SECRET);
  mockAuth.mockResolvedValue({ user: { id: "u1", organizationId: "org1", role: "ADMIN" } });
  mockRateLimit.mockReturnValue({ allowed: true, remaining: 9, retryAfterSeconds: 0 });
});
afterEach(() => vi.unstubAllEnvs());

describe("saving EventsAir credentials", () => {
  it("keeps the other settings and audits a client id change as fingerprints, the secret only as rotated", async () => {
    const written = captureSave({ zoom: { clientId: "z" }, eventsAir: { clientId: "old-client-id", clientSecretEncrypted: encryptSecret("old") } });
    const res = await put({ clientId: "new-client-id-123", clientSecret: "brand-new-secret" });
    expect(res.status).toBe(200);
    expect(written()?.zoom).toEqual({ clientId: "z" });

    const row = (mockDb.auditLog.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(row).toMatchObject({ userId: "u1", organizationId: "org1", action: "UPDATE_EVENTSAIR_CREDENTIALS", entityId: "org1" });
    expect(row.changes).toEqual({
      clientId: { from: "old-cl…(13)", to: "new-cl…(17)" },
      clientSecret: { rotated: true },
    });
    const stored = (written()?.eventsAir as { clientSecretEncrypted: string }).clientSecretEncrypted;
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain("brand-new-secret");
    expect(serialised).not.toContain(stored);
  });

  it("says the client id is unchanged when only the secret was replaced", async () => {
    captureSave({ eventsAir: { clientId: "same-client-id" } });
    await put({ clientId: "same-client-id", clientSecret: "s2" });
    const row = (mockDb.auditLog.create.mock.calls[0] as unknown as [{ data: { changes: unknown } }])[0].data;
    expect(row.changes).toEqual({ clientId: { unchanged: "same-c…(14)" }, clientSecret: { rotated: true } });
  });

  it("a failed audit write does not turn a saved change into an error", async () => {
    captureSave({});
    mockDb.auditLog.create.mockRejectedValueOnce(new Error("db down"));
    const res = await put({ clientId: "cid", clientSecret: "s" });
    expect(res.status).toBe(200);
    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "eventsair:credentials-audit-failed" })),
    );
  });

  it("is rate limited per organisation, with the documented 429 body, and writes nothing", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterSeconds: 120 });
    const res = await put({ clientId: "cid", clientSecret: "s" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
    expect(await res.json()).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 120, limit: 10, windowSeconds: 3600 });
    expect(mockRateLimit).toHaveBeenCalledWith(expect.objectContaining({ key: "eventsair-creds:org1" }));
    expect(mockUpdateOrgSettings).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("invalid input changes nothing and leaves no audit row", async () => {
    const res = await put({ clientId: "", clientSecret: "" });
    expect(res.status).toBe(400);
    expect(mockUpdateOrgSettings).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("testing the EventsAir connection", () => {
  it("is rate limited per organisation before EventsAir is called", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterSeconds: 60 });
    const res = await testPost();
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "RATE_LIMITED", limit: 30, windowSeconds: 3600 });
    expect(mockRateLimit).toHaveBeenCalledWith(expect.objectContaining({ key: "eventsair-test:org1" }));
    expect(mockTest).not.toHaveBeenCalled();
    expect(mockDb.organization.findUnique).not.toHaveBeenCalled();
  });

  it("tests the stored credentials when under the limit", async () => {
    mockDb.organization.findUnique.mockResolvedValue({ settings: { eventsAir: { clientId: "cid", clientSecretEncrypted: encryptSecret("sec") } } });
    mockTest.mockResolvedValue(true);
    const res = await testPost();
    expect(await res.json()).toEqual({ connected: true });
    expect(mockTest).toHaveBeenCalledWith({ clientId: "cid", clientSecret: "sec" });
  });
});
