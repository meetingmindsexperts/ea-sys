/**
 * My Details (Nov 9, 2026): what a save writes to the account, and which
 * registrations it reaches. The load-bearing rules are in
 * copyToUpcomingRegistrations: the person's own LINKED, UPCOMING
 * registrations only, only the fields that changed, never a shared Attendee.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockSync } = vi.hoisted(() => ({
  mockSync: vi.fn(),
  mockDb: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    accountProfile: { findUnique: vi.fn(), upsert: vi.fn() },
    registration: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    attendee: { update: vi.fn(), findUniqueOrThrow: vi.fn() },
    event: { findFirst: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: (tx: typeof mockDb) => unknown) => fn(mockDb) }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: mockSync }));

import {
  changedFields,
  marketingConsentInForce,
  missingRequiredDetails,
  copyToUpcomingRegistrations,
  normalizeDetails,
  readAccountDetails,
  saveAccountProfile,
  type AccountDetails,
} from "@/lib/registrant-details";
import { DEFAULT_PERSON_FIELD_RULES, personFieldRules } from "@/lib/person-fields";

const NOW = new Date("2026-11-09T10:00:00Z");
const BASE = {
  firstName: "Anna", lastName: "Lee", title: "DR", role: "PHYSICIAN", organization: "Clinic", jobTitle: "Consultant",
  phone: "+971500000000", city: "Dubai", state: "", zipCode: "", country: "UAE", specialty: "Cardiology", customSpecialty: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.attendee.update.mockResolvedValue({ email: "anna@example.com", firstName: "Anna", lastName: "Lee" });
  // The row before the write: what an edit changed is read as the difference.
  mockDb.attendee.findUniqueOrThrow.mockResolvedValue({ email: "anna@example.com", firstName: "Anna", lastName: "Lee" });
  mockDb.event.findFirst.mockResolvedValue({ organizationId: "org1" });
});

describe("normalizeDetails and changedFields", () => {
  it("trims, stores blanks as null, and finds only real changes", () => {
    const before = normalizeDetails(BASE);
    expect(before.state).toBeNull();
    const after = normalizeDetails({ ...BASE, organization: "  New Clinic ", city: "Dubai " });
    expect(changedFields(before, after)).toEqual(["organization"]);
  });
});

describe("copyToUpcomingRegistrations", () => {
  const details = normalizeDetails({ ...BASE, organization: "New Clinic" }) as AccountDetails;

  it("asks only for the person's LINKED, upcoming, not checked-in registrations", async () => {
    mockDb.registration.findMany.mockResolvedValue([]);
    await copyToUpcomingRegistrations("u1", ["organization"], details, NOW);
    expect(mockDb.registration.findMany.mock.calls[0][0].where).toEqual({
      userId: "u1",
      status: { in: ["PENDING", "CONFIRMED", "WAITLISTED"] },
      event: { startDate: { gt: NOW } },
      // Never a speaker's companion (the Faculty badge follows the Speaker
      // record), nor one whose badge is printed or DTCM code bought.
      OR: [{ createdSource: null }, { createdSource: { not: "SPEAKER_COMPANION" } }],
      badgePrintedAt: null,
      dtcmBarcode: null,
    });
  });

  it("writes only the changed fields, and the contact store follows", async () => {
    mockDb.registration.findMany.mockResolvedValue([{ id: "r1", attendeeId: "a1", eventId: "e1", attendee: { _count: { registrations: 1 } } }]);
    const result = await copyToUpcomingRegistrations("u1", ["organization"], details, NOW);
    expect(result).toEqual({ updated: 1, skipped: 0, failed: 0 });
    expect(mockDb.attendee.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { organization: "New Clinic" } });
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({ where: { attendeeId: "a1" }, data: { updatedAt: expect.any(Date) } });
    expect(mockSync).toHaveBeenCalledTimes(1);
  });

  it("the contact hears what the edit changed, Role included, and nothing the edit did not touch (Nov 13, 2026)", async () => {
    // The hand-typed payload this replaced never sent Role, and re-sent the
    // row's type and other untouched fields on every edit.
    mockDb.registration.findMany.mockResolvedValue([{ id: "r1", attendeeId: "a1", eventId: "e1", attendee: { _count: { registrations: 1 } } }]);
    mockDb.event.findFirst.mockResolvedValue({ organizationId: "org1" });
    const row = {
      email: "anna@example.com", firstName: "Anna", lastName: "Lee", role: null, state: null, organization: "Old Clinic",
      registrationType: "Faculty", photo: "/uploads/old.jpg", bio: "Old bio", memberId: "M1",
    };
    mockDb.attendee.findUniqueOrThrow.mockResolvedValue(row);
    mockDb.attendee.update.mockResolvedValue({ ...row, role: "PHYSICIAN", state: "Abu Dhabi" });
    await copyToUpcomingRegistrations("u1", ["role", "state"], details, NOW);
    const payload = mockSync.mock.calls[0][0];
    expect(payload).toMatchObject({ organizationId: "org1", eventId: "e1", email: "anna@example.com", role: "PHYSICIAN", state: "Abu Dhabi" });
    // Not changed, so they replace nothing: an old photo must not go over a
    // newer one. They may only fill what the contact has empty.
    expect(payload).not.toHaveProperty("photo");
    expect(payload).not.toHaveProperty("bio");
    expect(payload).not.toHaveProperty("organization");
    expect(payload).not.toHaveProperty("memberId");
    expect(payload.fillBlanks).toMatchObject({ photo: "/uploads/old.jpg", bio: "Old bio", organization: "Old Clinic", memberId: "M1" });
    // A Faculty registration's type never becomes the contact's category, by either road.
    expect(payload.registrationType).toBeNull();
    expect(payload.fillBlanks).not.toHaveProperty("registrationType");
  });

  it("never writes a shared Attendee (it would rewrite another event's registration)", async () => {
    mockDb.registration.findMany.mockResolvedValue([{ id: "r1", attendeeId: "shared", eventId: "e1", attendee: { _count: { registrations: 2 } } }]);
    const result = await copyToUpcomingRegistrations("u1", ["organization"], details, NOW);
    expect(result).toEqual({ updated: 0, skipped: 1, failed: 0 });
    expect(mockDb.attendee.update).not.toHaveBeenCalled();
  });

  it("an unchanged save touches no registration at all", async () => {
    expect(await copyToUpcomingRegistrations("u1", [], details, NOW)).toEqual({ updated: 0, skipped: 0, failed: 0 });
    expect(mockDb.registration.findMany).not.toHaveBeenCalled();
  });

  it("one failing registration does not stop the others", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      { id: "r1", attendeeId: "a1", eventId: "e1", attendee: { _count: { registrations: 1 } } },
      { id: "r2", attendeeId: "a2", eventId: "e2", attendee: { _count: { registrations: 1 } } },
    ]);
    mockDb.attendee.update.mockRejectedValueOnce(new Error("boom"));
    expect(await copyToUpcomingRegistrations("u1", ["organization"], details, NOW)).toEqual({ updated: 1, skipped: 0, failed: 1 });
  });
});

describe("saveAccountProfile: marketing consent", () => {
  const upsertData = () => mockDb.accountProfile.upsert.mock.calls[0][0].update;

  it("ticking records when, from where and the wording version", async () => {
    mockDb.accountProfile.findUnique.mockResolvedValue(null);
    await saveAccountProfile("u1", normalizeDetails(BASE), true, "1.2.3.4");
    expect(upsertData()).toMatchObject({ marketingConsentAt: expect.any(Date), marketingConsentIp: "1.2.3.4", marketingConsentWording: "2026-11-09", marketingConsentWithdrawnAt: null });
  });

  it("unticking stamps the withdrawal and keeps the original consent", async () => {
    mockDb.accountProfile.findUnique.mockResolvedValue({ marketingConsentAt: new Date("2026-01-01"), marketingConsentWithdrawnAt: null });
    await saveAccountProfile("u1", normalizeDetails(BASE), false, "1.2.3.4");
    expect(upsertData()).toMatchObject({ marketingConsentWithdrawnAt: expect.any(Date) });
    expect(upsertData()).not.toHaveProperty("marketingConsentAt");
  });

  it("leaving it as it is writes nothing about consent", async () => {
    mockDb.accountProfile.findUnique.mockResolvedValue({ marketingConsentAt: new Date("2026-01-01"), marketingConsentWithdrawnAt: null });
    await saveAccountProfile("u1", normalizeDetails(BASE), true, "1.2.3.4");
    expect(upsertData()).not.toHaveProperty("marketingConsentAt");
    expect(upsertData()).not.toHaveProperty("marketingConsentWithdrawnAt");
  });

  it("the account's name and specialty follow the profile", async () => {
    mockDb.accountProfile.findUnique.mockResolvedValue(null);
    await saveAccountProfile("u1", normalizeDetails({ ...BASE, firstName: " Ann " }), undefined, null);
    expect(mockDb.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { firstName: "Ann", lastName: "Lee", specialty: "Cardiology" } });
  });
});

describe("readAccountDetails", () => {
  const scope = { userId: "u1", email: "anna@example.com", confirmed: false };

  it("falls back to the latest OWN registration when the account has no details, through ownRegistrationWhere", async () => {
    mockDb.user.findUnique.mockResolvedValue({ firstName: "Anna", lastName: "Lee" });
    mockDb.accountProfile.findUnique.mockResolvedValue(null);
    mockDb.registration.findFirst.mockResolvedValue({ attendee: { organization: "Clinic" } });
    const r = await readAccountDetails(scope);
    expect(r.source).toBe("registration");
    expect(r.details.organization).toBe("Clinic");
    // An unconfirmed account reaches only registrations linked to it.
    expect(mockDb.registration.findFirst.mock.calls[0][0].where).toEqual({ userId: "u1" });
  });

  it("consent counts until withdrawn", async () => {
    mockDb.user.findUnique.mockResolvedValue({ firstName: "Anna", lastName: "Lee" });
    mockDb.registration.findFirst.mockResolvedValue(null);
    mockDb.accountProfile.findUnique.mockResolvedValue({ marketingConsentAt: new Date(), marketingConsentWithdrawnAt: new Date(), organization: null });
    expect((await readAccountDetails(scope)).marketing.consented).toBe(false);
  });
});

describe("marketingConsentInForce (double opt-in for sign-up consent)", () => {
  const given = new Date("2026-11-09");
  it("consent ticked at /signup counts only once the address is confirmed", () => {
    expect(marketingConsentInForce({ marketingConsentAt: given, marketingConsentWithdrawnAt: null, signedUpAt: given }, null)).toBe(false);
    expect(marketingConsentInForce({ marketingConsentAt: given, marketingConsentWithdrawnAt: null, signedUpAt: given }, new Date())).toBe(true);
  });
  it("consent given on My Details by the signed-in holder counts; a withdrawal always wins", () => {
    expect(marketingConsentInForce({ marketingConsentAt: given, marketingConsentWithdrawnAt: null, signedUpAt: null }, null)).toBe(true);
    expect(marketingConsentInForce({ marketingConsentAt: given, marketingConsentWithdrawnAt: new Date(), signedUpAt: null }, new Date())).toBe(false);
  });
});

describe("missingRequiredDetails", () => {
  it("a whitespace-only answer is missing once trimmed (it passes min(1))", () => {
    expect(missingRequiredDetails(normalizeDetails({ ...BASE, firstName: "   ", organization: " " }), DEFAULT_PERSON_FIELD_RULES)).toEqual(["firstName", "organization"]);
    expect(missingRequiredDetails(normalizeDetails(BASE), DEFAULT_PERSON_FIELD_RULES)).toEqual([]);
  });

  it("Role and Specialty are missing only while the organisation demands them (Nov 13, 2026)", () => {
    const blank = normalizeDetails({ ...BASE, role: "", specialty: "" });
    expect(missingRequiredDetails(blank, DEFAULT_PERSON_FIELD_RULES)).toEqual(["role", "specialty"]);
    const off = { enabled: false, required: true };
    const optional = { enabled: true, required: false };
    const on = { enabled: true, required: true };
    // Specialty switched off, Role optional: sign-up and My Details must not refuse.
    expect(missingRequiredDetails(blank, personFieldRules({ title: on, role: optional, specialty: off }))).toEqual([]);
  });

  it("Others still needs the typed specialty, unless Specialty is switched off", () => {
    const others = normalizeDetails({ ...BASE, specialty: "Others", customSpecialty: "" });
    expect(missingRequiredDetails(others, DEFAULT_PERSON_FIELD_RULES)).toEqual(["customSpecialty"]);
    const on = { enabled: true, required: true };
    expect(missingRequiredDetails(others, personFieldRules({ title: on, role: on, specialty: { enabled: false, required: true } }))).toEqual([]);
  });
});
