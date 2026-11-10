/**
 * The row's Send button on the Reviewers page: ONE reviewer, the one reviewer
 * invitation (Nov 10, 2026). Which of its two forms the reviewer gets, and the
 * set-password link, are sendReviewerInvitation's (its own test); this route
 * finds the reviewer on the event's pool, hands them over and reports the
 * outcome. A send failure surfaces (502).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, sendSpy } = vi.hoisted(() => {
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
    sendSpy: vi.fn(),
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
vi.mock("@/lib/abstract-reviewer-notify", async () => {
  const actual = await vi.importActual<typeof import("@/lib/abstract-reviewer-notify")>("@/lib/abstract-reviewer-notify");
  return { sendReviewerInvitation: sendSpy, inviterNameOf: actual.inviterNameOf };
});
vi.mock("@/lib/public-brand-server", () => ({ loadPublicBrandForOrg: async () => ({ name: "Meeting Minds Experts" }) }));

import { POST } from "@/app/api/events/[eventId]/reviewers/[reviewerId]/resend-invitation/route";

const params = Promise.resolve({ eventId: "ev1", reviewerId: "r1" });
const req = () => new Request("http://localhost/resend", { method: "POST" });

const REVIEWER = { id: "r1", email: "Rev@X.com", firstName: "Rev", lastName: "One", emailVerified: null, role: "REVIEWER" };

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ORGANIZER", organizationId: "org1", firstName: "A", lastName: "B", email: "a@b.com" } });
  mockDb.event.findFirst.mockResolvedValue({
    id: "ev1", name: "MedCon", slug: "medcon",
    settings: { reviewerUserIds: ["r1"] }, emailFromAddress: null, emailFromName: null,
  });
  mockDb.user.findUnique.mockResolvedValue(REVIEWER);
  sendSpy.mockResolvedValue({ ok: true, kind: "setup" });
});

describe("reviewer resend-invitation", () => {
  it("hands the reviewer to the one sender, with the event, the brand and who pressed Send", async () => {
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, sent: true, type: "setup" });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith({
      eventId: "ev1",
      organizationId: "org1",
      eventName: "MedCon",
      eventSlug: "medcon",
      reviewer: REVIEWER,
      organizationName: "Meeting Minds Experts",
      inviterName: "A B",
      triggeredByUserId: "admin1",
    });
    // The link is the sender's to mint: this route stores no token itself.
    expect(mockDb._tx.verificationToken.create).not.toHaveBeenCalled();
  });

  it("says which form went: a reviewer who can already sign in was sent the portal, no set-password link", async () => {
    sendSpy.mockResolvedValue({ ok: true, kind: "portal" });
    expect(await (await POST(req(), { params })).json()).toMatchObject({ type: "portal" });
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({ resend: "portal" });
  });

  it("a refused email is a 502 with its reason, never 'sent'", async () => {
    sendSpy.mockResolvedValueOnce({ ok: false, code: "SEND_FAILED", message: "Email not sent: it still contains {{venue}}" });
    const res = await POST(req(), { params });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Email not sent: it still contains {{venue}}", code: "EMAIL_SEND_FAILED" });
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("404 when the user isn't in the event's reviewer pool, and nothing is sent", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", name: "MedCon", slug: "medcon", settings: { reviewerUserIds: [] }, emailFromAddress: null, emailFromName: null });
    expect((await POST(req(), { params })).status).toBe(404);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("404 when the account is gone", async () => {
    mockDb.user.findUnique.mockResolvedValue(null);
    expect((await POST(req(), { params })).status).toBe(404);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
