/**
 * POST /api/events/[eventId]/speakers/[speakerId]/grant-companion — the
 * organizer's grant / RE-grant of a comp Faculty companion registration
 * (July 30, 2026 model: self-signup auto-mints the comp registration; the
 * organizer revokes via cancel and re-grants here; this route also recovers
 * a signup whose auto-provisioning hiccuped).
 *
 * Pins: the RBAC boundary (real denyReviewer — granting free entry is
 * ADMIN/ORGANIZER only), event access via the real buildEventAccessWhere,
 * the CANCELLED-link override (a revoked companion must NOT short-circuit
 * "already-linked" against a dead registration), and audit-on-grant.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, ensureCompanionSpy } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    speaker: { findFirst: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  mockAuth: vi.fn(),
  ensureCompanionSpy: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number; headers?: Record<string, string> }) => ({
      status: i?.status ?? 200,
      json: async () => b,
      headers: { get: (k: string) => i?.headers?.[k] ?? null, set: () => {} },
    }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/security", () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true, retryAfterSeconds: 0, remaining: 59 }),
  getClientIp: () => "1.2.3.4",
}));
vi.mock("@/lib/speaker-companion", () => ({
  ensureSpeakerCompanionRegistration: ensureCompanionSpy,
}));

import { POST } from "@/app/api/events/[eventId]/speakers/[speakerId]/grant-companion/route";
import { checkRateLimit } from "@/lib/security";

const routeParams = { params: Promise.resolve({ eventId: "ev1", speakerId: "sp1" }) };
const req = new Request("http://test/api/events/ev1/speakers/sp1/grant-companion", {
  method: "POST",
});

const ADMIN = { user: { id: "u-admin", role: "ADMIN", organizationId: "org1" } };

const SPEAKER_ROW = {
  id: "sp1",
  eventId: "ev1",
  email: "prop@x.com",
  firstName: "Pat",
  lastName: "Proposer",
  title: null,
  additionalEmail: null,
  organization: "Uni",
  jobTitle: null,
  phone: null,
  photo: null,
  city: null,
  state: null,
  zipCode: null,
  country: null,
  specialty: null,
  registrationType: null,
  role: null,
  sourceRegistrationId: null,
  sourceRegistration: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(ADMIN);
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  mockDb.speaker.findFirst.mockResolvedValue({ ...SPEAKER_ROW });
  mockDb.auditLog.create.mockResolvedValue({});
  ensureCompanionSpy.mockResolvedValue({ status: "created", registrationId: "reg1" });
  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true, retryAfterSeconds: 0, remaining: 59 });
});

describe("grant-companion RBAC", () => {
  it("401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(req, routeParams);
    expect(res.status).toBe(401);
    expect(ensureCompanionSpy).not.toHaveBeenCalled();
  });

  it.each(["SUBMITTER", "REVIEWER", "REGISTRANT", "MEMBER", "ONSITE"])(
    "403 for %s (real denyReviewer — granting free entry is staff-only)",
    async (role) => {
      mockAuth.mockResolvedValue({ user: { id: "u1", role, organizationId: "org1" } });
      const res = await POST(req, routeParams);
      expect(res.status).toBe(403);
      expect(ensureCompanionSpy).not.toHaveBeenCalled();
    },
  );

  it("404 when the event is outside the caller's access (real buildEventAccessWhere)", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await POST(req, routeParams);
    expect(res.status).toBe(404);
    // The lookup must have been org-bound, not a bare id fetch.
    const where = mockDb.event.findFirst.mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain("org1");
    expect(ensureCompanionSpy).not.toHaveBeenCalled();
  });

  it("404 when the speaker isn't in this event", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(null);
    const res = await POST(req, routeParams);
    expect(res.status).toBe(404);
    expect(mockDb.speaker.findFirst.mock.calls[0][0].where).toMatchObject({
      id: "sp1",
      eventId: "ev1",
    });
    expect(ensureCompanionSpy).not.toHaveBeenCalled();
  });

  it("429 when rate limited", async () => {
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: false, retryAfterSeconds: 60, remaining: 0 });
    const res = await POST(req, routeParams);
    expect(res.status).toBe(429);
    expect(ensureCompanionSpy).not.toHaveBeenCalled();
  });
});

describe("grant-companion behavior", () => {
  it("grants: delegates to ensureSpeakerCompanionRegistration and returns the outcome", async () => {
    const res = await POST(req, routeParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, outcome: "created", registrationId: "reg1" });
    expect(ensureCompanionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sp1", eventId: "ev1", email: "prop@x.com" }),
    );
    // The Prisma-relation field must NOT leak into the helper input.
    expect(ensureCompanionSpy.mock.calls[0][0]).not.toHaveProperty("sourceRegistration");
  });

  it("writes a COMPANION_GRANTED audit row on a real grant", async () => {
    await POST(req, routeParams);
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventId: "ev1",
          action: "COMPANION_GRANTED",
          entityType: "Speaker",
          entityId: "sp1",
        }),
      }),
    );
  });

  it("already-linked is an idempotent no-op: 200, no audit row", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({
      ...SPEAKER_ROW,
      sourceRegistrationId: "reg0",
      sourceRegistration: { status: "CONFIRMED" },
    });
    ensureCompanionSpy.mockResolvedValue({ status: "already-linked", registrationId: "reg0" });
    const res = await POST(req, routeParams);
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("already-linked");
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("RE-grant: a CANCELLED linked companion is passed as sourceRegistrationId null so a fresh one is minted", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({
      ...SPEAKER_ROW,
      sourceRegistrationId: "reg-dead",
      sourceRegistration: { status: "CANCELLED" },
    });
    await POST(req, routeParams);
    expect(ensureCompanionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRegistrationId: null }),
    );
  });

  it("a LIVE linked companion keeps its sourceRegistrationId (helper no-ops as already-linked)", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({
      ...SPEAKER_ROW,
      sourceRegistrationId: "reg-live",
      sourceRegistration: { status: "CONFIRMED" },
    });
    ensureCompanionSpy.mockResolvedValue({ status: "already-linked", registrationId: "reg-live" });
    await POST(req, routeParams);
    expect(ensureCompanionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRegistrationId: "reg-live" }),
    );
  });

  it("500s (and logs) when the helper throws — never a silent success", async () => {
    ensureCompanionSpy.mockRejectedValue(new Error("db down"));
    const res = await POST(req, routeParams);
    expect(res.status).toBe(500);
  });
});
