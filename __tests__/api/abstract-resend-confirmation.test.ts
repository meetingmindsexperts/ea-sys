/**
 * Manual resend of the abstract-submission-confirmation email (Aug 4, 2026
 * organizer request — "resend from speaker"). Mirrors the reviewer
 * resend-invitation pattern: same shared send implementation as the automatic
 * create/resubmit sends, but a failure SURFACES (502) instead of the auto
 * path's fire-and-forget.
 *
 * Uses the REAL denyReviewer + requireOrgId + runWithTenant (only db / auth /
 * security / the send helper are mocked) so the RBAC matrix is pinned against
 * the real guards.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, sendConfirmationSpy, rateLimitSpy } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    abstract: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
  },
  mockAuth: vi.fn(),
  sendConfirmationSpy: vi.fn().mockResolvedValue(true),
  rateLimitSpy: vi.fn().mockReturnValue({ allowed: true, retryAfterSeconds: 0 }),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({
  getClientIp: () => "1.2.3.4",
  checkRateLimit: rateLimitSpy,
}));
vi.mock("@/lib/abstract-notifications", () => ({
  sendAbstractSubmissionConfirmation: sendConfirmationSpy,
}));

import { POST } from "@/app/api/events/[eventId]/abstracts/[abstractId]/resend-confirmation/route";

const params = Promise.resolve({ eventId: "ev1", abstractId: "ab1" });
const req = () => new Request("http://localhost/resend-confirmation", { method: "POST" });

const speaker = {
  id: "sp1",
  email: "author@x.com",
  additionalEmail: null,
  firstName: "Amina",
  lastName: "Khan",
  title: "DR",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ORGANIZER", organizationId: "org1" } });
  rateLimitSpy.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", name: "MedCon 2026" });
  mockDb.abstract.findFirst.mockResolvedValue({
    id: "ab1",
    title: "AI in Cardiology",
    status: "SUBMITTED",
    serialId: 7,
    speaker,
  });
  mockDb.user.findUnique.mockResolvedValue({ emailSignature: "<p>— Krishna</p>" });
  sendConfirmationSpy.mockResolvedValue(true);
});

describe("abstract resend-confirmation — auth matrix", () => {
  it("401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(req(), { params });
    expect(res.status).toBe(401);
    expect(sendConfirmationSpy).not.toHaveBeenCalled();
  });

  it.each(["MEMBER", "REVIEWER", "SUBMITTER", "ONSITE"])("403 for %s (real denyReviewer)", async (role) => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role, organizationId: "org1" } });
    const res = await POST(req(), { params });
    expect(res.status).toBe(403);
    expect(sendConfirmationSpy).not.toHaveBeenCalled();
  });

  it("404 when the event isn't in the caller's org", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await POST(req(), { params });
    expect(res.status).toBe(404);
    expect(mockDb.event.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ev1", organizationId: "org1" } }),
    );
    expect(sendConfirmationSpy).not.toHaveBeenCalled();
  });

  it("404 when the abstract doesn't belong to this event (bound {id, eventId})", async () => {
    mockDb.abstract.findFirst.mockResolvedValue(null);
    const res = await POST(req(), { params });
    expect(res.status).toBe(404);
    expect(mockDb.abstract.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ab1", eventId: "ev1" } }),
    );
    expect(sendConfirmationSpy).not.toHaveBeenCalled();
  });

  it("429 when rate-limited, with Retry-After semantics", async () => {
    rateLimitSpy.mockReturnValue({ allowed: false, retryAfterSeconds: 120 });
    const res = await POST(req(), { params });
    const body = await res.json();
    expect(res.status).toBe(429);
    expect(body.retryAfterSeconds).toBe(120);
    expect(sendConfirmationSpy).not.toHaveBeenCalled();
  });
});

describe("abstract resend-confirmation — resendability gates", () => {
  it.each(["DRAFT", "WITHDRAWN"])("400 NOT_RESENDABLE for a %s abstract", async (status) => {
    mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1", title: "T", status, serialId: 1, speaker });
    const res = await POST(req(), { params });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.code).toBe("NOT_RESENDABLE");
    expect(sendConfirmationSpy).not.toHaveBeenCalled();
  });

  it.each(["SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"])(
    "%s abstracts ARE resendable (they were submitted at some point)",
    async (status) => {
      mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1", title: "T", status, serialId: 1, speaker });
      const res = await POST(req(), { params });
      expect(res.status).toBe(200);
      expect(sendConfirmationSpy).toHaveBeenCalledTimes(1);
    },
  );

  it("400 NO_SPEAKER_EMAIL when the author has no address", async () => {
    mockDb.abstract.findFirst.mockResolvedValue({
      id: "ab1", title: "T", status: "SUBMITTED", serialId: 1,
      speaker: { ...speaker, email: null },
    });
    const res = await POST(req(), { params });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.code).toBe("NO_SPEAKER_EMAIL");
    expect(sendConfirmationSpy).not.toHaveBeenCalled();
  });
});

describe("abstract resend-confirmation — send + audit", () => {
  it("200: sends via the SHARED helper with the resending organizer's signature + audits", async () => {
    const res = await POST(req(), { params });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, sentTo: "author@x.com" });
    // The manual resend and the automatic sends share ONE implementation —
    // same slug, same vars, same EmailLog shape (helper owns all of it).
    expect(sendConfirmationSpy).toHaveBeenCalledWith({
      eventId: "ev1",
      organizationId: "org1",
      eventName: "MedCon 2026",
      abstractId: "ab1",
      abstractTitle: "AI in Cardiology",
      serialId: 7,
      speaker,
      triggeredByUserId: "admin1",
      // Manual sends carry the sender's saved signature; automated sends
      // deliberately leave {{organizerSignature}} empty.
      organizerSignature: "<p>— Krishna</p>",
    });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "EMAIL_SENT",
          entityType: "Abstract",
          entityId: "ab1",
          changes: expect.objectContaining({ resend: "abstract-submission-confirmation", recipient: "author@x.com" }),
        }),
      }),
    );
  });

  it("502 EMAIL_SEND_FAILED when the send fails — surfaced, not swallowed", async () => {
    sendConfirmationSpy.mockResolvedValue(false);
    const res = await POST(req(), { params });
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.code).toBe("EMAIL_SEND_FAILED");
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("a sender with no saved signature sends with organizerSignature null (renders empty)", async () => {
    mockDb.user.findUnique.mockResolvedValue({ emailSignature: null });
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    expect(sendConfirmationSpy).toHaveBeenCalledWith(
      expect.objectContaining({ organizerSignature: null }),
    );
  });
});
