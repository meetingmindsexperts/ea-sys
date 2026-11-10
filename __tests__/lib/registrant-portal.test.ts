/**
 * The one loader behind every /my-account page (review of the portal, Nov 10,
 * 2026): signed out goes to sign-in with the page to come back to, the scope
 * is read with the session's token version (so a revoked session proves
 * nothing), a confirmed account's registrations are linked before the page
 * reads, and an account that no longer exists goes back to sign-in.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { authMock, loadScope, linkConfirmed, logger } = vi.hoisted(() => ({
  authMock: vi.fn(),
  loadScope: vi.fn(),
  linkConfirmed: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Map([["host", "events.example.test"]]) }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/tenant/resolver", () => ({ normalizeHost: (h: string) => h, resolveTenantOrg: async () => ({ orgId: "org1" }) }));
vi.mock("@/lib/tenant-lane", () => ({ runWithTenantLane: (_o: string, _c: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/registrant-access", () => ({ loadRegistrantScope: loadScope, linkConfirmedRegistrations: linkConfirmed }));

import { loadRegistrantPortal } from "@/lib/registrant-portal";

const SCOPE = { userId: "u1", email: "a@b.com", confirmed: true };
const SIGN_IN = "REDIRECT:/login?callbackUrl=%2Fmy-account%2Fcertificates";
const load = vi.fn();
const open = () => loadRegistrantPortal("/my-account/certificates", load);

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "u1", role: "REGISTRANT", tokenVersion: 3 } });
  loadScope.mockResolvedValue(SCOPE);
  linkConfirmed.mockResolvedValue(0);
  load.mockResolvedValue(["row"]);
});

describe("loadRegistrantPortal", () => {
  it("reads the scope with the session's token version and hands the page its scope", async () => {
    expect(await open()).toEqual({ scope: SCOPE, data: ["row"], role: "REGISTRANT" });
    expect(loadScope).toHaveBeenCalledWith("u1", { sessionTokenVersion: 3 });
    expect(load).toHaveBeenCalledWith(SCOPE);
  });

  it("links the account's registrations before the page reads, so every page agrees with My events", async () => {
    await open();
    expect(linkConfirmed).toHaveBeenCalledWith(SCOPE);
    expect(linkConfirmed.mock.invocationCallOrder[0]).toBeLessThan(load.mock.invocationCallOrder[0]);
  });

  it("a failed link is logged and the page still loads", async () => {
    linkConfirmed.mockRejectedValue(new Error("db blip"));
    expect((await open()).data).toEqual(["row"]);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "registrant-portal:link-failed", userId: "u1" }));
  });

  it("signed out: to sign-in with the page to come back to, and nothing is read", async () => {
    authMock.mockResolvedValue(null);
    await expect(open()).rejects.toThrow(SIGN_IN);
    expect(loadScope).not.toHaveBeenCalled();
  });

  it("an account that no longer exists: logged, back to sign-in, nothing linked or read", async () => {
    loadScope.mockResolvedValue(null);
    await expect(open()).rejects.toThrow(SIGN_IN);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "registrant-portal:user-not-found" }));
    expect(linkConfirmed).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
});
