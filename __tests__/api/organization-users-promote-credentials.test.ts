/**
 * Phase 6 review H2 (Oct 7, 2026): promoting an existing account to a team
 * role must not keep the password it already had.
 *
 * Public registration creates an account at any address without proving the
 * mailbox. Before this fix, a stranger could register newhire@ourdomain with
 * their own password and, once an admin invited that address as ADMIN, the
 * promotion kept the stranger's password and they signed in as the admin.
 * A promotion now sets credentials exactly as a fresh invite would.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockTx, mockSendEmail } = vi.hoisted(() => {
  const mockTx = {
    user: { create: vi.fn(), update: vi.fn() },
    verificationToken: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  return {
    mockAuth: vi.fn(),
    mockSendEmail: vi.fn(),
    mockDb: {
      user: { findFirst: vi.fn(), update: vi.fn() },
      organization: { findUnique: vi.fn().mockResolvedValue({ name: "MMG" }) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockTx)),
    },
    mockTx,
  };
});

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/email", () => ({
  sendEmail: (...a: unknown[]) => mockSendEmail(...a),
  emailTemplates: { userInvitation: vi.fn().mockReturnValue({ subject: "s", htmlContent: "h", textContent: "t" }) },
}));
vi.mock("@/lib/security", () => ({
  getClientIp: vi.fn().mockReturnValue("1.2.3.4"),
  hashVerificationToken: vi.fn().mockReturnValue("hashed-token"),
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true, remaining: 9, retryAfterSeconds: 3600 }),
}));
vi.mock("bcryptjs", () => ({ default: { hash: vi.fn(async (v: string) => `bcrypt(${v.length > 40 ? "random" : v})`) } }));

import { POST } from "@/app/api/organization/users/route";

const adminSession = { user: { id: "admin-1", role: "ADMIN", organizationId: "org-1", email: "a@x.com" } };
const body = { email: "newhire@meetingmindsdubai.com", firstName: "New", lastName: "Hire", role: "ADMIN" };
const req = (b: Record<string, unknown>) =>
  new Request("http://localhost/api/organization/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(adminSession);
  // The pre-registered, org-independent account the attacker created.
  mockDb.user.findFirst.mockResolvedValue({ id: "u-reg", role: "REGISTRANT", organizationId: null });
  mockTx.user.update.mockResolvedValue({ id: "u-reg", email: body.email, firstName: "New", lastName: "Hire", role: "ADMIN", createdAt: new Date() });
  mockSendEmail.mockResolvedValue({ success: true });
});

describe("POST /api/organization/users: promoting an existing account", () => {
  it("invitation mode replaces the password, ends sessions and mails a set-password link", async () => {
    const res = await POST(req(body));
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.promoted).toBe(true);
    expect(out.invitationSent).toBe(true);

    const data = mockTx.user.update.mock.calls[0][0].data;
    expect(data.role).toBe("ADMIN");
    expect(data.passwordHash).toBe("bcrypt(random)");
    expect(data.tokenVersion).toEqual({ increment: 1 });
    expect(data).not.toHaveProperty("emailVerified");
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: [expect.objectContaining({ email: body.email })] }));
    expect(mockTx.verificationToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ identifier: body.email, token: "hashed-token" }),
    });
  });

  it("password mode sets the inviter's password, never the old one", async () => {
    const res = await POST(req({ ...body, password: "adminchosen1" }));
    expect(res.status).toBe(200);
    const data = mockTx.user.update.mock.calls[0][0].data;
    expect(data.passwordHash).toBe("bcrypt(adminchosen1)");
    expect(data.tokenVersion).toEqual({ increment: 1 });
    expect(data.emailVerified).toBeInstanceOf(Date);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockTx.verificationToken.create).not.toHaveBeenCalled();
  });

  it("does not promote at all when the invitation email cannot be sent", async () => {
    mockSendEmail.mockResolvedValue({ success: false, error: "bounce" });
    const res = await POST(req(body));
    expect(res.status).toBe(502);
    expect(mockTx.user.update).not.toHaveBeenCalled();
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });
});
