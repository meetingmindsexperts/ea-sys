/**
 * The QuickBooks connector's foundations (September 22, 2026): which Intuit
 * app a deployment talks to, the signed state that ties the callback to the
 * person who started it, the stored per-organisation connection, and the
 * read client.
 *
 * NEXTAUTH_SECRET is stubbed in every block that signs or encrypts: the
 * local run picks one up from .env through the Prisma client, CI does not,
 * and a test that depends on that difference passes here and fails there.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDb, mockUpdateOrgSettings } = vi.hoisted(() => ({
  mockDb: { organization: { findUnique: vi.fn() } },
  mockUpdateOrgSettings: vi.fn(async () => ({})),
}));
vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/event-settings", () => ({ updateOrganizationSettings: mockUpdateOrgSettings }));

import { encryptSecret } from "@/lib/eventsair-client";
import { qboApiBase } from "@/procurement/integrations/quickbooks/config";
import { QBO_CALLBACK_PATH, readStoredApp, resolveStoredApp, toAppStatus, validateRedirectUri } from "@/procurement/integrations/quickbooks/app";
import { mintConnectState, verifyConnectState } from "@/procurement/integrations/quickbooks/state";
import { getAccessToken, readConnection, toStatus } from "@/procurement/integrations/quickbooks/connection";
import { listAccounts, listClasses, qboQuery } from "@/procurement/integrations/quickbooks/client";

const SECRET = "test-secret-for-quickbooks-unit-tests";
const REDIRECT = `https://x.test${QBO_CALLBACK_PATH}`;
const APP = { clientId: "cid", clientSecret: "csec", redirectUri: REDIRECT, environment: "sandbox" as const };

/** The app block as it sits in `Organization.settings.quickbooksApp`. */
function storedApp(over: Record<string, unknown> = {}) {
  return {
    environment: "sandbox",
    sandbox: { clientId: "cid", clientSecretEncrypted: encryptSecret("csec"), redirectUri: REDIRECT },
    production: { clientId: null, clientSecretEncrypted: null, redirectUri: null },
    configuredAt: "2026-09-22T09:00:00.000Z",
    configuredByUserId: "u1",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXTAUTH_SECRET", SECRET);
});
afterEach(() => vi.unstubAllEnvs());

describe("which Intuit app an organisation talks to", () => {
  it("resolves the live environment's pair, and its base URL", () => {
    expect(resolveStoredApp(readStoredApp({ quickbooksApp: storedApp() }))).toEqual(APP);
    expect(qboApiBase("sandbox")).toBe("https://sandbox-quickbooks.api.intuit.com");
    expect(qboApiBase("production")).toBe("https://quickbooks.api.intuit.com");
  });

  it("is null on a partial pair, so nothing half-configured reaches Intuit", () => {
    const partial = storedApp({ sandbox: { clientId: "cid", clientSecretEncrypted: encryptSecret("csec"), redirectUri: null } });
    expect(resolveStoredApp(readStoredApp({ quickbooksApp: partial }))).toBeNull();
  });

  it("is null for an organisation with nothing saved (production today)", () => {
    expect(readStoredApp({})).toBeNull();
    expect(readStoredApp(null)).toBeNull();
    expect(resolveStoredApp(null)).toBeNull();
  });

  it("only an explicit 'production' is production: a corrupt value reads as sandbox, never the other way", () => {
    expect(readStoredApp({ quickbooksApp: storedApp({ environment: "produciton" }) })?.environment).toBe("sandbox");
    expect(readStoredApp({ quickbooksApp: storedApp({ environment: "production" }) })?.environment).toBe("production");
  });

  it("each environment keeps its own pair, so both can be held at once", () => {
    const both = storedApp({
      environment: "production",
      production: { clientId: "prod-cid", clientSecretEncrypted: encryptSecret("prod-sec"), redirectUri: "https://events.test" + QBO_CALLBACK_PATH },
    });
    expect(resolveStoredApp(readStoredApp({ quickbooksApp: both }))).toEqual({
      clientId: "prod-cid",
      clientSecret: "prod-sec",
      redirectUri: "https://events.test" + QBO_CALLBACK_PATH,
      environment: "production",
    });
  });

  it("the safe view names the ids and never the secret", () => {
    const status = toAppStatus(readStoredApp({ quickbooksApp: storedApp() }));
    expect(status.sandbox).toEqual({ clientId: "cid", hasClientSecret: true, redirectUri: REDIRECT });
    expect(status.production).toEqual({ clientId: null, hasClientSecret: false, redirectUri: null });
    expect(status.ready).toBe(true);
    expect(JSON.stringify(status)).not.toContain("csec");
  });

  it("a redirect URI is refused here rather than at Intuit's consent screen", () => {
    expect(validateRedirectUri(REDIRECT, "sandbox")).toBeNull();
    // Development may be http, which is what makes localhost work at all.
    expect(validateRedirectUri(`http://localhost:3113${QBO_CALLBACK_PATH}`, "sandbox")).toBeNull();
    // A trailing slash is the same route to Next, so it must not be refused.
    expect(validateRedirectUri(`${REDIRECT}/`, "sandbox")).toBeNull();
    expect(validateRedirectUri(`http://x.test${QBO_CALLBACK_PATH}`, "production")).toContain("https");
    expect(validateRedirectUri("not a url", "sandbox")).toContain("full URL");
    expect(validateRedirectUri("https://x.test/somewhere-else", "sandbox")).toContain(QBO_CALLBACK_PATH);
  });
});

describe("the connect state", () => {
  const subject = { organizationId: "org1", userId: "u1" };

  it("round-trips the organisation and the person", () => {
    const v = verifyConnectState(mintConnectState(subject));
    expect(v).toEqual({ ok: true, ...subject });
  });

  it("refuses a tampered payload, a tampered signature and a malformed token", () => {
    const token = mintConnectState(subject);
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ v: 1, organizationId: "org2", userId: "u1", exp: 9e9, jti: "x" })).toString("base64url");
    expect(verifyConnectState(`${forged}.${sig}`).ok, "another org's payload under this signature").toBe(false);
    expect(verifyConnectState(`${body}.${sig}x`).ok, "a signature of a different length").toBe(false);
    expect(verifyConnectState("nonsense").ok).toBe(false);
    expect(verifyConnectState("").ok).toBe(false);
  });

  it("expires", () => {
    const token = mintConnectState(subject, 1_000_000);
    expect(verifyConnectState(token, 1_000_000 + 9 * 60_000).ok).toBe(true);
    expect(verifyConnectState(token, 1_000_000 + 11 * 60_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("a state signed under a different secret does not verify", () => {
    const token = mintConnectState(subject);
    vi.stubEnv("NEXTAUTH_SECRET", "a-completely-different-secret");
    expect(verifyConnectState(token)).toEqual({ ok: false, reason: "bad_signature" });
  });
});

function storedConnection(over: Record<string, unknown> = {}, appOver?: Record<string, unknown> | null) {
  return {
    ...(appOver === null ? {} : { quickbooksApp: storedApp(appOver ?? {}) }),
    quickbooks: {
      realmId: "realm-1",
      environment: "sandbox",
      accessTokenEncrypted: encryptSecret("access-token"),
      refreshTokenEncrypted: encryptSecret("refresh-token"),
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 90 * 24 * 3600_000).toISOString(),
      connectedAt: "2026-09-22T10:00:00.000Z",
      connectedByUserId: "u1",
      ...over,
    },
  };
}

describe("the stored connection", () => {
  it("reads a stored block and ignores anything without a realm or tokens", () => {
    expect(readConnection(storedConnection())?.realmId).toBe("realm-1");
    expect(readConnection({ quickbooks: { realmId: "r" } })).toBeNull();
    expect(readConnection({})).toBeNull();
    expect(readConnection(null)).toBeNull();
  });

  it("the status view carries no token, ever", () => {
    const status = toStatus(readConnection(storedConnection()), APP);
    expect(status.connected).toBe(true);
    expect(JSON.stringify(status)).not.toContain("access-token");
    expect(JSON.stringify(status)).not.toContain("refresh-token");
    expect(Object.keys(status).some((k) => /token/i.test(k) && !/ExpiresAt$/.test(k))).toBe(false);
  });

  it("a connection from the other environment reads as NOT connected", () => {
    const status = toStatus(readConnection(storedConnection({ environment: "production" })), APP);
    expect(status.environmentMismatch).toBe(true);
    expect(status.connected).toBe(false);
  });

  it("a connection minted by a DIFFERENT client id reads as not connected, so an edit is visible", () => {
    const status = toStatus(readConnection(storedConnection({ clientId: "an-older-client-id" })), APP);
    expect(status.appMismatch).toBe(true);
    expect(status.connected).toBe(false);
  });

  it("a connection recorded before the client id was stored is unknown, never a mismatch", () => {
    const status = toStatus(readConnection(storedConnection()), APP);
    expect(status.appMismatch).toBe(false);
    expect(status.connected).toBe(true);
  });
});

describe("getAccessToken", () => {

  it("returns the stored token while it is still good, without calling Intuit", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mockDb.organization.findUnique.mockResolvedValue({ settings: storedConnection() });
    const res = await getAccessToken("org1");
    expect(res.ok && res.accessToken).toBe("access-token");
    expect(res.ok && res.realmId).toBe("realm-1");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("refreshes when the access token is inside the skew, and STORES the rotated pair before using it", async () => {
    mockDb.organization.findUnique.mockResolvedValue({
      settings: storedConnection({ accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString() }),
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, x_refresh_token_expires_in: 8_640_000 }), { status: 200 }),
    );
    const res = await getAccessToken("org1");
    expect(res.ok && res.accessToken).toBe("new-access");
    // A refresh rotates the refresh token at Intuit, so a crash before the write
    // would strand the connection: the write must happen, and before the return.
    expect(mockUpdateOrgSettings).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it("names the cause rather than throwing: not configured, not connected, wrong environment, dead refresh token", async () => {
    mockDb.organization.findUnique.mockResolvedValue({ settings: storedConnection({}, null) });
    expect(await getAccessToken("org1")).toMatchObject({ ok: false, code: "NOT_CONFIGURED" });

    mockDb.organization.findUnique.mockResolvedValue({ settings: { quickbooksApp: storedApp() } });
    expect(await getAccessToken("org1")).toMatchObject({ ok: false, code: "NOT_CONNECTED" });

    mockDb.organization.findUnique.mockResolvedValue({ settings: storedConnection({ environment: "production" }) });
    expect(await getAccessToken("org1")).toMatchObject({ ok: false, code: "ENVIRONMENT_MISMATCH" });

    mockDb.organization.findUnique.mockResolvedValue({
      settings: storedConnection({
        accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
        refreshTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    });
    expect(await getAccessToken("org1")).toMatchObject({ ok: false, code: "REFRESH_EXPIRED" });

    // The app credentials were edited after the connection was made, so the
    // stored tokens belong to an app that no longer exists here.
    mockDb.organization.findUnique.mockResolvedValue({ settings: storedConnection({ clientId: "an-older-client-id" }) });
    expect(await getAccessToken("org1")).toMatchObject({ ok: false, code: "APP_CHANGED" });
  });
});

describe("the read client", () => {
  beforeEach(() => {
    mockDb.organization.findUnique.mockResolvedValue({ settings: storedConnection() });
  });

  it("addresses the realm on the environment's base URL, with the pinned minor version and a bearer token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ QueryResponse: { Class: [{ Id: "1", Name: "GLD-READ", Active: true }] } }), { status: 200 }),
    );
    const res = await listClasses("org1");
    expect(res.ok && res.data).toEqual([{ id: "1", name: "GLD-READ", fullyQualifiedName: null, active: true }]);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("https://sandbox-quickbooks.api.intuit.com/v3/company/realm-1/query");
    expect(url).toContain("minorversion=");
    expect(url).toContain(encodeURIComponent("SELECT * FROM Class"));
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer access-token");
    fetchSpy.mockRestore();
  });

  it("an empty result set is an empty list, not a failure (QuickBooks omits the key)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ QueryResponse: {} }), { status: 200 }));
    const res = await listAccounts("org1");
    expect(res).toEqual({ ok: true, data: [] });
    fetchSpy.mockRestore();
  });

  it("an HTTP failure and an unparsable body are values with a code, never throws", async () => {
    let fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unauthorized", { status: 401 }));
    expect(await qboQuery("org1", "SELECT * FROM Class", "Class")).toMatchObject({ ok: false, code: "HTTP_ERROR", status: 401 });
    fetchSpy.mockRestore();

    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>gateway</html>", { status: 200 }));
    expect(await qboQuery("org1", "SELECT * FROM Class", "Class")).toMatchObject({ ok: false, code: "MALFORMED" });
    fetchSpy.mockRestore();

    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("socket hang up"));
    expect(await qboQuery("org1", "SELECT * FROM Class", "Class")).toMatchObject({ ok: false, code: "NETWORK" });
    fetchSpy.mockRestore();
  });

  it("maps the account fields a chart of accounts screen shows", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          QueryResponse: {
            Account: [{ Id: "7", Name: "Venue", AcctNum: "510400", AccountType: "Cost of Goods Sold", AccountSubType: "SuppliesMaterialsCogs", Classification: "Expense", Active: false, FullyQualifiedName: "Cost of Sales:Venue" }],
          },
        }),
        { status: 200 },
      ),
    );
    const res = await listAccounts("org1");
    expect(res.ok && res.data[0]).toEqual({
      id: "7",
      name: "Venue",
      acctNum: "510400",
      accountType: "Cost of Goods Sold",
      accountSubType: "SuppliesMaterialsCogs",
      classification: "Expense",
      active: false,
      fullyQualifiedName: "Cost of Sales:Venue",
    });
    fetchSpy.mockRestore();
  });
});

describe("who may link the accounting system", () => {
  // Owner ruling, 22 September 2026: "any admin can connect", wider than the
  // spec's settle-grant rule and narrower than canAdminProcurement.
  it("admits ADMIN and SUPER_ADMIN by role alone, and nobody else", async () => {
    const { canManageAccountingIntegration } = await import("@/lib/procurement-visibility");
    for (const role of ["ADMIN", "SUPER_ADMIN"]) {
      expect(canManageAccountingIntegration({ role } as never), role).toBe(true);
    }
    for (const role of ["ORGANIZER", "MEMBER", "ONSITE", "WEBINARS", "CRM_USER", "HR_USER", "REVIEWER", "SUBMITTER", "REGISTRANT"]) {
      expect(canManageAccountingIntegration({ role } as never), role).toBe(false);
    }
    expect(canManageAccountingIntegration(null)).toBe(false);
    expect(canManageAccountingIntegration({ role: null } as never)).toBe(false);
  });

  it("a procurement grant or a custom-role key is NOT a licence to bind an accounting system", async () => {
    const { canManageAccountingIntegration } = await import("@/lib/procurement-visibility");
    expect(canManageAccountingIntegration({ role: "ORGANIZER", procurementSettle: true } as never)).toBe(false);
    expect(canManageAccountingIntegration({ role: "ORGANIZER", procurementApproveUnlimited: true } as never)).toBe(false);
    expect(canManageAccountingIntegration({ role: "ORGANIZER", procurementPermissions: ["procurement.requests.manage"] } as never)).toBe(false);
  });
});
