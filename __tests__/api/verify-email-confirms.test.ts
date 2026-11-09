/**
 * POST /api/auth/verify-email: clicking the link proves the address (Nov 5,
 * 2026). It sets User.emailConfirmedAt, the only proof registrant-access.ts
 * trusts, and links the registrations made earlier under that address.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockFindUser, mockLink, mockLinkSpeakers, tx, mockAuth, mockCredentials } = vi.hoisted(() => {
  const tx = { user: { update: vi.fn() }, verificationToken: { delete: vi.fn() } };
  return {
    tx,
    mockDb: {
      verificationToken: { findFirst: vi.fn(), delete: vi.fn() },
      registration: { findFirst: vi.fn() },
      speaker: { findMany: vi.fn() },
      organization: { findFirst: vi.fn() },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
    mockFindUser: vi.fn(),
    mockLink: vi.fn(),
    mockLinkSpeakers: vi.fn(),
    mockAuth: vi.fn(),
    mockCredentials: vi.fn(),
  };
});
vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true }), getClientIp: () => "1.1.1.1", hashVerificationToken: (t: string) => `h:${t}` }));
vi.mock("@/lib/tenant/user-lookup", () => ({ findUserByEmail: mockFindUser, scopeFromRequestHost: vi.fn(async () => ({})) }));
vi.mock("@/lib/internal-domains", () => ({ needsEmailVerification: () => false }));
vi.mock("@/lib/registrant-access", () => ({ linkConfirmedRegistrations: mockLink, linkConfirmedSpeakers: mockLinkSpeakers }));
vi.mock("@/lib/tenant/resolver", () => ({ resolveRequestOrgId: vi.fn(async () => null) }));
vi.mock("@/lib/public-credential-door", () => ({ verifyPublicCredentials: mockCredentials }));
vi.mock("@/lib/tenant-lane", () => ({ runWithTenantLane: (_o: unknown, _c: unknown, fn: () => unknown) => fn() }));

import { POST } from "@/app/api/auth/verify-email/route";

const post = (password?: string) =>
  POST(new Request("http://x", { method: "POST", body: JSON.stringify({ token: "tok", email: "Anna@Example.com", ...(password && { password }) }) }));

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.verificationToken.findFirst.mockResolvedValue({ expires: new Date(Date.now() + 60_000) });
  mockFindUser.mockResolvedValue({ id: "u1", emailVerified: null, organizationId: null, tokenVersion: 0 });
  mockDb.speaker.findMany.mockResolvedValue([{ submitterSource: "proposal", event: { slug: "mehf", name: "MEHF" } }]);
  mockLink.mockResolvedValue(2);
  mockLinkSpeakers.mockResolvedValue(1);
  mockAuth.mockResolvedValue({ user: { id: "u1" } });
});

describe("only the signed-in owner of the account can confirm it (review of 7cf4eb3b)", () => {
  it("signed out: refused with SIGN_IN_REQUIRED, nothing confirmed, the token kept for after sign-in", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("SIGN_IN_REQUIRED");
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.verificationToken.delete).not.toHaveBeenCalled();
    expect(mockDb.verificationToken.delete).not.toHaveBeenCalled();
    expect(mockLink).not.toHaveBeenCalled();
  });

  it("a session a reset revoked (counter behind the database) cannot confirm", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", tokenVersion: 0 } });
    mockFindUser.mockResolvedValue({ id: "u1", emailVerified: null, organizationId: null, tokenVersion: 1 });
    const res = await post();
    expect(res.status).toBe(401);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("signed in as another account (the address's owner opening a link for an account someone else made): refused", async () => {
    mockAuth.mockResolvedValue({ user: { id: "someone-else" } });
    const res = await post();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("WRONG_ACCOUNT");
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(mockLink).not.toHaveBeenCalled();
  });
});

describe("verify-email confirms the address", () => {
  it("sets emailConfirmedAt with emailVerified, and links the earlier registrations as confirmed", async () => {
    expect((await post()).status).toBe(200);
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { emailVerified: expect.any(Date), emailConfirmedAt: expect.any(Date) },
    });
    expect(mockLink).toHaveBeenCalledWith({ userId: "u1", email: "anna@example.com", confirmed: true });
    // And the speaker records the organisers made on the address.
    expect(mockLinkSpeakers).toHaveBeenCalledWith({ userId: "u1", email: "anna@example.com", confirmed: true }, null);
  });

  it("names the events whose speaker profile it claimed, so the page sends the person back to finish", async () => {
    const body = await (await post()).json();
    expect(body.claimedEvents).toEqual([{ slug: "mehf", name: "MEHF", door: "proposal" }]);
  });

  it("still confirms when linking fails (My events shows them by address anyway)", async () => {
    mockLink.mockRejectedValue(new Error("db blip"));
    expect((await post()).status).toBe(200);
  });

  it("an invalid token confirms nothing and links nothing", async () => {
    mockDb.verificationToken.findFirst.mockResolvedValue(null);
    expect((await post()).status).toBe(400);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(mockLink).not.toHaveBeenCalled();
  });
});

describe("signed out, the account's password confirms it (Nov 5, 2026: /signup accounts cannot sign in first)", () => {
  beforeEach(() => mockAuth.mockResolvedValue(null));

  it("the right password confirms, checked through the shared credential door without a second success row", async () => {
    mockCredentials.mockImplementation(async ({ user }: { user: unknown }) => ({ ok: true, user }));
    const res = await post("correct horse");
    expect(res.status).toBe(200);
    expect(mockCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ email: "anna@example.com", password: "correct horse", recordSuccess: false, logLabel: "verify-email" }),
    );
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { emailVerified: expect.any(Date), emailConfirmedAt: expect.any(Date) },
    });
    // The session is never consulted when a password is given.
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("a wrong password confirms nothing and keeps the token for another try", async () => {
    mockCredentials.mockResolvedValue({ ok: false, reason: "bad-credentials" });
    const res = await post("wrong");
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("BAD_PASSWORD");
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.verificationToken.delete).not.toHaveBeenCalled();
    expect(mockLink).not.toHaveBeenCalled();
  });

  it("a throttled address is refused with Retry-After, before any confirmation", async () => {
    mockCredentials.mockResolvedValue({ ok: false, reason: "throttled", retryAfterSeconds: 120 });
    const res = await post("guess");
    expect(res.status).toBe(429);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("the mailbox alone (a link scanner, or the address's owner without the password) confirms nothing", async () => {
    const res = await post();
    expect(res.status).toBe(401);
    expect(mockCredentials).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });
});
