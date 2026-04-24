/**
 * Unit tests for the three dedicated PATCH email-change routes:
 *   - /api/events/[eventId]/speakers/[speakerId]/email   (PATCH)
 *   - /api/events/[eventId]/registrations/[registrationId]/email (PATCH)
 *   - /api/contacts/[contactId]/email                   (PATCH)
 *
 * The general-purpose PUT routes now reject `email` with a 400
 * EMAIL_IMMUTABLE — these dedicated PATCH paths own the collision
 * check + User.email cascade + Contact re-sync + audit log.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockGetOrgContext, mockDb, mockRateLimit } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockGetOrgContext: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    speaker: { findFirst: vi.fn(), update: vi.fn() },
    registration: { findFirst: vi.fn(), count: vi.fn(), update: vi.fn() },
    attendee: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    user: { findFirst: vi.fn(), update: vi.fn() },
    contact: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
    $transaction: vi.fn(),
  },
  mockRateLimit: vi.fn((): { allowed: boolean; retryAfterSeconds: number } => ({
    allowed: true,
    retryAfterSeconds: 0,
  })),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Map<string, string>(Object.entries(init?.headers ?? {})),
    }),
  },
}));

vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/api-auth", () => ({ getOrgContext: () => mockGetOrgContext() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));

vi.mock("@/lib/security", () => ({
  getClientIp: vi.fn(() => "127.0.0.1"),
  checkRateLimit: () => mockRateLimit(),
  hashVerificationToken: vi.fn((t: string) => `hashed:${t}`),
}));

vi.mock("@/lib/auth-guards", () => ({
  denyReviewer: (session: { user?: { role?: string } } | null) => {
    const role = session?.user?.role;
    if (role === "REVIEWER" || role === "SUBMITTER" || role === "REGISTRANT") {
      return { status: 403, json: async () => ({ error: "Forbidden" }), headers: new Map() };
    }
    return null;
  },
}));

import { PATCH as speakerPatch } from "@/app/api/events/[eventId]/speakers/[speakerId]/email/route";
import { PATCH as regPatch } from "@/app/api/events/[eventId]/registrations/[registrationId]/email/route";
import { PATCH as contactPatch } from "@/app/api/contacts/[contactId]/email/route";

const adminSession = { user: { id: "user-1", role: "ADMIN", organizationId: "org-1" } };

function makeReq(body: unknown) {
  return new Request("http://localhost/api/x", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => unknown) => fn(mockDb));
  // Default: attendee is not shared across registrations (direct-update path).
  mockDb.registration.count.mockResolvedValue(0);
});

// ─── Speaker PATCH ──────────────────────────────────────────────────────────

describe("PATCH /api/events/[eventId]/speakers/[speakerId]/email", () => {
  const speakerParams = { params: Promise.resolve({ eventId: "evt-1", speakerId: "spk-1" }) };

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValueOnce(null);
    const res = await speakerPatch(makeReq({ newEmail: "new@x.com" }), speakerParams);
    expect(res.status).toBe(401);
  });

  it("returns 403 for reviewers", async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: "r", role: "REVIEWER" } });
    const res = await speakerPatch(makeReq({ newEmail: "new@x.com" }), speakerParams);
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate limit is exceeded", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockRateLimit.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 3600 });
    const res = await speakerPatch(makeReq({ newEmail: "new@x.com" }), speakerParams);
    expect(res.status).toBe(429);
  });

  it("returns 400 INVALID_EMAIL for malformed input", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    const res = await speakerPatch(makeReq({ newEmail: "nope" }), speakerParams);
    expect(res.status).toBe(400);
  });

  it("returns 404 when event not found", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce(null);
    mockDb.speaker.findFirst.mockResolvedValueOnce(null);
    const res = await speakerPatch(makeReq({ newEmail: "new@x.com" }), speakerParams);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/event/i);
  });

  it("returns 400 NO_CHANGE when new email equals current (case-insensitive)", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1", organizationId: "org-1" });
    mockDb.speaker.findFirst.mockResolvedValueOnce({
      id: "spk-1",
      email: "Alice@Example.com",
      userId: null,
      firstName: "A",
      lastName: "B",
    });
    const res = await speakerPatch(makeReq({ newEmail: "alice@example.com" }), speakerParams);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NO_CHANGE");
  });

  it("returns 409 SPEAKER_EMAIL_TAKEN when another speaker at new email exists", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1", organizationId: "org-1" });
    mockDb.speaker.findFirst
      .mockResolvedValueOnce({ id: "spk-1", email: "old@x.com", userId: null, firstName: "A", lastName: "B" })
      .mockResolvedValueOnce({ id: "spk-2" }); // collision
    const res = await speakerPatch(makeReq({ newEmail: "new@x.com" }), speakerParams);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("SPEAKER_EMAIL_TAKEN");
  });

  it("returns 409 USER_EMAIL_TAKEN when the linked user's email would collide globally", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1", organizationId: "org-1" });
    mockDb.speaker.findFirst
      .mockResolvedValueOnce({ id: "spk-1", email: "old@x.com", userId: "u-1", firstName: "A", lastName: "B" })
      .mockResolvedValueOnce(null); // no speaker collision
    mockDb.user.findFirst.mockResolvedValueOnce({ id: "u-2" }); // user collision
    const res = await speakerPatch(makeReq({ newEmail: "new@x.com" }), speakerParams);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("USER_EMAIL_TAKEN");
  });

  it("cascades to User.email + repoints Contact on happy path", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1", organizationId: "org-1" });
    mockDb.speaker.findFirst
      .mockResolvedValueOnce({ id: "spk-1", email: "old@x.com", userId: "u-1", firstName: "A", lastName: "B" })
      .mockResolvedValueOnce(null);
    mockDb.user.findFirst.mockResolvedValueOnce(null);
    mockDb.speaker.update.mockResolvedValueOnce({ id: "spk-1", email: "new@x.com" });
    mockDb.user.update.mockResolvedValueOnce({ id: "u-1", email: "new@x.com" });
    mockDb.contact.findFirst
      .mockResolvedValueOnce({ id: "c-old" }) // find old contact
      .mockResolvedValueOnce(null); // no collision at new
    mockDb.contact.update.mockResolvedValueOnce({ id: "c-old", email: "new@x.com" });

    const res = await speakerPatch(makeReq({ newEmail: "new@x.com" }), speakerParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userCascaded).toBe(true);
    expect(body.contactAction).toBe("updated");
    expect(mockDb.speaker.update).toHaveBeenCalledWith({
      where: { id: "spk-1" },
      data: { email: "new@x.com" },
    });
    expect(mockDb.user.update).toHaveBeenCalledWith({
      where: { id: "u-1" },
      data: { email: "new@x.com" },
    });
    expect(mockDb.auditLog.create).toHaveBeenCalled();
  });

  it("skips User cascade when speaker.userId is null but still checks for shadow User", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1", organizationId: "org-1" });
    mockDb.speaker.findFirst
      .mockResolvedValueOnce({ id: "spk-1", email: "old@x.com", userId: null, firstName: "A", lastName: "B" })
      .mockResolvedValueOnce(null);
    // Shadow-user lookup — no matching User row exists
    mockDb.user.findFirst.mockResolvedValueOnce(null);
    mockDb.speaker.update.mockResolvedValueOnce({ id: "spk-1", email: "new@x.com" });
    mockDb.contact.findFirst.mockResolvedValueOnce(null); // no contact

    const res = await speakerPatch(makeReq({ newEmail: "new@x.com" }), speakerParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userCascaded).toBe(false);
    expect(body.contactAction).toBe("none");
    expect(mockDb.user.update).not.toHaveBeenCalled();
    // Shadow check runs once; no collision-scope check (speaker.userId is null)
    expect(mockDb.user.findFirst).toHaveBeenCalledTimes(1);
  });

  it("maps P2002 race to 409 EMAIL_TAKEN", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1", organizationId: "org-1" });
    mockDb.speaker.findFirst
      .mockResolvedValueOnce({ id: "spk-1", email: "old@x.com", userId: null, firstName: "A", lastName: "B" })
      .mockResolvedValueOnce(null);
    mockDb.$transaction.mockRejectedValueOnce(Object.assign(new Error("fail"), { code: "P2002" }));
    const res = await speakerPatch(makeReq({ newEmail: "new@x.com" }), speakerParams);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("EMAIL_TAKEN");
  });
});

// ─── Registration PATCH ─────────────────────────────────────────────────────

describe("PATCH /api/events/[eventId]/registrations/[registrationId]/email", () => {
  const regParams = { params: Promise.resolve({ eventId: "evt-1", registrationId: "reg-1" }) };

  it("returns 404 when registration not found", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1", organizationId: "org-1" });
    mockDb.registration.findFirst.mockResolvedValueOnce(null);
    const res = await regPatch(makeReq({ newEmail: "new@x.com" }), regParams);
    expect(res.status).toBe(404);
  });

  it("returns 400 NO_CHANGE when attendee email unchanged", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1", organizationId: "org-1" });
    mockDb.registration.findFirst.mockResolvedValueOnce({
      id: "reg-1",
      userId: null,
      attendee: { id: "att-1", email: "Same@X.com" },
    });
    const res = await regPatch(makeReq({ newEmail: "same@x.com" }), regParams);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NO_CHANGE");
  });

  it("cascades User.email when registration.userId is set", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1", organizationId: "org-1" });
    mockDb.registration.findFirst.mockResolvedValueOnce({
      id: "reg-1",
      userId: "u-1",
      attendee: { id: "att-1", email: "old@x.com" },
    });
    mockDb.user.findFirst.mockResolvedValueOnce(null);
    mockDb.attendee.update.mockResolvedValueOnce({ id: "att-1", email: "new@x.com" });
    mockDb.user.update.mockResolvedValueOnce({ id: "u-1", email: "new@x.com" });
    mockDb.contact.findFirst.mockResolvedValueOnce(null);

    const res = await regPatch(makeReq({ newEmail: "new@x.com" }), regParams);
    expect(res.status).toBe(200);
    expect(mockDb.user.update).toHaveBeenCalledWith({
      where: { id: "u-1" },
      data: { email: "new@x.com" },
    });
    expect(mockDb.attendee.update).toHaveBeenCalledWith({
      where: { id: "att-1" },
      data: { email: "new@x.com" },
    });
  });

  it("returns 409 USER_EMAIL_TAKEN on global user collision", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1", organizationId: "org-1" });
    mockDb.registration.findFirst.mockResolvedValueOnce({
      id: "reg-1",
      userId: "u-1",
      attendee: { id: "att-1", email: "old@x.com" },
    });
    mockDb.user.findFirst.mockResolvedValueOnce({ id: "u-2" });
    const res = await regPatch(makeReq({ newEmail: "new@x.com" }), regParams);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("USER_EMAIL_TAKEN");
  });

  it("clones the Attendee row when it is shared across multiple registrations", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1", organizationId: "org-1" });
    mockDb.registration.findFirst.mockResolvedValueOnce({
      id: "reg-1",
      userId: null,
      attendee: { id: "att-1", email: "old@x.com" },
    });
    // Attendee is linked to another registration → clone path
    mockDb.registration.count.mockResolvedValueOnce(1);
    mockDb.attendee.findUnique.mockResolvedValueOnce({
      id: "att-1",
      email: "old@x.com",
      firstName: "A",
      lastName: "B",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockDb.attendee.create.mockResolvedValueOnce({ id: "att-2", email: "new@x.com" });
    mockDb.registration.update.mockResolvedValueOnce({ id: "reg-1", attendeeId: "att-2" });
    mockDb.contact.findFirst.mockResolvedValueOnce(null);

    const res = await regPatch(makeReq({ newEmail: "new@x.com" }), regParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attendeeCloned).toBe(true);
    expect(body.attendee.id).toBe("att-2");
    expect(mockDb.attendee.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: "new@x.com", firstName: "A", lastName: "B" }) })
    );
    expect(mockDb.registration.update).toHaveBeenCalledWith({
      where: { id: "reg-1" },
      data: { attendeeId: "att-2" },
    });
    // The original attendee row is NOT mutated — siblings keep their email.
    expect(mockDb.attendee.update).not.toHaveBeenCalled();
  });

  it("reports merged when contact at new email already exists", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1", organizationId: "org-1" });
    mockDb.registration.findFirst.mockResolvedValueOnce({
      id: "reg-1",
      userId: null,
      attendee: { id: "att-1", email: "old@x.com" },
    });
    mockDb.attendee.update.mockResolvedValueOnce({ id: "att-1", email: "new@x.com" });
    mockDb.contact.findFirst
      .mockResolvedValueOnce({ id: "c-old" })
      .mockResolvedValueOnce({ id: "c-new" }); // collision → merge
    mockDb.contact.delete.mockResolvedValueOnce({ id: "c-old" });

    const res = await regPatch(makeReq({ newEmail: "new@x.com" }), regParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contactAction).toBe("merged");
    expect(mockDb.contact.delete).toHaveBeenCalledWith({ where: { id: "c-old" } });
  });
});

// ─── Contact PATCH ──────────────────────────────────────────────────────────

describe("PATCH /api/contacts/[contactId]/email", () => {
  const contactParams = { params: Promise.resolve({ contactId: "c-1" }) };

  it("returns 401 when getOrgContext returns null", async () => {
    mockGetOrgContext.mockResolvedValueOnce(null);
    const res = await contactPatch(makeReq({ newEmail: "new@x.com" }), contactParams);
    expect(res.status).toBe(401);
  });

  it("returns 403 for REVIEWER role", async () => {
    mockGetOrgContext.mockResolvedValueOnce({ organizationId: "org-1", userId: "u-1", role: "REVIEWER" });
    const res = await contactPatch(makeReq({ newEmail: "new@x.com" }), contactParams);
    expect(res.status).toBe(403);
  });

  it("returns 404 when contact not found in org", async () => {
    mockGetOrgContext.mockResolvedValueOnce({ organizationId: "org-1", userId: "u-1", role: "ADMIN" });
    mockDb.contact.findFirst.mockResolvedValueOnce(null);
    const res = await contactPatch(makeReq({ newEmail: "new@x.com" }), contactParams);
    expect(res.status).toBe(404);
  });

  it("returns 400 NO_CHANGE when email matches current", async () => {
    mockGetOrgContext.mockResolvedValueOnce({ organizationId: "org-1", userId: "u-1", role: "ADMIN" });
    mockDb.contact.findFirst.mockResolvedValueOnce({ id: "c-1", email: "Same@X.com" });
    const res = await contactPatch(makeReq({ newEmail: "same@x.com" }), contactParams);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NO_CHANGE");
  });

  it("returns 409 CONTACT_EMAIL_TAKEN on collision within org", async () => {
    mockGetOrgContext.mockResolvedValueOnce({ organizationId: "org-1", userId: "u-1", role: "ADMIN" });
    mockDb.contact.findFirst
      .mockResolvedValueOnce({ id: "c-1", email: "old@x.com" })
      .mockResolvedValueOnce({ id: "c-2" }); // collision
    const res = await contactPatch(makeReq({ newEmail: "new@x.com" }), contactParams);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONTACT_EMAIL_TAKEN");
  });

  it("happy path updates contact.email and writes audit", async () => {
    mockGetOrgContext.mockResolvedValueOnce({ organizationId: "org-1", userId: "u-1", role: "ADMIN" });
    mockDb.contact.findFirst
      .mockResolvedValueOnce({ id: "c-1", email: "old@x.com" })
      .mockResolvedValueOnce(null); // no collision
    mockDb.contact.update.mockResolvedValueOnce({ id: "c-1", email: "new@x.com" });

    const res = await contactPatch(makeReq({ newEmail: "new@x.com" }), contactParams);
    expect(res.status).toBe(200);
    expect(mockDb.contact.update).toHaveBeenCalledWith({
      where: { id: "c-1" },
      data: { email: "new@x.com" },
    });
    expect(mockDb.auditLog.create).toHaveBeenCalled();
  });
});
