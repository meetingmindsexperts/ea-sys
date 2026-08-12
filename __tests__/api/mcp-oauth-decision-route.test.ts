/**
 * POST /api/mcp/oauth/authorize/decision — the endpoint that turns one admin
 * click into an OAuth authorization code for the org's whole MCP tool set.
 *
 * Pins the two properties that make it safe to leave under the `/api/mcp`
 * prefix that `src/proxy.ts` deliberately skips for CSRF:
 *
 *   1. A cross-origin POST is refused BEFORE the session cookie is consulted,
 *      so a forged form cannot mint a code even if the browser attached the
 *      cookie (which today it does not, only because Auth.js defaults to
 *      SameSite=Lax — a default, not a guarantee we wrote).
 *   2. An approval to an unrecognised destination is still allowed (a
 *      self-hosted client is legitimate) but logs at warn WITH the host, so a
 *      phished grant is answerable after the fact.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, getClientSpy, issueAuthCodeSpy, logWarn, logInfo } = vi.hoisted(() => ({
  mockDb: { user: { findUnique: vi.fn() } },
  mockAuth: vi.fn(),
  getClientSpy: vi.fn(),
  issueAuthCodeSpy: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number }) => ({
      status: i?.status ?? 200,
      json: async () => b,
      _redirect: null as string | null,
    }),
    redirect: (url: string, status?: number) => ({
      status: status ?? 302,
      json: async () => ({}),
      _redirect: url,
    }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: logInfo, warn: logWarn, error: vi.fn() },
}));
vi.mock("@/lib/mcp-oauth", () => ({
  getClient: (...a: unknown[]) => getClientSpy(...a),
  issueAuthCode: (...a: unknown[]) => issueAuthCodeSpy(...a),
}));
// Real isSameOriginRequest + real describeRedirectTarget — those predicates ARE
// what is under test here; only the rate limiter is stubbed open.
vi.mock("@/lib/security", async (orig) => {
  const actual = await orig<typeof import("@/lib/security")>();
  return {
    ...actual,
    checkRateLimit: () => ({ allowed: true, remaining: 29, retryAfterSeconds: 1 }),
    getClientIp: () => "10.0.0.1",
  };
});

import { POST } from "@/app/api/mcp/oauth/authorize/decision/route";

const HOST = "events.example.com";
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function req(headers: Record<string, string>, fields: Record<string, string>): Request {
  return new Request(`http://${HOST}/api/mcp/oauth/authorize/decision`, {
    method: "POST",
    headers,
    body: form(fields),
  });
}

const APPROVE = {
  client_id: "cli_1",
  redirect_uri: CLAUDE_CB,
  code_challenge: "abc",
  code_challenge_method: "S256",
  state: "st",
  scope: "mcp",
  decision: "approve",
};

beforeEach(() => {
  vi.clearAllMocks();
  getClientSpy.mockResolvedValue({
    clientId: "cli_1",
    clientName: "Claude",
    redirectUris: [CLAUDE_CB],
  });
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN" } });
  mockDb.user.findUnique.mockResolvedValue({ id: "u1", organizationId: "org1" });
  issueAuthCodeSpy.mockResolvedValue("code_raw_value_123456");
});

describe("CSRF boundary", () => {
  it("refuses a cross-site POST with 403 and mints nothing", async () => {
    const res = await POST(
      req({ host: HOST, origin: "https://evil.example" }, APPROVE),
    );
    expect(res.status).toBe(403);
    expect(issueAuthCodeSpy).not.toHaveBeenCalled();
    // Refused before the session is even read: a forged request must not
    // depend on who happens to be logged in.
    expect(mockAuth).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "mcp-oauth:decision-cross-origin-refused",
        reason: "origin-mismatch",
      }),
    );
  });

  it("refuses a POST with no Origin and no Referer", async () => {
    const res = await POST(req({ host: HOST }, APPROVE));
    expect(res.status).toBe(403);
    expect(issueAuthCodeSpy).not.toHaveBeenCalled();
  });

  it("allows the real same-origin consent form", async () => {
    const res = await POST(req({ host: HOST, origin: `https://${HOST}` }, APPROVE));
    expect(res.status).toBe(302);
    expect(issueAuthCodeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("destination logging", () => {
  it("logs a recognised approval at info", async () => {
    await POST(req({ host: HOST, origin: `https://${HOST}` }, APPROVE));
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "mcp-oauth:authorize-approved",
        redirectHost: "claude.ai",
        recognizedDestination: true,
      }),
    );
  });

  it("still allows an unrecognised destination but logs it at warn with the host", async () => {
    // A self-hosted client is a real use case, so this is advisory, not a
    // block. What must never happen is it going through SILENTLY.
    getClientSpy.mockResolvedValue({
      clientId: "cli_2",
      clientName: "EA-SYS Official Sync",
      redirectUris: ["https://evil.example/cb"],
    });
    const res = await POST(
      req({ host: HOST, origin: `https://${HOST}` }, { ...APPROVE, client_id: "cli_2", redirect_uri: "https://evil.example/cb" }),
    );
    expect(res.status).toBe(302);
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "mcp-oauth:authorize-approved-unrecognized-destination",
        redirectHost: "evil.example",
        recognizedDestination: false,
        clientName: "EA-SYS Official Sync",
      }),
    );
  });

  it("never logs the raw authorization code", async () => {
    await POST(req({ host: HOST, origin: `https://${HOST}` }, APPROVE));
    const logged = JSON.stringify(logInfo.mock.calls);
    expect(logged).not.toContain("code_raw_value_123456");
    expect(logged).toContain("code_raw_val");
  });
});

describe("pre-existing guards still hold", () => {
  it("rejects a redirect_uri that is not registered for the client", async () => {
    const res = await POST(
      req({ host: HOST, origin: `https://${HOST}` }, { ...APPROVE, redirect_uri: "https://evil.example/cb" }),
    );
    expect(res.status).toBe(400);
    expect(issueAuthCodeSpy).not.toHaveBeenCalled();
  });

  it("rejects a role that may not grant MCP access", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u2", role: "MEMBER" } });
    const res = await POST(req({ host: HOST, origin: `https://${HOST}` }, APPROVE));
    expect(res.status).toBe(403);
    expect(issueAuthCodeSpy).not.toHaveBeenCalled();
  });

  it("deny still redirects back with access_denied and mints nothing", async () => {
    const res = await POST(
      req({ host: HOST, origin: `https://${HOST}` }, { ...APPROVE, decision: "deny" }),
    );
    expect(res.status).toBe(302);
    expect(issueAuthCodeSpy).not.toHaveBeenCalled();
  });
});
