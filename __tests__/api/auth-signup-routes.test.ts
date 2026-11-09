/**
 * POST /api/auth/signup and POST /api/auth/resend-confirmation (Nov 5, 2026;
 * docs/ACCOUNT_CONFIRMATION_PLAN.md phase 2). The rules pinned here:
 *   - every accepted sign-up gets the SAME answer, so the screen never says
 *     which addresses have accounts; what differs is only the email sent;
 *   - an existing account is never changed by a sign-up on its address;
 *   - the honeypot creates nothing;
 *   - the resend route mails only an account sign-in would refuse.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const { mockDb, mockFindUser, mockSendVerification, mockSendEmail, mockNeedsConfirmation, mockRateLimit } = vi.hoisted(() => ({
  mockDb: { user: { create: vi.fn() } },
  mockFindUser: vi.fn(),
  mockSendVerification: vi.fn(),
  mockSendEmail: vi.fn(),
  mockNeedsConfirmation: vi.fn(),
  mockRateLimit: vi.fn(),
}));
vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({ checkRateLimit: mockRateLimit, getClientIp: () => "1.1.1.1" }));
vi.mock("@/lib/tenant/user-lookup", () => ({ findUserByEmail: mockFindUser, scopeFromRequestHost: vi.fn(async () => ({})) }));
vi.mock("@/lib/email-verification", () => ({ sendEmailVerification: mockSendVerification }));
vi.mock("@/lib/email", () => ({
  sendEmail: mockSendEmail,
  emailTemplates: { accountExists: () => ({ subject: "s", htmlContent: "h", textContent: "t" }) },
}));
vi.mock("@/lib/account-signup", () => ({
  SIGNUP_PASSWORD_MIN: 8,
  SIGNUP_PASSWORD_MAX: 128,
  signInNeedsConfirmation: mockNeedsConfirmation,
}));
vi.mock("bcryptjs", () => ({ default: { hash: vi.fn(async () => "hashed") } }));

import { POST as signup } from "@/app/api/auth/signup/route";
import { POST as resend } from "@/app/api/auth/resend-confirmation/route";

const body = (over: Record<string, unknown> = {}) => ({
  firstName: "Sara",
  lastName: "Haddad",
  email: "Sara.Haddad@Example.com",
  password: "correct horse",
  acceptTerms: true,
  ...over,
});
const post = (handler: (r: Request) => Promise<unknown>, b: unknown) =>
  handler(new Request("http://x/api", { method: "POST", body: JSON.stringify(b) })) as Promise<{ status: number; json: () => Promise<Record<string, unknown>> }>;

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 60 });
  mockFindUser.mockResolvedValue(null);
  mockDb.user.create.mockResolvedValue({ id: "new-user" });
  mockSendVerification.mockResolvedValue("sent");
  mockSendEmail.mockResolvedValue({ success: true });
  mockNeedsConfirmation.mockResolvedValue(false);
});

describe("POST /api/auth/signup", () => {
  it("a new address: creates an unconfirmed REGISTRANT with no organisation and sends an account confirmation", async () => {
    const res = await post(signup, body());
    expect(res.status).toBe(200);
    expect(mockDb.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: "sara.haddad@example.com",
        passwordHash: "hashed",
        role: "REGISTRANT",
        organizationId: null,
        termsAcceptedAt: expect.any(Date),
        termsAcceptedIp: "1.1.1.1",
      }),
      select: { id: true },
    });
    const created = mockDb.user.create.mock.calls[0][0].data;
    expect(created).not.toHaveProperty("emailConfirmedAt");
    expect(created).not.toHaveProperty("emailVerified");
    expect(mockSendVerification).toHaveBeenCalledWith({ email: "sara.haddad@example.com", name: "Sara Haddad", purpose: "account" });
  });

  it("an address with an account: the same answer, the account untouched, a note sent instead of a link", async () => {
    const fresh = await (await post(signup, body())).json();
    vi.clearAllMocks();
    mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 60 });
    mockNeedsConfirmation.mockResolvedValue(false);
    mockSendEmail.mockResolvedValue({ success: true });
    mockFindUser.mockResolvedValue({ id: "u1", firstName: "Sara", lastName: "H", role: "REGISTRANT", emailConfirmedAt: new Date() });

    const res = await post(signup, body({ password: "a different one" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(fresh);
    expect(mockDb.user.create).not.toHaveBeenCalled();
    expect(mockSendVerification).not.toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: [{ email: "sara.haddad@example.com", name: "Sara H" }] }));
  });

  it("an earlier sign-up still waiting for confirmation: its link is sent again, nothing else changes", async () => {
    mockFindUser.mockResolvedValue({ id: "u1", firstName: "Sara", lastName: "Haddad", role: "REGISTRANT", emailConfirmedAt: null });
    mockNeedsConfirmation.mockResolvedValue(true);
    expect((await post(signup, body())).status).toBe(200);
    expect(mockDb.user.create).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockSendVerification).toHaveBeenCalledWith(expect.objectContaining({ purpose: "account" }));
  });

  it("the password is hashed on every path, so timing does not say which addresses exist", async () => {
    const bcrypt = (await import("bcryptjs")).default;
    mockFindUser.mockResolvedValue({ id: "u1", firstName: "A", lastName: "B", role: "ADMIN", emailConfirmedAt: null });
    await post(signup, body());
    expect(bcrypt.hash).toHaveBeenCalledTimes(1);
  });

  it("two sign-ups racing for one address: the loser answers like the winner", async () => {
    mockDb.user.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }));
    const res = await post(signup, body());
    expect(res.status).toBe(200);
    expect(mockSendVerification).not.toHaveBeenCalled();
  });

  it("the honeypot filled: the same answer, nothing created or sent", async () => {
    const res = await post(signup, body({ website: "http://spam.example" }));
    expect(res.status).toBe(200);
    expect(mockFindUser).not.toHaveBeenCalled();
    expect(mockDb.user.create).not.toHaveBeenCalled();
    expect(mockSendVerification).not.toHaveBeenCalled();
  });

  it("refuses without the terms ticked, a short password, or an unknown field", async () => {
    for (const bad of [body({ acceptTerms: false }), body({ password: "short" }), body({ role: "ADMIN" })]) {
      expect((await post(signup, bad)).status).toBe(400);
    }
    expect(mockDb.user.create).not.toHaveBeenCalled();
  });

  it("rate limited: 429 with retryAfterSeconds, before any lookup", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 42 });
    const res = await post(signup, body());
    expect(res.status).toBe(429);
    expect((await res.json()).retryAfterSeconds).toBe(42);
    expect(mockFindUser).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/resend-confirmation", () => {
  it("sends the link only to an account sign-in refuses for want of confirmation", async () => {
    mockFindUser.mockResolvedValue({ id: "u1", firstName: "Sara", lastName: "Haddad", role: "REGISTRANT", emailConfirmedAt: null });
    mockNeedsConfirmation.mockResolvedValue(true);
    const res = await post(resend, { email: "Sara.Haddad@example.com" });
    expect(res.status).toBe(200);
    expect(mockSendVerification).toHaveBeenCalledWith({ email: "sara.haddad@example.com", name: "Sara Haddad", purpose: "account" });
  });

  it("an unknown address and an ordinary account get the same answer and no email", async () => {
    const unknown = await (await post(resend, { email: "nobody@example.com" })).json();
    mockFindUser.mockResolvedValue({ id: "u2", firstName: "A", lastName: "B", role: "REGISTRANT", emailConfirmedAt: null });
    mockNeedsConfirmation.mockResolvedValue(false);
    const ordinary = await (await post(resend, { email: "has-registrations@example.com" })).json();
    expect(ordinary).toEqual(unknown);
    expect(mockSendVerification).not.toHaveBeenCalled();
  });
});
