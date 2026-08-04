/**
 * Submitter My Details self-edit (Aug 4, 2026 — organizer-reported: profiles
 * minted via the sign-in shortcut are sparse and the person couldn't fix
 * them). PATCH /api/events/[eventId]/abstracts/my-profile.
 *
 * Pins: ownership by construction (own speaker resolved by userId — never a
 * caller-supplied id), email NOT editable through this route, null-clears vs
 * undefined-leaves semantics, self-audit with before→after, contact sync,
 * and the completeness helper backing the "complete your details" nudge.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, syncSpy, rateLimitSpy } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    speaker: { findFirst: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
  },
  mockAuth: vi.fn(),
  syncSpy: vi.fn().mockResolvedValue(undefined),
  rateLimitSpy: vi.fn().mockReturnValue({ allowed: true, retryAfterSeconds: 0 }),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4", checkRateLimit: rateLimitSpy }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: syncSpy }));
vi.mock("@/lib/event-access", () => ({
  buildEventAccessWhere: (_u: unknown, id: string) => ({ id }),
}));

import { PATCH } from "@/app/api/events/[eventId]/abstracts/my-profile/route";

const params = { params: Promise.resolve({ eventId: "ev1" }) };
const req = (body: unknown) =>
  new Request("http://localhost/my-profile", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

const existingSpeaker = {
  id: "sp1",
  title: null,
  role: null,
  firstName: "Krishna",
  lastName: "P",
  email: "krishna@x.com",
  additionalEmail: null,
  organization: null,
  jobTitle: null,
  phone: null,
  city: null,
  state: null,
  zipCode: null,
  country: null,
  specialty: null,
  customSpecialty: null,
  bio: null,
  photo: null,
  status: "CONFIRMED",
  agreementAcceptedAt: null,
  sourceRegistration: null,
  abstracts: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitSpy.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  mockAuth.mockResolvedValue({ user: { id: "u-sub", role: "SUBMITTER", organizationId: null } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1" });
  mockDb.speaker.findFirst.mockResolvedValue(structuredClone(existingSpeaker));
  mockDb.speaker.update.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    ...structuredClone(existingSpeaker),
    ...args.data,
  }));
});

describe("my-profile PATCH — ownership + auth", () => {
  it("401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PATCH(req({ phone: "123" }), params);
    expect(res.status).toBe(401);
  });

  it("resolves the caller's OWN speaker by userId — never a supplied id", async () => {
    await PATCH(req({ phone: "123" }), params);
    expect(mockDb.speaker.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { eventId: "ev1", userId: "u-sub" } }),
    );
  });

  it("404 NOT_A_SUBMITTER when the caller has no speaker on this event", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(null);
    const res = await PATCH(req({ phone: "123" }), params);
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.code).toBe("NOT_A_SUBMITTER");
    expect(mockDb.speaker.update).not.toHaveBeenCalled();
  });

  it("429 when rate-limited", async () => {
    rateLimitSpy.mockReturnValue({ allowed: false, retryAfterSeconds: 60 });
    const res = await PATCH(req({ phone: "123" }), params);
    expect(res.status).toBe(429);
    expect(mockDb.speaker.update).not.toHaveBeenCalled();
  });
});

describe("my-profile PATCH — field semantics", () => {
  it("updates the provided fields (incl. bio + photo) and leaves absent ones untouched", async () => {
    const res = await PATCH(
      req({
        role: "PHYSICIAN",
        specialty: "Cardiology",
        organization: "Tawam Hospital",
        jobTitle: "Consultant",
        phone: "+9715...",
        bio: "Short bio",
        photo: "/uploads/photos/2026/08/a.jpg",
      }),
      params,
    );
    expect(res.status).toBe(200);
    const data = mockDb.speaker.update.mock.calls[0][0].data;
    expect(data).toEqual({
      role: "PHYSICIAN",
      specialty: "Cardiology",
      organization: "Tawam Hospital",
      jobTitle: "Consultant",
      phone: "+9715...",
      bio: "Short bio",
      photo: "/uploads/photos/2026/08/a.jpg",
    });
    // Absent fields (firstName, city, …) are NOT in the update payload.
    expect(data).not.toHaveProperty("firstName");
    expect(data).not.toHaveProperty("email");
  });

  it("email is NOT editable through this route (immutability house rule)", async () => {
    const res = await PATCH(req({ email: "new@x.com", phone: "123" }), params);
    expect(res.status).toBe(200);
    expect(mockDb.speaker.update.mock.calls[0][0].data).not.toHaveProperty("email");
  });

  it("null CLEARS an optional field", async () => {
    await PATCH(req({ organization: null }), params);
    expect(mockDb.speaker.update.mock.calls[0][0].data).toEqual({ organization: null });
  });

  it("400 on an invalid role value (never a silent drop)", async () => {
    const res = await PATCH(req({ role: "SUPERHERO" }), params);
    expect(res.status).toBe(400);
    expect(mockDb.speaker.update).not.toHaveBeenCalled();
  });

  it("audits the self-edit with before→after for the touched fields + syncs the contact", async () => {
    await PATCH(req({ organization: "Tawam" }), params);
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "UPDATE",
          entityType: "Speaker",
          entityId: "sp1",
          changes: expect.objectContaining({
            source: "self",
            before: { organization: null },
            after: { organization: "Tawam" },
          }),
        }),
      }),
    );
    expect(syncSpy).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org1", email: "krishna@x.com", organization: "Tawam" }),
    );
  });
});

describe("profile completeness helper (the nudge's predicate)", () => {
  it("names exactly the missing required fields; complete profiles are quiet", async () => {
    const { missingProfileFields, isProfileIncomplete } = await import("@/lib/submitter-profile-completeness");
    expect(missingProfileFields(structuredClone(existingSpeaker))).toEqual([
      "Role", "Specialty", "Organization", "Job title", "Phone", "City", "Country",
    ]);
    const complete = {
      role: "PHYSICIAN", specialty: "Cardiology", organization: "Org",
      jobTitle: "Consultant", phone: "+971", city: "Dubai", country: "AE",
    };
    expect(isProfileIncomplete(complete)).toBe(false);
    // Whitespace-only counts as missing.
    expect(isProfileIncomplete({ ...complete, phone: "  " })).toBe(true);
  });
});
