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

const { mockDb, mockAuth, ensureCompanionSpy, createRegistrationSpy, cancelRegistrationSpy } =
  vi.hoisted(() => ({
    mockDb: {
      event: { findFirst: vi.fn() },
      speaker: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
      registration: { findFirst: vi.fn() },
      pricingTier: { count: vi.fn() },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    },
    mockAuth: vi.fn(),
    ensureCompanionSpy: vi.fn(),
    createRegistrationSpy: vi.fn(),
    cancelRegistrationSpy: vi.fn(),
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
vi.mock("@/services/registration-service", () => ({
  createRegistration: createRegistrationSpy,
}));
vi.mock("@/services/payment-service", () => ({
  cancelRegistration: cancelRegistrationSpy,
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
  // H2: the payable link is a conditional updateMany claim — default: won.
  mockDb.speaker.updateMany.mockResolvedValue({ count: 1 });
  mockDb.speaker.findUnique.mockResolvedValue({ sourceRegistrationId: null });
  // H1: the route fetches the linked/created row's REAL state for the response.
  mockDb.registration.findFirst.mockResolvedValue({ status: "CONFIRMED", paymentStatus: "COMPLIMENTARY" });
  mockDb.pricingTier.count.mockResolvedValue(0);
  mockDb.auditLog.create.mockResolvedValue({});
  ensureCompanionSpy.mockResolvedValue({ status: "created", registrationId: "reg1" });
  cancelRegistrationSpy.mockResolvedValue({ ok: true });
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
      // H2: the raw pointer rides along for the conditional link claim.
      { expectedLink: null },
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
      // H2: the claim asserts the RAW pointer (the cancelled id), so two
      // concurrent re-grants can't both mint.
      { expectedLink: "reg-dead" },
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
      { expectedLink: "reg-live" },
    );
  });

  it("H1: the comp response carries the linked row's REAL status/paymentStatus", async () => {
    ensureCompanionSpy.mockResolvedValue({ status: "linked-by-email", registrationId: "reg-paid" });
    // The linked row is a PAID delegate registration — the sheet must see that,
    // never a fabricated COMPLIMENTARY (which exposed the no-refund Revoke).
    mockDb.registration.findFirst.mockResolvedValue({ status: "CONFIRMED", paymentStatus: "PAID" });
    const res = await POST(req, routeParams);
    const body = await res.json();
    expect(body).toMatchObject({
      outcome: "linked-by-email",
      registrationId: "reg-paid",
      status: "CONFIRMED",
      paymentStatus: "PAID",
    });
    // Fetched event-bound, by the linked id.
    expect(mockDb.registration.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "reg-paid", eventId: "ev1" } }),
    );
  });

  it("500s (and logs) when the helper throws — never a silent success", async () => {
    ensureCompanionSpy.mockRejectedValue(new Error("db down"));
    const res = await POST(req, routeParams);
    expect(res.status).toBe(500);
  });
});

// ── Payable mode (owner decision Aug 5, 2026) ────────────────────────────────
// Proposal signups no longer auto-mint anything; the organizer grants comp OR
// a payable registration on a chosen type — the latter delegates to
// registration-service.createRegistration (seat claim, UNASSIGNED payment
// default, confirmation email + quote + Pay Now link) and links the new
// registration as the speaker's attendee facet.
const payableReq = (body: Record<string, unknown>) =>
  new Request("http://test/api/events/ev1/speakers/sp1/grant-companion", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("grant-companion payable mode", () => {
  beforeEach(() => {
    createRegistrationSpy.mockResolvedValue({
      ok: true,
      registration: { id: "reg-pay", status: "CONFIRMED", paymentStatus: "UNASSIGNED" },
    });
  });

  it("400 TICKET_TYPE_REQUIRED without a ticketTypeId", async () => {
    const res = await POST(payableReq({ mode: "payable" }), routeParams);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("TICKET_TYPE_REQUIRED");
    expect(createRegistrationSpy).not.toHaveBeenCalled();
  });

  it("mints via registration-service from the SPEAKER's details, links the facet, audits mode=payable", async () => {
    const res = await POST(
      payableReq({ mode: "payable", ticketTypeId: "tt1", pricingTierId: "tier1" }),
      routeParams,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      outcome: "payable-created",
      registrationId: "reg-pay",
      // H1: real row state in the response (requiresApproval types create
      // PENDING — the sheet renders what actually happened).
      status: "CONFIRMED",
      paymentStatus: "UNASSIGNED",
    });
    // Service input carries the speaker's own details — no re-registration.
    expect(createRegistrationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "ev1",
        ticketTypeId: "tt1",
        pricingTierId: "tier1",
        source: "rest",
        attendee: expect.objectContaining({
          email: "prop@x.com",
          firstName: "Pat",
          lastName: "Proposer",
          organization: "Uni",
        }),
      }),
    );
    // H2: the link is a CONDITIONAL claim on the pointer the route read.
    expect(mockDb.speaker.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sp1", sourceRegistrationId: null },
        data: { sourceRegistrationId: "reg-pay" },
      }),
    );
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "COMPANION_GRANTED",
          changes: expect.objectContaining({ mode: "payable", ticketTypeId: "tt1" }),
        }),
      }),
    );
    expect(ensureCompanionSpy).not.toHaveBeenCalled(); // payable never runs the comp path
  });

  it("409 ALREADY_HAS_REGISTRATION when a LIVE registration is already linked", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({
      ...SPEAKER_ROW,
      sourceRegistrationId: "reg-live",
      sourceRegistration: { status: "CONFIRMED" },
    });
    const res = await POST(payableReq({ mode: "payable", ticketTypeId: "tt1" }), routeParams);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("ALREADY_HAS_REGISTRATION");
    expect(createRegistrationSpy).not.toHaveBeenCalled();
  });

  it("a CANCELLED link does NOT block a payable grant (revoked → grant payable works)", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({
      ...SPEAKER_ROW,
      sourceRegistrationId: "reg-dead",
      sourceRegistration: { status: "CANCELLED" },
    });
    const res = await POST(payableReq({ mode: "payable", ticketTypeId: "tt1" }), routeParams);
    expect(res.status).toBe(200);
    expect(createRegistrationSpy).toHaveBeenCalled();
  });

  it("ALREADY_REGISTERED from the service → links the existing registration instead of failing", async () => {
    createRegistrationSpy.mockResolvedValue({
      ok: false,
      code: "ALREADY_REGISTERED",
      message: "already registered",
      meta: { existingRegistrationId: "reg-prior" },
    });
    const res = await POST(payableReq({ mode: "payable", ticketTypeId: "tt1" }), routeParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "linked-existing", registrationId: "reg-prior" });
    expect(mockDb.speaker.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { sourceRegistrationId: "reg-prior" } }),
    );
  });

  it("service rejections surface with their code (e.g. the Faculty-type guard)", async () => {
    createRegistrationSpy.mockResolvedValue({
      ok: false,
      code: "TICKET_TYPE_IS_FACULTY",
      message: "Faculty types are granted as complimentary, not payable",
    });
    const res = await POST(payableReq({ mode: "payable", ticketTypeId: "tt-fac" }), routeParams);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("TICKET_TYPE_IS_FACULTY");
    expect(mockDb.speaker.update).not.toHaveBeenCalled();
  });

  it("an empty body still means the historical comp grant (backward compat)", async () => {
    const res = await POST(req, routeParams);
    expect(res.status).toBe(200);
    expect(ensureCompanionSpy).toHaveBeenCalled();
    expect(createRegistrationSpy).not.toHaveBeenCalled();
  });

  it("M2: a NON-empty unparseable body 400s INVALID_JSON — never silently degrades to a comp grant", async () => {
    const badReq = new Request("http://test/api/events/ev1/speakers/sp1/grant-companion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{mode: payable",
    });
    const res = await POST(badReq, routeParams);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_JSON");
    expect(ensureCompanionSpy).not.toHaveBeenCalled();
    expect(createRegistrationSpy).not.toHaveBeenCalled();
  });

  it("M6: payable on a tier-priced type WITHOUT a tier 400s PRICING_TIER_REQUIRED (no silent $0 comp)", async () => {
    mockDb.pricingTier.count.mockResolvedValue(2);
    const res = await POST(payableReq({ mode: "payable", ticketTypeId: "tt-tiered" }), routeParams);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("PRICING_TIER_REQUIRED");
    expect(createRegistrationSpy).not.toHaveBeenCalled();
  });

  it("M5: the payable grant passes overrideSalesWindow (organizer action — review happens after sales close)", async () => {
    await POST(payableReq({ mode: "payable", ticketTypeId: "tt1" }), routeParams);
    expect(createRegistrationSpy).toHaveBeenCalledWith(
      expect.objectContaining({ overrideSalesWindow: true }),
    );
  });

  it("H2: a LOST payable race cancels the duplicate registration and 409s GRANT_RACE_LOST", async () => {
    // The conditional link claim matches 0 rows — a concurrent grant won
    // AFTER our registration (and its email) was created.
    mockDb.speaker.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(payableReq({ mode: "payable", ticketTypeId: "tt1" }), routeParams);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("GRANT_RACE_LOST");
    // The duplicate is compensated by a no-refund cancel through the service.
    expect(cancelRegistrationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        registrationId: "reg-pay",
        eventId: "ev1",
        refund: false,
      }),
    );
    // No audit row for a grant that did not stand.
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });
});
