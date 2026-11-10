/**
 * The context a "no session" warning carries (production audit, Nov 10, 2026).
 * Pins the two things that matter: the session cookie is recognised under
 * every name NextAuth uses here and is logged ONLY as a boolean, and the
 * guards that log a 401 put this context on their line.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockHeaders, mockAuth, mockWarn, mockOrgModuleState, mockGetOrgContext } = vi.hoisted(() => ({
  mockHeaders: vi.fn(),
  mockAuth: vi.fn(),
  mockWarn: vi.fn(),
  mockOrgModuleState: vi.fn(),
  mockGetOrgContext: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mockHeaders }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/logger", () => {
  const quiet = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return {
    apiLogger: { warn: mockWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    authLogger: quiet,
    dbLogger: quiet,
    eventLogger: quiet,
  };
});
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/module-entitlements", () => ({ orgModuleState: mockOrgModuleState }));
vi.mock("@/lib/module-flags", () => ({ isBlueprintModuleEnabled: () => true }));
vi.mock("@/lib/api-auth", () => ({ getOrgContext: mockGetOrgContext }));
vi.mock("@/crm/components/crm-shell", () => ({ CrmShell: () => null }));

import { noSessionContext, noSessionContextFromHeaders } from "@/lib/no-session-context";
import { blueprintGuard } from "@/lib/blueprint/route-guard";
import { requireCrmRead } from "@/crm/lib/crm-route";
import CrmLayout from "@/app/(dashboard)/crm/layout";

const SECRET = "eyJhbGciOiJkaXIi.secret-token-value";

function request(headers: Record<string, string>) {
  return new Request("https://events.example.com/api/hr/summary", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(null);
  mockHeaders.mockResolvedValue(new Headers({ host: "events.example.com", "x-real-ip": "203.0.113.9" }));
});

describe("noSessionContext", () => {
  it.each([
    ["authjs.session-token"],
    ["__Secure-authjs.session-token"],
    ["__Secure-authjs.session-token.0"],
    ["authjs.session-token.1"],
    ["__Secure-next-auth.session-token"],
  ])("sees the session cookie named %s", (name) => {
    const ctx = noSessionContext(request({ cookie: `theme=dark; ${name}=${SECRET}` }));
    expect(ctx).toMatchObject({ hasSessionCookie: true });
  });

  it.each([
    [""],
    ["theme=dark"],
    ["authjs.csrf-token=abc; authjs.callback-url=x"],
    ["not-authjs.session-token-old=1"],
  ])("sees no session cookie in %j", (cookie) => {
    expect(noSessionContext(request({ cookie }))).toMatchObject({ hasSessionCookie: false });
  });

  it("never carries the cookie's value", () => {
    const ctx = noSessionContext(request({ cookie: `__Secure-authjs.session-token=${SECRET}` }));
    expect(JSON.stringify(ctx)).not.toContain("secret-token-value");
    expect(JSON.stringify(ctx)).not.toContain("session-token");
  });

  it("reports host, ip, a truncated user agent and the prefetch signals", () => {
    const ctx = noSessionContext(
      request({
        host: "0.0.0.0:3000",
        "x-forwarded-host": "events.example.com",
        "x-real-ip": "203.0.113.9",
        "user-agent": "M".repeat(500),
        "next-router-prefetch": "1",
        rsc: "1",
        "sec-purpose": "prefetch;prerender",
      }),
    );
    expect(ctx).toEqual({
      host: "events.example.com",
      hasSessionCookie: false,
      userAgent: "M".repeat(200),
      prefetch: true,
      rsc: true,
      purposePrefetch: true,
      ip: "203.0.113.9",
    });
  });

  it("an ordinary request has every signal off", () => {
    expect(noSessionContext(request({ host: "events.example.com" }))).toEqual({
      host: "events.example.com",
      hasSessionCookie: false,
      userAgent: null,
      prefetch: false,
      rsc: false,
      purposePrefetch: false,
      ip: "unknown",
    });
  });

  it("outside a request it says so and does not throw", async () => {
    mockHeaders.mockRejectedValue(new Error("headers() was called outside a request scope"));
    await expect(noSessionContextFromHeaders()).resolves.toEqual({ requestContext: "unavailable" });
  });
});

describe("the guards put the context on their no-session warning", () => {
  it("blueprintGuard: same message, 401, with context", async () => {
    mockHeaders.mockResolvedValue(
      new Headers({ host: "events.example.com", cookie: `authjs.session-token=${SECRET}` }),
    );
    const gate = await blueprintGuard("blueprints.view", "blueprint:page");
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.response.status).toBe(401);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "blueprint:page:unauthorized", host: "events.example.com", hasSessionCookie: true }),
    );
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain("secret-token-value");
  });

  it("requireCrmRead: same message, 401, with context", async () => {
    mockGetOrgContext.mockResolvedValue(null);
    const req = new Request("https://events.example.com/api/crm/deals", { headers: { "x-real-ip": "203.0.113.9" } });
    const res = await requireCrmRead(req);
    expect(res.error?.status).toBe(401);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "crm-route:unauthorized",
        method: "GET",
        route: "/api/crm/deals",
        hasSessionCookie: false,
        ip: "203.0.113.9",
      }),
    );
  });
});

describe("the CRM layout tells no session from no CRM", () => {
  it("no session: crm-page:no-session, and still not found", async () => {
    await expect(CrmLayout({ children: null })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "crm-page:no-session", hasSessionCookie: false, ip: "203.0.113.9" }),
    );
    expect(mockOrgModuleState).not.toHaveBeenCalled();
  });

  it("signed in, organisation without the CRM: module-not-enabled with who", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "ORGANIZER", organizationId: "org1" } });
    mockOrgModuleState.mockResolvedValue("off");
    await expect(CrmLayout({ children: null })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith({
      msg: "crm-page:module-not-enabled",
      organizationId: "org1",
      userId: "u1",
      role: "ORGANIZER",
    });
  });
});
