/**
 * Registrations, Import from Contacts: the "Faculty (speakers and committee)"
 * choice (owner, Nov 12, 2026: "why we cannot give an importing contact a
 * registration type faculty").
 *
 * The dialog hid every Faculty type, so a faculty contact could only be
 * imported onto a delegate type with a rate: three on the 4th GCC Hematology
 * Hub became Physician at 150. Add Registration has had a Faculty choice since
 * Nov 10; the import now has the same one, made by the same create path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const { mockDb, mockAuth, mockCreate, mockEnsureFacultyType } = vi.hoisted(() => ({
  mockDb: { event: { findFirst: vi.fn() }, contact: { findMany: vi.fn() } },
  mockAuth: vi.fn(),
  mockCreate: vi.fn(),
  mockEnsureFacultyType: vi.fn(async () => "tt-faculty"),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/audit-data-transfer", () => ({ recordImport: vi.fn() }));
vi.mock("@/lib/registration-email-lock", () => ({ lockRegistrationEmails: vi.fn() }));
vi.mock("@/services/registration-service", () => ({ createRegistration: mockCreate }));
vi.mock("@/lib/speaker-companion", () => ({ ensureFacultyTicketType: mockEnsureFacultyType }));

import { POST } from "@/app/api/events/[eventId]/registrations/import-contacts/route";

const params = Promise.resolve({ eventId: "ev1" });
const organiser = { user: { id: "u1", firstName: "Richard", role: "ORGANIZER", organizationId: "org1" } };
const req = (body: unknown) =>
  new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

const contact = (over: Record<string, unknown> = {}) => ({
  email: "fatima@x.com", firstName: "Fatima", lastName: "Malallah", title: "DR", role: "PHYSICIAN", organization: "Al Kindi Hospital",
  jobTitle: "Consultant", phone: "+973", additionalEmail: null, bio: null, specialty: "Hematology", customSpecialty: null,
  registrationType: "Faculty", photo: null, city: "Manama", state: null, zipCode: null, country: "Bahrain", associationName: null,
  memberId: null, studentId: null, studentIdExpiry: null, tags: ["Hematology"],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(organiser);
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  mockDb.contact.findMany.mockResolvedValue([contact()]);
  mockCreate.mockResolvedValue({ ok: true, registration: { id: "r1" } });
});

describe("POST registrations/import-contacts as Faculty", () => {
  it("makes each person through the one create path, under the Faculty terms", async () => {
    const res = await POST(req({ contactIds: ["c1"], asFaculty: true }), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 1, skipped: 0, failed: 0, uncategorised: 0, asFaculty: true });
    expect(mockEnsureFacultyType).toHaveBeenCalledWith("ev1");
    const input = mockCreate.mock.calls[0][0];
    expect(input).toMatchObject({
      eventId: "ev1", organizationId: "org1", userId: "u1", ticketTypeId: "tt-faculty", asFaculty: true,
      badgeType: "Faculty", paymentStatus: "COMPLIMENTARY", source: "rest",
    });
    // Nothing that would charge or seat it is passed at all.
    expect(input.pricingTierId).toBeUndefined();
    expect(input.promoCode).toBeUndefined();
    expect(input.attendee).toMatchObject({ email: "fatima@x.com", firstName: "Fatima", role: "PHYSICIAN", city: "Manama", tags: ["Hematology"] });
  });

  it("sends no email and no notification per row, and takes no spare DTCM code: an import never has", async () => {
    await POST(req({ contactIds: ["c1"], asFaculty: true }), { params });
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ suppressConfirmationEmail: true, suppressAdminNotification: true, suppressDtcmClaim: true });
    const service = readFileSync(join(process.cwd(), "src/services/registration-service.ts"), "utf8");
    expect(service).toMatch(/if \(!input\.suppressAdminNotification\) \{\s+notifyEventAdmins\(/);
  });

  it("counts someone already registered as skipped, and any other refusal as not added", async () => {
    mockDb.contact.findMany.mockResolvedValue([contact(), contact({ email: "b@x.com" }), contact({ email: "c@x.com" })]);
    mockCreate
      .mockResolvedValueOnce({ ok: true, registration: { id: "r1" } })
      .mockResolvedValueOnce({ ok: false, code: "ALREADY_REGISTERED", message: "exists" })
      .mockResolvedValueOnce({ ok: false, code: "UNKNOWN", message: "boom" });
    const body = await (await POST(req({ contactIds: ["c1", "c2", "c3"], asFaculty: true }), { params })).json();
    expect(body).toMatchObject({ created: 1, skipped: 1, failed: 1 });
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  // Review of 3212f4c7: a throw on person 18 of 40 answered 500 with 17 made
  // and no counts.
  it("counts a row that throws as not added, and carries on with the rest", async () => {
    mockDb.contact.findMany.mockResolvedValue([contact(), contact({ email: "b@x.com" }), contact({ email: "c@x.com" })]);
    mockCreate
      .mockResolvedValueOnce({ ok: true, registration: { id: "r1" } })
      .mockRejectedValueOnce(new Error("pool timeout"))
      .mockResolvedValueOnce({ ok: true, registration: { id: "r3" } });
    const res = await POST(req({ contactIds: ["c1", "c2", "c3"], asFaculty: true }), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: 2, skipped: 0, failed: 1 });
  });

  // Review of 3212f4c7: the key is held per event. The event must be inside
  // the Faculty grant as well as the import grant, or a role holding
  // speakers.create on webinars only could add Faculty on a conference.
  it("looks the event up inside BOTH grants for Faculty, and inside the import grant alone otherwise", async () => {
    await POST(req({ contactIds: ["c1"], asFaculty: true }), { params });
    const where = mockDb.event.findFirst.mock.calls[0][0].where;
    expect(Array.isArray(where.AND)).toBe(true);
    expect(where.AND).toHaveLength(2);
    for (const part of where.AND) expect(part).toMatchObject({ id: "ev1" });
    const src = readFileSync(join(process.cwd(), "src/app/api/events/[eventId]/registrations/import-contacts/route.ts"), "utf8");
    expect(src).toContain("const eventWhere = facultyGate ? { AND: [gate.eventWhere, facultyGate.eventWhere] } : gate.eventWhere;");
    expect(src).not.toMatch(/db\.event\.findFirst\(\{\s+where: gate\.eventWhere/);
  });

  it("refuses Faculty together with a registration type or a rate, and creates nothing", async () => {
    for (const extra of [{ ticketTypeId: "tt-phys" }, { ticketTypeId: "tt-phys", pricingTierId: "tier" }]) {
      const res = await POST(req({ contactIds: ["c1"], asFaculty: true, ...extra }), { params });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("FACULTY_TERMS_INVALID");
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("is refused for an event outside the caller's reach, before anything is made", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    expect((await POST(req({ contactIds: ["c1"], asFaculty: true }), { params })).status).toBe(404);
    expect(mockEnsureFacultyType).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("is refused for a role that may not import registrations", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u2", role: "MEMBER", organizationId: "org1" } });
    expect((await POST(req({ contactIds: ["c1"], asFaculty: true }), { params })).status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("asks for the key that adds a speaker, as Add Registration, Faculty does", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/events/[eventId]/registrations/import-contacts/route.ts"), "utf8");
    expect(src).toContain('requirePermission(session, "speakers.create", { route: "events/[eventId]/registrations/import-contacts:POST:faculty", eventId })');
  });
});

describe("the dialog offers the choice", () => {
  const src = readFileSync(join(process.cwd(), "src/components/contacts/import-contacts-dialog.tsx"), "utf8");

  it("as its own entry, to someone who may add faculty, and never as a type from the list", () => {
    expect(src).toContain("{canAddFaculty && <SelectItem value={FACULTY_CHOICE}>{SPEAKERS_TYPE_LABEL}</SelectItem>}");
    expect(src).toContain('useCan("speakers.create", eventId)');
    // A Faculty TYPE is never listed, and an ordinary type that is only called
    // "Faculty" is not listed beside the real choice under the same word.
    expect(src).toContain("const selectableTickets = tickets.filter((t) => !t.isFaculty && !(canAddFaculty && isFacultyLookalikeName(t.name)));");
  });

  it("sends the choice, with no type and no rate", () => {
    expect(src).toContain("ticketTypeId: isUncategorised || isFacultyChoice ? undefined : ticketTypeId,");
    expect(src).toContain("pricingTierId: isFacultyChoice ? undefined : pricingTierId || undefined,");
    expect(src).toContain("asFaculty: isFacultyChoice || undefined,");
  });

  it("says they are not made speakers", () => {
    expect(src).toContain("This does not make them speakers");
  });
});
