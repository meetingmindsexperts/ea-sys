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

const { mockDb, mockAuth, syncSpy, rateLimitSpy, suggestSpy } = vi.hoisted(() => ({
  suggestSpy: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    speaker: { findFirst: vi.fn(), update: vi.fn() },
    organization: { findUnique: vi.fn() },
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

vi.mock("@/lib/submitter-profile-suggestions", () => ({ suggestSpeakerDetails: suggestSpy }));

import { GET, PATCH } from "@/app/api/events/[eventId]/abstracts/my-profile/route";
import { DEFAULT_PERSON_FIELD_RULES, type PersonFieldRules } from "@/lib/person-fields";

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
  suggestSpy.mockResolvedValue({ phone: "+971 50 000 0000" });
  mockAuth.mockResolvedValue({ user: { id: "u-sub", role: "SUBMITTER", organizationId: null, tokenVersion: 4 } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1" });
  // Nothing saved for the organisation: today's rules (Role and Specialty demanded).
  mockDb.organization.findUnique.mockResolvedValue({ settings: {} });
  mockDb.speaker.findFirst.mockResolvedValue(structuredClone(existingSpeaker));
  mockDb.speaker.update.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    ...structuredClone(existingSpeaker),
    ...args.data,
  }));
});

// The form opens filled with what the person gave elsewhere (Nov 10, 2026).
describe("my-profile GET: details the person already gave", () => {
  const get = () => GET(new Request("http://localhost/my-profile"), params);

  it("offers them for the CALLER and THIS event, beside the stored record", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { phone: string | null; suggested: Record<string, string> };
    expect(body.suggested).toEqual({ phone: "+971 50 000 0000" });
    // The stored value is untouched: only the person's own Save stores a suggestion.
    expect(body.phone).toBeNull();
    expect(mockDb.speaker.update).not.toHaveBeenCalled();
    expect(suggestSpy).toHaveBeenCalledWith({
      userId: "u-sub",
      eventId: "ev1",
      sessionTokenVersion: 4,
      current: expect.objectContaining({ id: "sp1", phone: null }),
      rules: DEFAULT_PERSON_FIELD_RULES,
    });
  });

  // Review of f0899baf: the browser's "profile complete?" gates judged by
  // today's rules whatever the organisation had switched off, and sent a
  // submitter round in a loop between Submit and My Details. The rules now
  // travel with the profile, read for the EVENT's organisation: the caller is
  // a submitter with no organisation of their own.
  it("sends the EVENT organisation's rules with the profile, for the gates and My Details", async () => {
    mockDb.organization.findUnique.mockResolvedValue({
      settings: { personFields: { specialty: { enabled: false }, role: { enabled: true, required: false } } },
    });
    const body = (await (await get()).json()) as { fieldRules: PersonFieldRules };
    expect(mockDb.organization.findUnique).toHaveBeenCalledWith({ where: { id: "org1" }, select: { settings: true } });
    expect(body.fieldRules).toEqual({
      title: { shown: true, required: true },
      role: { shown: true, required: false },
      specialty: { shown: false, required: false },
    });
    // The suggestions are judged by the same rules.
    expect(suggestSpy).toHaveBeenCalledWith(expect.objectContaining({ rules: body.fieldRules }));
    // And by them this record, which has neither a role nor a specialty, is
    // missing neither: the gate that reads this answer lets the person through
    // once the fields that ARE demanded are filled.
    const { missingProfileFields, rulesSentWith } = await import("@/lib/submitter-profile-completeness");
    const missing = missingProfileFields({ ...structuredClone(existingSpeaker), ...body }, rulesSentWith(body));
    expect(missing).not.toContain("Role");
    expect(missing).not.toContain("Specialty");
  });

  it("and the EVENT's own choice is laid over them: a field this event does not ask is not missing", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1", settings: { personFieldChoices: { role: "optional", specialty: "off" } } });
    const body = (await (await get()).json()) as { fieldRules: PersonFieldRules };
    expect(body.fieldRules.role).toEqual({ shown: true, required: false });
    expect(body.fieldRules.specialty).toEqual({ shown: false, required: false });
    // The event is read with its settings, which hold that choice.
    expect(mockDb.event.findFirst.mock.calls[0][0].select).toMatchObject({ settings: true });
  });

  it("an answer without rules (the other slot during a deploy) is judged by today's", async () => {
    const { rulesSentWith } = await import("@/lib/submitter-profile-completeness");
    expect(rulesSentWith({})).toEqual(DEFAULT_PERSON_FIELD_RULES);
  });

  it("someone with no speaker record here is offered nothing", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
    expect(suggestSpy).not.toHaveBeenCalled();
  });

  it("a save answers with the stored record only", async () => {
    const res = await PATCH(req({ phone: "123" }), params);
    expect(((await res.json()) as { suggested?: unknown }).suggested).toBeUndefined();
    expect(suggestSpy).not.toHaveBeenCalled();
  });
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

  it("the page sends every field on every save: only what DIFFERS replaces the contact's values (Nov 13, 2026)", async () => {
    // A phone change must not put this record's older photo and bio over newer
    // ones the contact got from another event. They may only fill a blank.
    const stored = { ...structuredClone(existingSpeaker), organization: "Tawam", phone: "+971 1", photo: "/uploads/old.jpg", bio: "Old bio" };
    mockDb.speaker.findFirst.mockResolvedValue(stored);
    mockDb.speaker.update.mockImplementation(async (args: { data: Record<string, unknown> }) => ({ ...structuredClone(stored), ...args.data }));
    const res = await PATCH(req({ organization: "Tawam", phone: "+971 2", photo: "/uploads/old.jpg", bio: "Old bio" }), params);
    expect(res.status).toBe(200);
    const payload = syncSpy.mock.calls[0][0];
    expect(payload.phone).toBe("+971 2");
    expect(payload).not.toHaveProperty("photo");
    expect(payload).not.toHaveProperty("bio");
    expect(payload).not.toHaveProperty("organization");
    expect(payload.fillBlanks).toMatchObject({ photo: "/uploads/old.jpg", bio: "Old bio", organization: "Tawam" });
    expect(payload).not.toHaveProperty("registrationType");
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

  it("NAME_IMMUTABLE: changing an already-set name is refused (400, no write) — contact the organizers", async () => {
    const res = await PATCH(req({ firstName: "Somebody", phone: "+9715" }), params);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NAME_IMMUTABLE");
    expect(mockDb.speaker.update).not.toHaveBeenCalled();
  });

  it("re-sending the SAME name (unchanged form echo) passes the name lock", async () => {
    const res = await PATCH(req({ firstName: "Krishna", lastName: "P", phone: "+9715" }), params);
    expect(res.status).toBe(200);
    expect(mockDb.speaker.update).toHaveBeenCalled();
  });

  it("a BLANK name on file can still be filled in once", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ ...structuredClone(existingSpeaker), lastName: "  " });
    const res = await PATCH(req({ lastName: "Pallapolu" }), params);
    expect(res.status).toBe(200);
    expect(mockDb.speaker.update.mock.calls[0][0].data).toEqual({ lastName: "Pallapolu" });
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
    const rules = DEFAULT_PERSON_FIELD_RULES;
    expect(missingProfileFields(structuredClone(existingSpeaker), rules)).toEqual([
      "Role", "Specialty", "Organization", "Job title", "Phone", "City", "Country", "Bio",
    ]);
    const complete = {
      role: "PHYSICIAN", specialty: "Cardiology", organization: "Org",
      jobTitle: "Consultant", phone: "+971", city: "Dubai", country: "AE",
      // Mandatory since Aug 7, 2026 (owner) — the bio is printed in the
      // programme, so an accepted speaker without one is a chase later.
      bio: "Consultant cardiologist, 12 years.",
    };
    expect(isProfileIncomplete(complete, rules)).toBe(false);
    // Whitespace-only counts as missing.
    expect(isProfileIncomplete({ ...complete, phone: "  " }, rules)).toBe(true);
    expect(isProfileIncomplete({ ...complete, bio: "   " }, rules)).toBe(true);
  });
});
