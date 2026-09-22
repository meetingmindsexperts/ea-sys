/**
 * The QuickBooks app credentials endpoint (September 22, 2026).
 *
 * The load-bearing assertions are the two that protect a live connection
 * from a careless save: a blank secret KEEPS the stored one (otherwise
 * editing a client id silently wipes the secret), and a client secret never
 * leaves the server in any response. The rest pins the guard, the redirect
 * URI check and the audit row's shape.
 *
 * NEXTAUTH_SECRET is stubbed because the module encrypts: the local run
 * picks one up from .env through the Prisma client, CI does not, and a test
 * that depends on that difference passes here and fails there.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { guard, mockDb, mockUpdateOrgSettings, mockRateLimit, logger } = vi.hoisted(() => ({
  guard: vi.fn(),
  mockRateLimit: vi.fn(),
  mockDb: { organization: { findUnique: vi.fn() }, auditLog: { create: vi.fn(async () => ({})) } },
  mockUpdateOrgSettings: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: mockDb }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/event-settings", () => ({ updateOrganizationSettings: mockUpdateOrgSettings }));
vi.mock("@/procurement/lib/route-helpers", () => ({ procurementGuard: guard }));
// The real limiter is a per-process in-memory bucket, so a file of PUTs would
// exhaust it and every later test would assert against a 429 instead of the
// behaviour it names. Stubbed open, with one test below that pins the refusal.
vi.mock("@/lib/security", async () => {
  const actual = await vi.importActual<typeof import("@/lib/security")>("@/lib/security");
  return { ...actual, checkRateLimit: mockRateLimit };
});

import { NextResponse } from "next/server";
import { GET, PUT, DELETE } from "@/app/api/integrations/quickbooks/credentials/route";
import { QBO_CALLBACK_PATH, readStoredApp } from "@/procurement/integrations/quickbooks/app";
import { decryptSecret, encryptSecret } from "@/lib/eventsair-client";

const SECRET = "test-secret-for-quickbooks-credentials-tests";
const REDIRECT = `https://app.test${QBO_CALLBACK_PATH}`;

function allow(orgId = "org1", userId = "u1") {
  guard.mockResolvedValue({ ok: true, orgId, user: { id: userId, organizationId: orgId, role: "ADMIN" } });
}
function refuse(status = 403) {
  guard.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Forbidden" }, { status }) });
}

function req(body?: unknown, url = "https://app.test/api/integrations/quickbooks/credentials") {
  return new Request(url, body === undefined ? {} : { method: "PUT", body: JSON.stringify(body) }) as never;
}

/** What the settings blob looks like for an organisation with a saved sandbox app. */
function savedSettings(over: Record<string, unknown> = {}) {
  return {
    quickbooksApp: {
      environment: "sandbox",
      sandbox: { clientId: "old-cid", clientSecretEncrypted: encryptSecret("old-secret"), redirectUri: REDIRECT },
      production: { clientId: null, clientSecretEncrypted: null, redirectUri: null },
      configuredAt: "2026-09-22T09:00:00.000Z",
      configuredByUserId: "u1",
      ...over,
    },
  };
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
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.test");
  allow();
  mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  mockDb.organization.findUnique.mockResolvedValue({ settings: {} });
  mockUpdateOrgSettings.mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());

describe("the guard stands in front of every verb", () => {
  it("refuses GET, PUT and DELETE alike", async () => {
    refuse(403);
    expect((await GET(req())).status).toBe(403);
    expect((await PUT(req({ sandbox: { clientId: "x" } }))).status).toBe(403);
    expect((await DELETE(req())).status).toBe(403);
    expect(mockUpdateOrgSettings).not.toHaveBeenCalled();
  });
});

describe("reading the app", () => {
  it("names the ids, says only WHETHER a secret exists, and suggests a redirect URI", async () => {
    mockDb.organization.findUnique.mockResolvedValue({ settings: savedSettings() });
    const body = await (await GET(req())).json();
    expect(body.app.sandbox).toEqual({ clientId: "old-cid", hasClientSecret: true, redirectUri: REDIRECT });
    expect(body.app.ready).toBe(true);
    expect(body.suggestedRedirectUri).toBe(REDIRECT);
    // The whole point: no secret and no ciphertext ever leaves the server.
    expect(JSON.stringify(body)).not.toContain("old-secret");
    expect(JSON.stringify(body)).not.toContain("clientSecretEncrypted");
  });

  it("an organisation with nothing saved reads as an empty, not-ready app", async () => {
    const body = await (await GET(req())).json();
    expect(body.app.ready).toBe(false);
    expect(body.app.environment).toBe("sandbox");
    expect(body.app.sandbox.hasClientSecret).toBe(false);
  });
});

describe("saving the app", () => {
  it("encrypts the secret rather than storing it in the clear", async () => {
    const written = captureSave({});
    await PUT(req({ sandbox: { clientId: "cid", clientSecret: "plain-secret", redirectUri: REDIRECT } }));
    const stored = readStoredApp(written());
    expect(stored?.sandbox.clientId).toBe("cid");
    expect(stored?.sandbox.clientSecretEncrypted).not.toContain("plain-secret");
    expect(decryptSecret(stored!.sandbox.clientSecretEncrypted!)).toBe("plain-secret");
  });

  it("a BLANK secret keeps the stored one, so editing a client id cannot wipe it", async () => {
    const current = savedSettings();
    const written = captureSave(current);
    await PUT(req({ sandbox: { clientId: "new-cid", clientSecret: "", redirectUri: REDIRECT } }));
    const stored = readStoredApp(written());
    expect(stored?.sandbox.clientId).toBe("new-cid");
    expect(decryptSecret(stored!.sandbox.clientSecretEncrypted!)).toBe("old-secret");
  });

  it("an explicit null CLEARS the secret, which a blank must never do", async () => {
    const written = captureSave(savedSettings());
    await PUT(req({ sandbox: { clientSecret: null } }));
    expect(readStoredApp(written())?.sandbox.clientSecretEncrypted).toBeNull();
  });

  it("the other environment is untouched by a save to this one", async () => {
    const current = savedSettings({
      production: { clientId: "prod-cid", clientSecretEncrypted: encryptSecret("prod-secret"), redirectUri: `https://live.test${QBO_CALLBACK_PATH}` },
    });
    const written = captureSave(current);
    await PUT(req({ sandbox: { clientId: "changed" } }));
    const stored = readStoredApp(written());
    expect(stored?.production.clientId).toBe("prod-cid");
    expect(decryptSecret(stored!.production.clientSecretEncrypted!)).toBe("prod-secret");
  });

  it("every other settings key survives the save", async () => {
    const written = captureSave({ zoom: { accountId: "z" }, quickbooks: { realmId: "r" } });
    await PUT(req({ sandbox: { clientId: "cid" } }));
    expect(written()).toMatchObject({ zoom: { accountId: "z" }, quickbooks: { realmId: "r" } });
  });

  it("refuses a redirect URI that could only ever fail at Intuit", async () => {
    // Not a URL at all.
    let res = await PUT(req({ sandbox: { redirectUri: "not a url" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_REDIRECT_URI");

    // The right shape pointing at a route we do not serve.
    res = await PUT(req({ sandbox: { redirectUri: "https://app.test/somewhere-else" } }));
    expect(res.status).toBe(400);

    // http is fine for development and impossible for production.
    res = await PUT(req({ production: { redirectUri: `http://app.test${QBO_CALLBACK_PATH}` } }));
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("production.redirectUri");

    expect(mockUpdateOrgSettings).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("a production URI is checked against production rules even while sandbox is live", async () => {
    // The pair being edited decides the rule, not the pair currently in use:
    // someone filling production in advance must still be told http cannot work.
    mockDb.organization.findUnique.mockResolvedValue({ settings: savedSettings() });
    const res = await PUT(req({ production: { redirectUri: `http://live.test${QBO_CALLBACK_PATH}` } }));
    expect(res.status).toBe(400);
  });

  it("refuses an unknown field rather than silently dropping it", async () => {
    const res = await PUT(req({ sandbox: { clientId: "cid", realmId: "sneaky" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_INPUT");
  });

  it("switching the live environment is its own save and touches no credential", async () => {
    const written = captureSave(savedSettings());
    await PUT(req({ environment: "production" }));
    const stored = readStoredApp(written());
    expect(stored?.environment).toBe("production");
    expect(stored?.sandbox.clientId).toBe("old-cid");
  });

  it("records WHICH fields changed, the client id in full and the secret as a bare rotation", async () => {
    mockDb.organization.findUnique.mockResolvedValue({ settings: savedSettings() });
    captureSave(savedSettings());
    await PUT(req({ sandbox: { clientId: "new-cid", clientSecret: "brand-new-secret" } }));

    const call = mockDb.auditLog.create.mock.calls[0] as unknown as [{ data: { changes: Record<string, unknown> } }];
    const changes = call[0].data.changes;
    const changed = changes.changed as Record<string, unknown>;
    expect(changed["sandbox.clientId"]).toEqual({ from: "old-cid", to: "new-cid" });
    // A client id is not a secret; a client secret is never recorded, not even a prefix.
    expect(changed["sandbox.clientSecret"]).toEqual({ rotated: true });
    expect(JSON.stringify(changes)).not.toContain("brand-new-secret");
  });

  it("is rate limited, so a leaked session cannot grind through credentials", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 900 });
    const res = await PUT(req({ sandbox: { clientId: "cid" } }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("900");
    expect(mockUpdateOrgSettings).not.toHaveBeenCalled();
  });

  it("a failed audit write does not turn a successful save into a 500", async () => {
    captureSave({});
    mockDb.auditLog.create.mockRejectedValueOnce(new Error("audit table down"));
    const res = await PUT(req({ sandbox: { clientId: "cid" } }));
    expect(res.status).toBe(200);
  });
});

describe("removing the app", () => {
  it("clears one environment and leaves the other standing", async () => {
    const current = savedSettings({
      production: { clientId: "prod-cid", clientSecretEncrypted: encryptSecret("prod-secret"), redirectUri: `https://live.test${QBO_CALLBACK_PATH}` },
    });
    const written = captureSave(current);
    await DELETE(req(undefined, "https://app.test/api/integrations/quickbooks/credentials?environment=sandbox"));
    const stored = readStoredApp(written());
    expect(stored?.sandbox).toEqual({ clientId: null, clientSecretEncrypted: null, redirectUri: null });
    expect(stored?.production.clientId).toBe("prod-cid");
  });

  it("with no environment named it removes the whole app", async () => {
    const written = captureSave({ ...savedSettings(), zoom: { accountId: "z" } });
    await DELETE(req());
    expect(written()).not.toHaveProperty("quickbooksApp");
    expect(written()).toMatchObject({ zoom: { accountId: "z" } });
  });

  it("a nonsense environment is a logged 400, never a silent whole-app wipe", async () => {
    const res = await DELETE(req(undefined, "https://app.test/api/integrations/quickbooks/credentials?environment=staging"));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_ENVIRONMENT");
    expect(mockUpdateOrgSettings).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
