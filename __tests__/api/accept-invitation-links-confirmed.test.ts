/**
 * POST /api/auth/accept-invitation: accepting proves the address (it sets
 * User.emailConfirmedAt), so it must claim the unlinked speaker records and
 * registrations on that address the way verify-email does. Before this, a
 * reviewer added from a speaker whose account was unconfirmed stayed unlinked
 * after accepting (audit of production warnings, Nov 10, 2026).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockFindUser, mockLink, mockLinkSpeakers, mockResolveOrg, mockLane, mockLogger, tx } = vi.hoisted(() => {
  const tx = { user: { update: vi.fn() }, verificationToken: { delete: vi.fn() }, auditLog: { create: vi.fn() } };
  return {
    tx,
    mockDb: {
      verificationToken: { findFirst: vi.fn(), delete: vi.fn() },
      user: { findMany: vi.fn() },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
    mockFindUser: vi.fn(),
    mockLink: vi.fn(),
    mockLinkSpeakers: vi.fn(),
    mockResolveOrg: vi.fn(),
    mockLane: vi.fn((_o: unknown, _c: unknown, fn: () => unknown) => fn()),
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});
vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("bcryptjs", () => ({ default: { hash: vi.fn(async () => "hashed") } }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true }), getClientIp: () => "1.1.1.1", hashVerificationToken: (t: string) => `h:${t}` }));
vi.mock("@/lib/notifications", () => ({ createNotification: vi.fn() }));
vi.mock("@/lib/tenant/user-lookup", () => ({ findUserByEmail: mockFindUser, scopeFromRequestHost: vi.fn(async () => ({})) }));
vi.mock("@/lib/registrant-access", () => ({ linkConfirmedRegistrations: mockLink, linkConfirmedSpeakers: mockLinkSpeakers }));
vi.mock("@/lib/tenant/resolver", () => ({ resolveRequestOrgId: mockResolveOrg }));
vi.mock("@/lib/tenant-lane", () => ({ runWithTenantLane: mockLane }));

import { POST } from "@/app/api/auth/accept-invitation/route";

const post = () =>
  POST(new Request("http://x", { method: "POST", body: JSON.stringify({ token: "tok", email: "Anna@Example.com", password: "secret1" }) }));

const proven = { userId: "u1", email: "anna@example.com", confirmed: true };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.verificationToken.findFirst.mockResolvedValue({ expires: new Date(Date.now() + 60_000) });
  mockFindUser.mockResolvedValue({ id: "u1", organizationId: null, firstName: "Anna", lastName: "A", role: "REVIEWER" });
  mockResolveOrg.mockResolvedValue("org1");
  mockLink.mockResolvedValue(2);
  mockLinkSpeakers.mockResolvedValue(1);
});

describe("accept-invitation claims what was made on the proven address", () => {
  it("claims the unlinked speaker records and registrations, in the host's lane, after the account is confirmed", async () => {
    expect((await post()).status).toBe(200);
    expect(tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u1" }, data: expect.objectContaining({ emailConfirmedAt: expect.any(Date) }) }),
    );
    expect(mockLinkSpeakers).toHaveBeenCalledWith(proven, "org1");
    expect(mockLink).toHaveBeenCalledWith(proven);
    expect(mockLane).toHaveBeenCalledWith("org1", { route: "auth/accept-invitation", userId: "u1" }, expect.any(Function));
    // Only once the confirmation is written.
    expect(mockDb.$transaction.mock.invocationCallOrder[0]).toBeLessThan(mockLinkSpeakers.mock.invocationCallOrder[0]);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "User accepted invitation", linkedRegistrations: 2, claimedSpeakers: 1 }),
    );
  });

  it("a linking failure is logged and does not fail the acceptance", async () => {
    mockLinkSpeakers.mockRejectedValue(new Error("db blip"));
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "accept-invitation:link-confirmed-failed", userId: "u1" }),
    );
  });

  it("a host that fails to resolve is logged and still links, without an organisation filter", async () => {
    mockResolveOrg.mockRejectedValue(new Error("resolver down"));
    expect((await post()).status).toBe(200);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "accept-invitation:host-org-resolve-failed", userId: "u1" }),
    );
    expect(mockLinkSpeakers).toHaveBeenCalledWith(proven, null);
  });

  it("an invalid or expired token links nothing", async () => {
    mockDb.verificationToken.findFirst.mockResolvedValue(null);
    expect((await post()).status).toBe(400);
    mockDb.verificationToken.findFirst.mockResolvedValue({ expires: new Date(Date.now() - 1000) });
    expect((await post()).status).toBe(400);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(mockLink).not.toHaveBeenCalled();
    expect(mockLinkSpeakers).not.toHaveBeenCalled();
  });
});
