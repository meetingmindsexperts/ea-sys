/**
 * Reviewer invitation resend. Recovers a reviewer stranded by a failed/lost
 * invite: pending account → re-mint setup token + resend setup invite; active
 * account → resend the pool reminder. Unlike the silent add path, a send
 * failure surfaces (502).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, setupSpy, notifyPoolSpy } = vi.hoisted(() => {
  const tx = {
    verificationToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn().mockResolvedValue({}) },
  };
  return {
    mockDb: {
      event: { findFirst: vi.fn() },
      user: { findUnique: vi.fn() },
      organization: { findUnique: vi.fn().mockResolvedValue({ name: "Acme Org" }) },
      auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
      $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
      _tx: tx,
    },
    mockAuth: vi.fn(),
    setupSpy: vi.fn().mockResolvedValue({ ok: true }),
    notifyPoolSpy: vi.fn().mockResolvedValue({ ok: true }),
  };
});

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({
  getClientIp: () => "1.2.3.4",
  hashVerificationToken: (t: string) => `hash:${t}`,
  checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
}));
vi.mock("@/lib/abstract-reviewer-notify", () => ({ notifyReviewerPoolAdded: notifyPoolSpy, sendReviewerSetupInvitation: setupSpy }));

import { POST } from "@/app/api/events/[eventId]/reviewers/[reviewerId]/resend-invitation/route";

const params = Promise.resolve({ eventId: "ev1", reviewerId: "r1" });
const req = () => new Request("http://localhost/resend", { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ORGANIZER", organizationId: "org1", firstName: "A", lastName: "B", email: "a@b.com" } });
  mockDb.event.findFirst.mockResolvedValue({
    id: "ev1", name: "MedCon", slug: "medcon",
    settings: { reviewerUserIds: ["r1"] }, emailFromAddress: null, emailFromName: null,
  });
  setupSpy.mockResolvedValue({ ok: true });
  notifyPoolSpy.mockResolvedValue({ ok: true });
});

describe("reviewer resend-invitation", () => {
  it("the setup invite goes through the event's own template, with a fresh personal link and who sent it", async () => {
    mockDb.user.findUnique.mockResolvedValue({ id: "r1", email: "Rev@X.com", firstName: "Rev", lastName: "One", emailVerified: null });
    expect((await POST(req(), { params })).status).toBe(200);
    const sent = setupSpy.mock.calls[0][0];
    expect(sent).toMatchObject({ eventId: "ev1", eventName: "MedCon", reviewer: { id: "r1" }, inviterName: "A B", expiresIn: "7 days", triggeredByUserId: "admin1" });
    // The link carries the token that was just stored (hashed) and the event to land on.
    const token = new URL(sent.setupLink).searchParams.get("token");
    expect(mockDb._tx.verificationToken.create.mock.calls[0][0].data.token).toBe(`hash:${token}`);
    expect(sent.setupLink).toContain("email=rev%40x.com");
    expect(sent.setupLink).toContain("eventSlug=medcon");
  });

  it("pending account: re-mints a token + resends the setup invite", async () => {
    mockDb.user.findUnique.mockResolvedValue({ id: "r1", email: "Rev@X.com", firstName: "Rev", lastName: "One", emailVerified: null });
    const res = await POST(req(), { params });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.type).toBe("setup");
    expect(mockDb._tx.verificationToken.deleteMany).toHaveBeenCalledWith({ where: { identifier: "rev@x.com" } });
    expect(mockDb._tx.verificationToken.create).toHaveBeenCalledTimes(1);
    expect(setupSpy).toHaveBeenCalledTimes(1);
    expect(notifyPoolSpy).not.toHaveBeenCalled();
  });

  it("active account: resends the pool reminder (no token mint)", async () => {
    mockDb.user.findUnique.mockResolvedValue({ id: "r1", email: "rev@x.com", firstName: "Rev", lastName: "One", emailVerified: new Date() });
    const res = await POST(req(), { params });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.type).toBe("pool");
    expect(notifyPoolSpy).toHaveBeenCalledTimes(1);
    expect(setupSpy).not.toHaveBeenCalled();
    expect(mockDb._tx.verificationToken.create).not.toHaveBeenCalled();
  });

  it("active account: a refused email is a 502 with its reason, never 'sent' (Nov 10, 2026)", async () => {
    mockDb.user.findUnique.mockResolvedValue({ id: "r1", email: "rev@x.com", firstName: "Rev", lastName: "One", emailVerified: new Date() });
    notifyPoolSpy.mockResolvedValueOnce({ ok: false, code: "SEND_FAILED", message: "Email not sent: it still contains {{title}}" });
    const res = await POST(req(), { params });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Email not sent: it still contains {{title}}", code: "EMAIL_SEND_FAILED" });
  });

  it("pending account: a refused invitation is a 502 with its reason (an edited template can leave a token unfilled)", async () => {
    mockDb.user.findUnique.mockResolvedValue({ id: "r1", email: "rev@x.com", firstName: "Rev", lastName: "One", emailVerified: null });
    setupSpy.mockResolvedValueOnce({ ok: false, code: "SEND_FAILED", message: "Email not sent: it still contains {{venue}}" });
    const res = await POST(req(), { params });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Email not sent: it still contains {{venue}}", code: "EMAIL_SEND_FAILED" });
  });

  it("404 when the user isn't in the event's reviewer pool", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", name: "MedCon", slug: "medcon", settings: { reviewerUserIds: [] }, emailFromAddress: null, emailFromName: null });
    const res = await POST(req(), { params });
    expect(res.status).toBe(404);
  });
});
