/**
 * Unit tests for POST /api/auth/forgot-password — specifically the
 * event-scoped reset-link branch added June 8, 2026.
 *
 * The route's overall flow (token generation, email send, account
 * enumeration prevention) is exercised in other tests. This file
 * pins ONLY the new contract:
 *
 *   - eventSlug omitted → reset link uses generic /reset-password
 *   - eventSlug present + event found → reset link uses
 *     /e/{slug}/reset-password
 *   - eventSlug present + event NOT found → soft fallback to
 *     /reset-password + a warn log (does NOT 400 or fail the flow —
 *     a working email is better than a broken one + the link still
 *     resets the password just without event branding)
 *   - eventSlug fails the Zod regex (path traversal, etc.) → 400
 *     before the DB lookup even runs
 *
 * If this contract regresses, registrants who started the flow on
 * /e/[slug]/forgot-password get reset emails pointing at the wrong
 * URL — the silent "no event branding in the reset flow" failure
 * mode the feature was built to prevent.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockSendEmail, mockCheckRateLimit, mockHashVerificationToken } = vi.hoisted(() => ({
  mockDb: {
    user: { findUnique: vi.fn() },
    event: { findFirst: vi.fn() },
    $transaction: vi.fn(),
    verificationToken: { deleteMany: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockSendEmail: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockHashVerificationToken: vi.fn(),
}));

// Route calls sendEmail with htmlContent + textContent + subject (not
// html/text/subject) — capture the actual field names the route uses.
const capturedEmails: Array<{ htmlContent?: string; textContent?: string; subject?: string }> = [];

vi.mock("next/server", () => ({
  NextResponse: {
    json: (
      body: unknown,
      init?: { status?: number; headers?: Record<string, string> },
    ) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Map<string, string>(Object.entries(init?.headers ?? {})),
    }),
  },
}));

vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));

vi.mock("@/lib/email", () => ({
  // Route's expectation: sendEmail returns { success: true } or
  // { success: false, error: string }. Returning bare undefined
  // would crash on the `emailResult.success` check downstream.
  sendEmail: (...args: Parameters<typeof mockSendEmail>) => {
    capturedEmails.push(args[0] as { htmlContent?: string; textContent?: string; subject?: string });
    return mockSendEmail(...args);
  },
  // Route's emailTemplates.passwordReset returns the SAME field names
  // the API caller hands to sendEmail — subject + htmlContent +
  // textContent. Earlier test version used html/text keys and
  // dropped the reset link from the captured body.
  emailTemplates: {
    passwordReset: (params: { recipientName: string; resetLink: string; expiresIn: string }) => ({
      subject: "Password Reset",
      htmlContent: `<a href="${params.resetLink}">Reset</a>`,
      textContent: `Reset link: ${params.resetLink}`,
    }),
  },
}));

vi.mock("@/lib/security", () => ({
  checkRateLimit: (...args: Parameters<typeof mockCheckRateLimit>) => mockCheckRateLimit(...args),
  getClientIp: () => "127.0.0.1",
  hashVerificationToken: (...args: Parameters<typeof mockHashVerificationToken>) =>
    mockHashVerificationToken(...args),
}));

import { POST } from "@/app/api/auth/forgot-password/route";

function makeReq(body: Record<string, unknown>) {
  return new Request("http://localhost/api/auth/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedEmails.length = 0;

  // Default happy-path stubs — overridden per test where needed.
  mockCheckRateLimit.mockReturnValue({ allowed: true });
  mockDb.user.findUnique.mockResolvedValue({
    id: "u-1",
    email: "user@example.com",
    firstName: "Test",
    lastName: "User",
  });
  // Transaction implementation just runs the callback against the
  // mocked tx (which here delegates back to mockDb for the relevant
  // verificationToken + auditLog writes the route makes inside).
  mockDb.$transaction.mockImplementation(async (cb: (tx: typeof mockDb) => Promise<unknown>) => cb(mockDb));
  mockDb.verificationToken.deleteMany.mockResolvedValue({ count: 0 });
  mockDb.verificationToken.create.mockResolvedValue({});
  mockDb.auditLog.create.mockResolvedValue({});
  mockSendEmail.mockResolvedValue({ success: true });
  mockHashVerificationToken.mockReturnValue("hashed-token-value");
});

describe("POST /api/auth/forgot-password — event-scoped reset link", () => {
  it("uses generic /reset-password path when eventSlug omitted", async () => {
    const res = await POST(makeReq({ email: "user@example.com" }));
    expect(res.status).toBe(200);
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
    expect(capturedEmails).toHaveLength(1);
    const emailBody = capturedEmails[0]?.htmlContent ?? "";
    expect(emailBody).toMatch(/\/reset-password\?token=/);
    expect(emailBody).not.toMatch(/\/e\//);
  });

  it("uses /e/{slug}/reset-password when eventSlug is provided AND event exists in DB", async () => {
    mockDb.event.findFirst.mockResolvedValueOnce({ slug: "hff2026" });
    const res = await POST(makeReq({ email: "user@example.com", eventSlug: "hff2026" }));
    expect(res.status).toBe(200);
    expect(mockDb.event.findFirst).toHaveBeenCalledWith({
      where: { slug: "hff2026" },
      select: { slug: true },
    });
    expect(capturedEmails).toHaveLength(1);
    const emailBody = capturedEmails[0]?.htmlContent ?? "";
    expect(emailBody).toMatch(/\/e\/hff2026\/reset-password\?token=/);
  });

  it("falls back to /reset-password when eventSlug doesn't match any DB event (no 400)", async () => {
    // This is the defensive case — a malicious or buggy client posts
    // a regex-valid but DB-nonexistent slug. The user still gets a
    // working reset email, just without event branding.
    mockDb.event.findFirst.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ email: "user@example.com", eventSlug: "doesnt-exist" }));
    expect(res.status).toBe(200);
    expect(mockDb.event.findFirst).toHaveBeenCalled();
    expect(capturedEmails).toHaveLength(1);
    const emailBody = capturedEmails[0]?.htmlContent ?? "";
    expect(emailBody).toMatch(/\/reset-password\?token=/);
    expect(emailBody).not.toMatch(/\/e\//);
  });

  it("rejects eventSlug failing the regex BEFORE the DB lookup (path traversal attempt)", async () => {
    const res = await POST(makeReq({
      email: "user@example.com",
      eventSlug: "../admin",  // not allowed by /^[a-z0-9][a-z0-9-]{0,63}$/i
    }));
    expect(res.status).toBe(400);
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
    expect(capturedEmails).toHaveLength(0);
  });

  it("accepts a 64-character slug (max length boundary)", async () => {
    const slug = "a" + "b".repeat(63);
    mockDb.event.findFirst.mockResolvedValueOnce({ slug });
    const res = await POST(makeReq({ email: "user@example.com", eventSlug: slug }));
    expect(res.status).toBe(200);
    expect(capturedEmails[0]?.htmlContent).toMatch(new RegExp(`/e/${slug}/reset-password`));
  });

  it("rejects a 65-character slug (one past max)", async () => {
    const slug = "a" + "b".repeat(64);
    const res = await POST(makeReq({ email: "user@example.com", eventSlug: slug }));
    expect(res.status).toBe(400);
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
  });

  it("preserves account-enumeration safety with eventSlug — 200 even for unknown email", async () => {
    // The whole flow is supposed to return 200 regardless of whether
    // the email exists. Adding eventSlug must not break that guarantee.
    mockDb.user.findUnique.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ email: "nobody@example.com", eventSlug: "hff2026" }));
    expect(res.status).toBe(200);
    // No email sent because no user — but the API still says 200,
    // and the DB event lookup is skipped (we short-circuit before
    // reaching it when no user exists, since we never need the link).
    expect(capturedEmails).toHaveLength(0);
  });
});
