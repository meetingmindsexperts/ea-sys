/**
 * The QuickBooks connector's HTTP surface (September 22, 2026).
 *
 * The load-bearing assertion is the callback's: Intuit hands `state` back
 * and it is the ONLY thing tying the redirect to the person who started
 * it, so a state naming another organisation must not attach a QuickBooks
 * company to this one. The rest pins the guard, the "not configured"
 * answers and the failure-to-status map.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { guard, mockStoreNew, mockLoad, mockClear, mockExchange, mockRevoke, mockHealth, mockClasses, mockAccounts, logger } = vi.hoisted(() => ({
  guard: vi.fn(),
  mockStoreNew: vi.fn(async () => {}),
  mockLoad: vi.fn(),
  mockClear: vi.fn(async () => {}),
  mockExchange: vi.fn(),
  mockRevoke: vi.fn(async () => true),
  mockHealth: vi.fn(),
  mockClasses: vi.fn(),
  mockAccounts: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/db", () => ({ db: {}, dbOperator: {} }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/procurement/lib/route-helpers", () => ({ procurementGuard: guard }));
vi.mock("@/procurement/integrations/quickbooks/connection", async () => {
  const actual = await vi.importActual<typeof import("@/procurement/integrations/quickbooks/connection")>(
    "@/procurement/integrations/quickbooks/connection",
  );
  return { ...actual, storeNewConnection: mockStoreNew, loadConnection: mockLoad, clearConnection: mockClear };
});
vi.mock("@/procurement/integrations/quickbooks/oauth", async () => {
  const actual = await vi.importActual<typeof import("@/procurement/integrations/quickbooks/oauth")>(
    "@/procurement/integrations/quickbooks/oauth",
  );
  return { ...actual, exchangeCode: mockExchange, revokeToken: mockRevoke };
});
vi.mock("@/procurement/integrations/quickbooks/client", () => ({
  runHealthCheck: mockHealth,
  listClasses: mockClasses,
  listAccounts: mockAccounts,
}));

import { NextResponse } from "next/server";
import { GET as statusGet, DELETE as disconnectDelete } from "@/app/api/integrations/quickbooks/route";
import { GET as connectGet } from "@/app/api/integrations/quickbooks/connect/route";
import { GET as callbackGet } from "@/app/api/integrations/quickbooks/callback/route";
import { POST as testPost } from "@/app/api/integrations/quickbooks/test/route";
import { GET as chartGet } from "@/app/api/integrations/quickbooks/chart/route";
import { mintConnectState } from "@/procurement/integrations/quickbooks/state";

const SECRET = "test-secret-for-quickbooks-route-tests";

function allow(orgId = "org1", userId = "u1") {
  guard.mockResolvedValue({ ok: true, orgId, user: { id: userId, organizationId: orgId, role: "ADMIN" } });
}
function refuse(status = 403) {
  guard.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Forbidden" }, { status }) });
}
function sandboxEnv() {
  vi.stubEnv("QUICKBOOKS_SANDBOX_CLIENT_ID", "cid");
  vi.stubEnv("QUICKBOOKS_SANDBOX_CLIENT_SECRET", "csec");
  vi.stubEnv("QUICKBOOKS_SANDBOX_REDIRECT_URI", "https://x.test/cb");
  vi.stubEnv("QUICKBOOKS_SANDBOX_ENVIRONMENT", "sandbox");
  vi.stubEnv("QUICKBOOKS_ENVIRONMENT", "");
}
/** The callback is a browser navigation: a `req` is all it reads besides the guard. */
function callbackReq(params: Record<string, string>) {
  const url = new URL("https://app.test/api/integrations/quickbooks/callback");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url) as never;
}
function redirectTarget(res: Response): URL {
  return new URL(res.headers.get("location") ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXTAUTH_SECRET", SECRET);
  sandboxEnv();
  mockLoad.mockResolvedValue(null);
  mockHealth.mockResolvedValue({ ok: true, data: { companyName: "Sandbox Co", legalName: null, country: null, homeCurrency: "AED", multiCurrencyEnabled: true } });
  mockClasses.mockResolvedValue({ ok: true, data: [] });
  mockAccounts.mockResolvedValue({ ok: true, data: [] });
  mockExchange.mockResolvedValue({
    ok: true,
    tokens: { accessToken: "at", refreshToken: "rt", accessTokenExpiresAt: new Date(Date.now() + 3600_000), refreshTokenExpiresAt: new Date(Date.now() + 8_640_000_000) },
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("the guard stands in front of every route", () => {
  it("a refused caller reaches no handler", async () => {
    refuse();
    for (const call of [statusGet(), disconnectDelete(), connectGet(), testPost(), chartGet()]) {
      expect((await call).status).toBe(403);
    }
    expect(mockStoreNew).not.toHaveBeenCalled();
    expect(mockHealth).not.toHaveBeenCalled();
  });

  it("a refused caller on the callback gets the page back, not raw JSON", async () => {
    refuse();
    const res = await callbackGet(callbackReq({ code: "c", realmId: "r", state: "s" }));
    expect(res.status).toBe(302);
    expect(redirectTarget(res).searchParams.get("reason")).toBe("forbidden");
    expect(mockStoreNew).not.toHaveBeenCalled();
  });

  it("reads need only view; connecting and disconnecting need the settle grant", async () => {
    allow();
    await statusGet();
    await chartGet();
    expect(guard.mock.calls.every((c) => c[0].need === "view")).toBe(true);
    guard.mockClear();
    await connectGet();
    await disconnectDelete();
    expect(guard.mock.calls.every((c) => c[0].need === "settle")).toBe(true);
  });
});

describe("status and disconnect", () => {
  it("reports whether the deployment has an app at all, and carries no token", async () => {
    allow();
    const body = await (await statusGet()).json();
    expect(body.configured).toBe(true);
    expect(body.environment).toBe("sandbox");
    expect(body.connection.connected).toBe(false);
    expect(JSON.stringify(body)).not.toContain("csec");
  });

  it("says not configured when the deployment has no QuickBooks app", async () => {
    allow();
    vi.stubEnv("QUICKBOOKS_SANDBOX_CLIENT_ID", "");
    const body = await (await statusGet()).json();
    expect(body.configured).toBe(false);
    expect(body.redirectUri).toBeNull();
  });

  it("disconnecting when nothing is connected is a logged 409, not a silent success", async () => {
    allow();
    const res = await disconnectDelete();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOT_CONNECTED");
    expect(mockClear).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("clears our side even when Intuit refuses the revocation", async () => {
    allow();
    mockLoad.mockResolvedValue({ realmId: "r1", environment: "sandbox", refreshTokenEncrypted: "iv:tag:ct" });
    mockRevoke.mockRejectedValue(new Error("intuit down"));
    const res = await disconnectDelete();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disconnected: true, revoked: false });
    expect(mockClear).toHaveBeenCalledWith("org1");
  });
});

describe("connect", () => {
  it("redirects to Intuit with the app, the accounting scope and a state", async () => {
    allow();
    const res = await connectGet();
    expect(res.status).toBe(302);
    const to = redirectTarget(res);
    expect(to.origin + to.pathname).toBe("https://appcenter.intuit.com/connect/oauth2");
    expect(to.searchParams.get("client_id")).toBe("cid");
    expect(to.searchParams.get("scope")).toBe("com.intuit.quickbooks.accounting");
    expect(to.searchParams.get("redirect_uri")).toBe("https://x.test/cb");
    expect(to.searchParams.get("state")).toBeTruthy();
  });

  it("refuses with a reason when no app is configured", async () => {
    allow();
    vi.stubEnv("QUICKBOOKS_SANDBOX_CLIENT_SECRET", "");
    const res = await connectGet();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOT_CONFIGURED");
  });
});

describe("the callback", () => {
  it("stores the connection when the state is this organisation's", async () => {
    allow("org1", "u1");
    const state = mintConnectState({ organizationId: "org1", userId: "u1" });
    const res = await callbackGet(callbackReq({ code: "the-code", realmId: "realm-9", state }));
    expect(redirectTarget(res).searchParams.get("quickbooks")).toBe("connected");
    expect(mockStoreNew).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org1", realmId: "realm-9", environment: "sandbox", userId: "u1" }));
  });

  it("REFUSES a state minted for another organisation, so a company cannot be attached to the wrong tenant", async () => {
    allow("org1", "u1");
    const foreign = mintConnectState({ organizationId: "org2", userId: "u9" });
    const res = await callbackGet(callbackReq({ code: "the-code", realmId: "realm-9", state: foreign }));
    expect(redirectTarget(res).searchParams.get("reason")).toBe("state_invalid");
    expect(mockStoreNew).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: expect.stringContaining("state-org-mismatch") }));
  });

  it("refuses an unsigned or expired state", async () => {
    allow();
    const bad = await callbackGet(callbackReq({ code: "c", realmId: "r", state: "not-a-state" }));
    expect(redirectTarget(bad).searchParams.get("reason")).toBe("state_invalid");
    const stale = mintConnectState({ organizationId: "org1", userId: "u1" }, Date.now() - 20 * 60_000);
    const old = await callbackGet(callbackReq({ code: "c", realmId: "r", state: stale }));
    expect(redirectTarget(old).searchParams.get("reason")).toBe("state_expired");
    expect(mockStoreNew).not.toHaveBeenCalled();
  });

  it("turns Intuit's own refusal and a short response into reasons a person can act on", async () => {
    allow();
    const declined = await callbackGet(callbackReq({ error: "access_denied" }));
    expect(redirectTarget(declined).searchParams.get("reason")).toBe("declined");
    const state = mintConnectState({ organizationId: "org1", userId: "u1" });
    const missing = await callbackGet(callbackReq({ state }));
    expect(redirectTarget(missing).searchParams.get("reason")).toBe("missing_params");
    expect(mockStoreNew).not.toHaveBeenCalled();
  });

  it("does not store a connection when the code cannot be exchanged", async () => {
    allow();
    mockExchange.mockResolvedValue({ ok: false, code: "HTTP_ERROR", message: "invalid_client" });
    const state = mintConnectState({ organizationId: "org1", userId: "u1" });
    const res = await callbackGet(callbackReq({ code: "c", realmId: "r", state }));
    expect(redirectTarget(res).searchParams.get("reason")).toBe("exchange_failed");
    expect(mockStoreNew).not.toHaveBeenCalled();
  });

  it("still connects when naming the company fails afterwards", async () => {
    allow();
    mockHealth.mockRejectedValue(new Error("intuit slow"));
    const state = mintConnectState({ organizationId: "org1", userId: "u1" });
    const res = await callbackGet(callbackReq({ code: "c", realmId: "r", state }));
    expect(redirectTarget(res).searchParams.get("quickbooks")).toBe("connected");
    expect(mockStoreNew).toHaveBeenCalled();
  });
});

describe("test and chart map a failure's cause to a status", () => {
  it("our configuration is a 409; QuickBooks failing is a 502", async () => {
    allow();
    mockHealth.mockResolvedValue({ ok: false, code: "NOT_CONNECTED", message: "not connected" });
    expect((await testPost()).status).toBe(409);
    mockHealth.mockResolvedValue({ ok: false, code: "HTTP_ERROR", message: "500 from Intuit" });
    expect((await testPost()).status).toBe(502);
  });

  it("the chart stops at the first failure rather than reporting half a chart", async () => {
    allow();
    mockClasses.mockResolvedValue({ ok: false, code: "REFRESH_EXPIRED", message: "reconnect" });
    const res = await chartGet();
    expect(res.status).toBe(409);
    expect(mockAccounts).not.toHaveBeenCalled();
  });

  it("returns both lists with their counts on success", async () => {
    allow();
    mockClasses.mockResolvedValue({ ok: true, data: [{ id: "1", name: "GLD-READ", fullyQualifiedName: null, active: true }] });
    mockAccounts.mockResolvedValue({ ok: true, data: [{ id: "7", name: "Venue", acctNum: "510400", accountType: "Cost of Goods Sold", accountSubType: null, classification: "Expense", active: true, fullyQualifiedName: "Cost of Sales:Venue" }] });
    const body = await (await chartGet()).json();
    expect(body.counts).toEqual({ classes: 1, accounts: 1 });
  });
});
