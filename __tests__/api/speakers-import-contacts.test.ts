/**
 * Speakers, Import from Contacts (back on the Speakers page Nov 12, 2026).
 *
 * The button was replaced by Import from Registrations in March 2026, before
 * the Faculty type existed. From then on a contact became a speaker only by
 * first being imported as a registration, which asks for a delegate type and
 * a rate: three faculty on the 4th GCC Hematology Hub ended up Physician at
 * 150 that way. This door asks for neither and makes the Faculty registration
 * by itself.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const { mockDb, mockAuth, mockEnsureCompanions } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    contact: { findMany: vi.fn(), updateMany: vi.fn() },
    speaker: { findMany: vi.fn(), createMany: vi.fn() },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
  },
  mockAuth: vi.fn(),
  mockEnsureCompanions: vi.fn(async () => ({ created: 1, linked: 0, failed: 0 })),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/audit-data-transfer", () => ({ recordImport: vi.fn() }));
vi.mock("@/lib/speaker-companion", () => ({ ensureCompanionsForSpeakerEmails: mockEnsureCompanions }));

import { POST } from "@/app/api/events/[eventId]/speakers/import-contacts/route";
import { speakerContactImportNotice as notice } from "@/lib/speaker-registration-messages";

const params = Promise.resolve({ eventId: "ev1" });
const session = { user: { id: "u1", role: "ORGANIZER", organizationId: "org1" } };
const req = (body: unknown) =>
  new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

const contact = (over: Record<string, unknown> = {}) => ({
  id: "c1", title: "DR", role: "PHYSICIAN", email: "fatima@x.com", additionalEmail: "f.alt@x.com", firstName: "Fatima", lastName: "Malallah",
  organization: "Al Kindi Hospital", jobTitle: "Consultant", phone: "+973", photo: "/uploads/photos/2026/11/f.png", city: "Manama", state: null,
  zipCode: null, country: "Bahrain", bio: "Bio", specialty: "Hematology", customSpecialty: null, registrationType: "Faculty",
  tags: ["Hematology", "Central-import"],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(session);
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  mockDb.speaker.findMany.mockResolvedValue([]);
  mockDb.speaker.createMany.mockResolvedValue({ count: 1 });
  mockDb.contact.findMany.mockResolvedValue([contact()]);
  mockDb.contact.updateMany.mockResolvedValue({ count: 1 });
  mockEnsureCompanions.mockResolvedValue({ created: 1, linked: 0, failed: 0 });
});

describe("POST speakers/import-contacts", () => {
  it("makes the speaker and then the registration behind them, asking for no type or rate", async () => {
    const res = await POST(req({ contactIds: ["c1"] }), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 1, skipped: 0, facultyRegistrations: 1, linkedRegistrations: 0, failedRegistrations: 0 });
    expect(mockEnsureCompanions).toHaveBeenCalledWith("ev1", ["fatima@x.com"]);
  });

  // Review of efb00d74: the summary was thrown away, so "Imported 3 speakers"
  // hid that one was linked to an Unpaid delegate registration and one had no
  // registration at all. A second import does not heal either.
  it("says who was linked to a registration they already had, and who has none", async () => {
    mockDb.contact.findMany.mockResolvedValue([contact(), contact({ id: "c2", email: "b@x.com" }), contact({ id: "c3", email: "c@x.com" })]);
    mockEnsureCompanions.mockResolvedValue({ created: 1, linked: 1, failed: 1 });
    const body = await (await POST(req({ contactIds: ["c1", "c2", "c3"] }), { params })).json();
    expect(body).toEqual({ created: 3, skipped: 0, facultyRegistrations: 1, linkedRegistrations: 1, failedRegistrations: 1 });
    expect(notice(body)).toEqual({
      kind: "warning",
      text:
        "Imported 3 speakers. 1 given a Faculty registration. 1 already registered: linked to the registration they had, so check its type and payment on the speaker. 1 have no registration yet: open the speaker and use Grant Registration.",
    });
  });

  // Add Speaker and the speakers CSV import put the event on the contact; the
  // central contacts table reads it to say which events a person was part of.
  it("puts the event on each imported contact once, and on nobody who was skipped", async () => {
    mockDb.contact.findMany.mockResolvedValue([contact(), contact({ id: "c2", email: "b@x.com" })]);
    mockDb.speaker.findMany.mockResolvedValue([{ email: "b@x.com" }]);
    await POST(req({ contactIds: ["c1", "c2"] }), { params });
    expect(mockDb.contact.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["c1"] }, organizationId: "org1", NOT: { eventIds: { has: "ev1" } } },
      data: { eventIds: { push: "ev1" } },
    });
  });

  it("still answers with the import when the contact stamp fails", async () => {
    mockDb.contact.updateMany.mockRejectedValue(new Error("db down"));
    const res = await POST(req({ contactIds: ["c1"] }), { params });
    expect(res.status).toBe(200);
    expect((await res.json()).created).toBe(1);
  });

  it("carries every person field a registration import would have carried, tags and role included", async () => {
    await POST(req({ contactIds: ["c1"] }), { params });
    const row = mockDb.speaker.createMany.mock.calls[0][0].data[0];
    expect(row).toMatchObject({
      eventId: "ev1", organizationId: "org1", title: "DR", role: "PHYSICIAN", email: "fatima@x.com", additionalEmail: "f.alt@x.com",
      firstName: "Fatima", lastName: "Malallah", organization: "Al Kindi Hospital", jobTitle: "Consultant", phone: "+973",
      photo: "/uploads/photos/2026/11/f.png", city: "Manama", country: "Bahrain", bio: "Bio", specialty: "Hematology",
      registrationType: "Faculty", tags: ["Hematology", "Central-import"],
    });
    // No status is written: a speaker starts Invited (the column's default).
    expect(row.status).toBeUndefined();
  });

  it("skips someone who is already a speaker, whatever the case of the address, and makes nothing for them", async () => {
    mockDb.speaker.findMany.mockResolvedValue([{ email: "Fatima@X.com" }]);
    const res = await POST(req({ contactIds: ["c1"] }), { params });
    expect(await res.json()).toMatchObject({ created: 0, skipped: 1, facultyRegistrations: 0, linkedRegistrations: 0, failedRegistrations: 0 });
    expect(mockDb.speaker.createMany).not.toHaveBeenCalled();
    expect(mockEnsureCompanions).not.toHaveBeenCalled();
    expect(mockDb.contact.updateMany).not.toHaveBeenCalled();
  });

  it("takes one address once when two contacts share it", async () => {
    mockDb.contact.findMany.mockResolvedValue([contact(), contact({ id: "c2", email: "FATIMA@x.com" })]);
    const res = await POST(req({ contactIds: ["c1", "c2"] }), { params });
    expect(await res.json()).toMatchObject({ created: 1, skipped: 1 });
    expect(mockDb.speaker.createMany.mock.calls[0][0].data).toHaveLength(1);
  });

  it("reads contacts from the caller's organisation only", async () => {
    await POST(req({ contactIds: ["c1"] }), { params });
    expect(mockDb.contact.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["c1"] }, organizationId: "org1" });
  });

  it("refuses a role without the import key, and an event outside the caller's reach", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u2", role: "MEMBER", organizationId: "org1" } });
    expect((await POST(req({ contactIds: ["c1"] }), { params })).status).toBe(403);
    mockAuth.mockResolvedValue(session);
    mockDb.event.findFirst.mockResolvedValue(null);
    expect((await POST(req({ contactIds: ["c1"] }), { params })).status).toBe(404);
    expect(mockDb.speaker.createMany).not.toHaveBeenCalled();
  });
});

describe("what the organiser is told", () => {
  it("is one plain line when every speaker got a Faculty registration", () => {
    expect(notice({ created: 2, skipped: 1, facultyRegistrations: 2, linkedRegistrations: 0, failedRegistrations: 0 })).toEqual({
      kind: "success",
      text: "Imported 2 speakers. 1 skipped (already a speaker). 2 given a Faculty registration.",
    });
    expect(notice({ created: 1, skipped: 0, facultyRegistrations: 1 }).text).toBe("Imported 1 speaker. 1 given a Faculty registration.");
  });

  it("is a warning as soon as one person was linked or left without a registration", () => {
    expect(notice({ created: 1, skipped: 0, linkedRegistrations: 1 }).kind).toBe("warning");
    expect(notice({ created: 1, skipped: 0, failedRegistrations: 1 }).kind).toBe("warning");
    expect(notice({ created: 0, skipped: 2 })).toEqual({ kind: "success", text: "Imported 0 speakers. 2 skipped (already a speaker)." });
  });

  it("the dialog shows that line, as a warning when it is one", () => {
    const src = readFileSync(join(process.cwd(), "src/components/contacts/import-contacts-dialog.tsx"), "utf8");
    expect(src).toContain("speakerContactImportNotice(imported)");
    expect(src).toContain('if (notice.kind === "warning") toast.warning(notice.text');
  });
});

describe("the Speakers page offers it", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("shows Import from Contacts to someone who may import speakers and read contacts", () => {
    const src = read("src/app/(dashboard)/events/[eventId]/speakers/page.tsx");
    expect(src).toContain('{canImportSpeakers && canReadContacts && <ImportContactsButton eventId={eventId} mode="speaker" />}');
    expect(src).toContain('useCan("contacts.read")');
  });

  it("tells the organiser what is made, since there is nothing to pick", () => {
    const src = read("src/components/contacts/import-contacts-dialog.tsx");
    expect(src).toContain("complimentary Faculty registration");
  });
});
