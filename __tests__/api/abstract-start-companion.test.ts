/**
 * The abstract-start SIGN-IN door (review M9 — this route had ZERO tests):
 * despite its name it serves BOTH the abstract and session-proposal register
 * pages' existing-account paths, and it carries the same policy as the full
 * signup door:
 *   - PROPOSAL sign-ins are linkOnly (owner decision Aug 5, 2026 — no auto
 *     comp registration); ABSTRACT sign-ins still auto-mint.
 *   - A freshly-created speaker starts INVITED (both sources).
 *   - An EXISTING speaker's status is never touched (inheritance).
 * A refactor of this route must not silently reintroduce auto-comp for
 * proposers — that's exactly what this file pins.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, ensureCompanionSpy, upsertSpy, rateLimitSpy, compareSpy, txUserUpdate } = vi.hoisted(() => ({
  txUserUpdate: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    // Written by the shared public-credential guard (review M7).
    loginEvent: { create: vi.fn() },
    registration: { findFirst: vi.fn(), findMany: vi.fn() },
    // Read only by the lookup intent's prefill (Sep 29, 2026). What the person
    // gave ELSEWHERE comes through the shared rule (own-details-sources.ts):
    // the account's saved details, their latest speaker records and
    // registrations.
    speaker: { findFirst: vi.fn(), findMany: vi.fn() },
    accountProfile: { findUnique: vi.fn() },
    // No presenter rates on this event -> the D4 comp path, which is what this
    // file asserts. The route asks BEFORE the transaction (Sep 21, 2026), so
    // the mock has to answer.
    ticketType: { findMany: vi.fn().mockResolvedValue([]) },
    // The organisation's switches for Title, Role and Specialty (person-field-rules.ts).
    organization: { findUnique: vi.fn() },
  },
  ensureCompanionSpy: vi.fn(),
  upsertSpy: vi.fn(),
  rateLimitSpy: vi.fn(),
  compareSpy: vi.fn(),
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
vi.mock("bcryptjs", () => ({ default: { compare: (...a: unknown[]) => compareSpy(...a) } }));
vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (cb: (t: unknown) => unknown) =>
    cb({ user: { update: txUserUpdate } }),
}));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_org: string, cb: () => unknown) => cb(),
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  // The shared public-credential guard logs through authLogger.
  authLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/public-event", () => ({
  publicEventWhere: async () => ({ slug: "ev-slug" }),
}));
vi.mock("@/lib/security", () => ({
  checkRateLimit: (...a: unknown[]) => rateLimitSpy(...a),
  getClientIp: () => "1.2.3.4",
}));
vi.mock("@/lib/speaker-companion", () => ({
  ensureSpeakerCompanionRegistration: ensureCompanionSpy,
  upsertEventSpeaker: upsertSpy,
}));

import { POST } from "@/app/api/public/events/[slug]/abstract-start/route";

const params = { params: Promise.resolve({ slug: "ev-slug" }) };
const makeReq = (body: Record<string, unknown>) =>
  new Request("http://test/api/public/events/ev-slug/abstract-start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const validBody = { email: "jane@example.com", password: "secret123" };

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitSpy.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  compareSpy.mockResolvedValue(true);
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1" });
  // Nothing saved: today's rules.
  mockDb.organization.findUnique.mockResolvedValue({ settings: {} });
  mockDb.user.findUnique.mockResolvedValue({ email: "anna@example.com", emailConfirmedAt: new Date() });
  mockDb.user.findFirst.mockResolvedValue({
    id: "u1",
    role: "SUBMITTER",
    passwordHash: "hash",
    firstName: "Jane",
    lastName: "Doe",
    termsAcceptedAt: new Date("2026-01-01"),
  });
  mockDb.registration.findFirst.mockResolvedValue(null);
  mockDb.speaker.findFirst.mockResolvedValue(null);
  mockDb.registration.findMany.mockResolvedValue([]);
  mockDb.speaker.findMany.mockResolvedValue([]);
  mockDb.accountProfile.findUnique.mockResolvedValue(null);
  upsertSpy.mockResolvedValue("sp1");
  ensureCompanionSpy.mockResolvedValue({ status: "created", registrationId: "reg1" });
});

describe("abstract-start — companion policy per source", () => {
  it("an ABSTRACT sign-in still auto-mints (linkOnly false)", async () => {
    const res = await POST(makeReq(validBody), params);
    expect(res.status).toBe(200);
    expect(ensureCompanionSpy).toHaveBeenCalledTimes(1);
    // The decision, not the option object (see the submitter suite).
    expect(ensureCompanionSpy.mock.calls[0][1]?.linkOnly).not.toBe(true);
  });

  it("a PROPOSAL sign-in is linkOnly — NO auto comp registration (owner decision Aug 5, 2026)", async () => {
    const res = await POST(makeReq({ ...validBody, source: "proposal" }), params);
    expect(res.status).toBe(200);
    expect(ensureCompanionSpy.mock.calls[0][1]?.linkOnly).toBe(true);
  });

  it("a companion failure never fails the sign-in (failure-isolated)", async () => {
    ensureCompanionSpy.mockRejectedValueOnce(new Error("boom"));
    const res = await POST(makeReq({ ...validBody, source: "proposal" }), params);
    expect(res.status).toBe(200);
  });
});

describe("abstract-start — speaker status + source stamping", () => {
  it("creates fresh speakers as INVITED for BOTH sources (team confirms after review)", async () => {
    for (const source of ["abstract", "proposal"] as const) {
      upsertSpy.mockClear();
      await POST(makeReq({ ...validBody, source }), params);
      expect(upsertSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          profile: expect.objectContaining({ status: "INVITED", submitterSource: source }),
        }),
      );
    }
  });

  it("sign-in NEVER clobbers an existing profile (overwriteExisting: false — status inheritance lives in the upsert)", async () => {
    await POST(makeReq({ ...validBody, source: "proposal" }), params);
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ overwriteExisting: false }),
    );
  });
});

describe("abstract-start: who becomes a SUBMITTER by authoring", () => {
  const body = { email: "anna@example.com", password: "pw12345678", source: "abstract" };
  const asRole = (role: string) =>
    mockDb.user.findFirst.mockResolvedValue({ id: "u1", role, passwordHash: "hash", firstName: "J", lastName: "D", termsAcceptedAt: new Date("2026-01-01") });

  it.each(["REGISTRANT", "REVIEWER"])("a %s does: reviewing carries on from My Reviews", async (role) => {
    asRole(role);
    txUserUpdate.mockClear();
    const res = await POST(makeReq(body), params);
    expect(res.status).toBeLessThan(400);
    expect(txUserUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ role: "SUBMITTER" }) }));
  });

  it.each(["SUBMITTER", "ORGANIZER", "ADMIN"])("a %s keeps their role", async (role) => {
    asRole(role);
    txUserUpdate.mockClear();
    await POST(makeReq(body), params);
    expect(txUserUpdate).not.toHaveBeenCalled();
  });

  it("nobody changes without the right password", async () => {
    asRole("REVIEWER");
    compareSpy.mockResolvedValue(false);
    txUserUpdate.mockClear();
    expect((await POST(makeReq(body), params)).status).toBe(401);
    expect(txUserUpdate).not.toHaveBeenCalled();
  });
});

describe("abstract-start — guards", () => {
  it("401 on a wrong password, and the companion path never runs", async () => {
    compareSpy.mockResolvedValue(false);
    const res = await POST(makeReq(validBody), params);
    expect(res.status).toBe(401);
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(ensureCompanionSpy).not.toHaveBeenCalled();
  });

  // Review M7 — this door checks a password on the unauthenticated surface.
  it("a wrong password is RECORDED, so a spray here shows up in Sign-in Activity", async () => {
    compareSpy.mockResolvedValue(false);
    await POST(makeReq(validBody), params);
    expect(mockDb.loginEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ outcome: "FAILED_PASSWORD", userId: "u1", surface: "EVENT_PAGE" }),
      }),
    );
  });

  it("an unknown address is recorded as FAILED_UNKNOWN_EMAIL — spray, not targeting", async () => {
    mockDb.user.findFirst.mockResolvedValue(null);
    const res = await POST(makeReq(validBody), params);
    expect(res.status).toBe(401);
    expect(mockDb.loginEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ outcome: "FAILED_UNKNOWN_EMAIL", userId: null }),
      }),
    );
  });

  it("a SUCCESS here is NOT recorded — the client hands off to signIn(), which records it", async () => {
    const res = await POST(makeReq(validBody), params);
    expect(res.status).toBe(200);
    // A second row would double every successful sign-in in Sign-in Activity.
    expect(mockDb.loginEvent.create).not.toHaveBeenCalled();
  });

  it("429 when rate-limited (per email)", async () => {
    rateLimitSpy.mockReturnValue({ allowed: false, retryAfterSeconds: 60 });
    const res = await POST(makeReq(validBody), params);
    expect(res.status).toBe(429);
    expect(mockDb.user.findFirst).not.toHaveBeenCalled();
  });

  it("404 when the event doesn't resolve for this host/slug", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await POST(makeReq(validBody), params);
    expect(res.status).toBe(404);
  });
});

// Sep 29, 2026 (owner decision): an existing account gets the same details
// page as a new one. `intent: "lookup"` returns what is on file and creates
// nothing; the start call then carries the confirmed details.
describe("abstract-start — lookup, then confirmed details", () => {
  const details = {
    title: "DR",
    role: "PHYSICIAN",
    firstName: "Jane",
    lastName: "Doe",
    organization: "Heart Institute",
    jobTitle: "Consultant",
    phone: "+971500000000",
    city: "Dubai",
    country: "United Arab Emirates",
    specialty: "Cardiology",
  };

  it("lookup checks the password, returns details merged field by field, and creates nothing", async () => {
    // A speaker profile from ANOTHER event has the organisation; the latest
    // registration elsewhere has the phone; the account has the name.
    // Neither a speaker nor a registration on this event (the beforeEach).
    mockDb.speaker.findMany.mockResolvedValue([{ organization: "Heart Institute", jobTitle: "Consultant", phone: null }]);
    mockDb.registration.findMany.mockResolvedValue([{ attendee: { phone: "+971500000000", country: "United Arab Emirates" } }]);
    const res = await POST(makeReq({ ...validBody, intent: "lookup" }), params);
    expect(res.status).toBe(200);
    // Elsewhere means elsewhere: this event's own rows are read ahead of these.
    expect(mockDb.speaker.findMany.mock.calls[0][0].where).toMatchObject({ eventId: { not: "ev1" } });
    const body = (await res.json()) as { prefill: Record<string, string> };
    expect(body.prefill).toMatchObject({
      firstName: "Jane",
      lastName: "Doe",
      organization: "Heart Institute",
      jobTitle: "Consultant",
      phone: "+971500000000",
      country: "United Arab Emirates",
      specialty: "",
    });
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(ensureCompanionSpy).not.toHaveBeenCalled();
    expect(mockDb.ticketType.findMany).not.toHaveBeenCalled(); // no rate check on a lookup
  });

  it("lookup says whether the person already holds a registration here, so the form skips the ID fields", async () => {
    // Order: the registration on this event, then holdsLiveRegistration.
    mockDb.registration.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "reg-here" });
    mockDb.speaker.findFirst.mockResolvedValue(null);
    const res = await POST(makeReq({ ...validBody, intent: "lookup" }), params);
    expect(((await res.json()) as { registeredHere: boolean }).registeredHere).toBe(true);
  });

  it("start refuses a Student rate without the student ID, before setting anyone up", async () => {
    mockDb.ticketType.findMany.mockResolvedValueOnce([
      {
        id: "tt-stu", name: "Student", isActive: true, requiresStudentId: true,
        pricingTiers: [{ id: "tier-p", name: "Presenter", price: 0, currency: "USD", sortOrder: 3,
          quantity: 999999, soldCount: 0, salesStart: null, salesEnd: null }],
      },
    ]);
    const res = await POST(makeReq({ ...validBody, ticketTypeId: "tt-stu" }), params);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("IDENTITY_EVIDENCE_REQUIRED");
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(ensureCompanionSpy).not.toHaveBeenCalled();
  });

  it("lookup with a wrong password is a 401 and reveals nothing", async () => {
    compareSpy.mockResolvedValue(false);
    const res = await POST(makeReq({ ...validBody, intent: "lookup" }), params);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { prefill?: unknown }).prefill).toBeUndefined();
  });

  it("start with confirmed details refreshes the speaker from them and builds the registration from them", async () => {
    const res = await POST(makeReq({ ...validBody, details }), params);
    expect(res.status).toBe(200);
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        overwriteExisting: true,
        profile: expect.objectContaining({
          organization: "Heart Institute",
          phone: "+971500000000",
          country: "United Arab Emirates",
          specialty: "Cardiology",
        }),
      }),
    );
    expect(ensureCompanionSpy.mock.calls[0][0]).toMatchObject({
      organization: "Heart Institute",
      specialty: "Cardiology",
    });
  });

  // Review of 5dd9cd5f. This door also REFRESHES a speaker record that exists
  // (invited by the organisers, or a returning submitter), with
  // overwriteExisting. A field the event does not ask must reach that write
  // as `undefined` (leave what the record holds), never `null` (erase it):
  // the first version erased the title the organisers had entered.
  describe("a field this event does not ask is left on the record, never blanked", () => {
    const profileSent = () => upsertSpy.mock.calls[0][1].profile as Record<string, unknown>;

    it("with everything asked, the confirmed details are written as before", async () => {
      await POST(makeReq({ ...validBody, details: { ...details, specialty: "Others", customSpecialty: "Sleep medicine" } }), params);
      expect(profileSent()).toMatchObject({ title: "DR", role: "PHYSICIAN", specialty: "Others", customSpecialty: "Sleep medicine" });
    });

    it("a blank title on a form that ASKS it still clears it, as before", async () => {
      const { title: _t, ...noTitle } = details;
      void _t;
      await POST(makeReq({ ...validBody, details: noTitle }), params);
      expect(profileSent().title).toBeNull();
    });

    it("the EVENT does not ask Title or Role: both go as undefined, whatever the form re-posted", async () => {
      mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1", settings: { personFieldChoices: { title: "off", role: "off" } } });
      const res = await POST(makeReq({ ...validBody, details }), params);
      expect(res.status).toBe(200);
      const sent = profileSent();
      expect("title" in sent && sent.title).toBeUndefined();
      expect("role" in sent && sent.role).toBeUndefined();
      expect(sent.title).not.toBeNull();
      expect(sent.role).not.toBeNull();
      // What IS asked is still written.
      expect(sent.specialty).toBe("Cardiology");
    });

    it("the ORGANISATION switched Specialty off and the event chose nothing: specialty and its typed text are both left", async () => {
      mockDb.organization.findUnique.mockResolvedValue({ settings: { personFields: { specialty: { enabled: false } } } });
      const res = await POST(makeReq({ ...validBody, details: { ...details, specialty: "Others", customSpecialty: "Sleep medicine" } }), params);
      expect(res.status).toBe(200);
      const sent = profileSent();
      expect(sent.specialty).toBeUndefined();
      expect(sent.customSpecialty).toBeUndefined();
      expect(sent.title).toBe("DR");
    });
  });

  it("refuses details missing a required field, exactly as the new-account door does", async () => {
    const { organization: _dropped, ...incomplete } = details;
    void _dropped;
    const res = await POST(makeReq({ ...validBody, details: incomplete }), params);
    expect(res.status).toBe(400);
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});
