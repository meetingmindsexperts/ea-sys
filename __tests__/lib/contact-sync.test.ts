/**
 * syncToContact — enrich-only merge. A sync fills in / updates Contact fields
 * with real data but NEVER clears an already-populated field with a blank
 * (null / ""), so a sparse later sync (e.g. a new-event registration that
 * leaves optional fields blank) can't wipe richer data from an earlier event.
 * Required name fields + eventIds always sync. To clear a field, edit the
 * Contact directly (not via this sync).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    contact: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({}),
    },
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { syncToContact, omitBlankFields } from "@/lib/contact-sync";
import { changedContactFields, contactSyncFromAttendee, contactSyncFromSpeaker, contactSyncFromSpeakerInput, CONTACT_SYNC_OPTIONAL_FIELDS } from "@/lib/contact-sync-payload";

const base = { organizationId: "org1", email: "Krishna@X.com", firstName: "Krishna", lastName: "P" };

beforeEach(() => vi.clearAllMocks());

describe("omitBlankFields (shared enrich-only filter)", () => {
  it("drops undefined, null, and empty string; keeps real values incl. false/0", () => {
    expect(omitBlankFields({ a: "x", b: null, c: undefined, d: "", e: 0, f: false })).toEqual({ a: "x", e: 0, f: false });
  });
  it("returns an empty object when everything is blank", () => {
    expect(omitBlankFields({ a: null, b: undefined, c: "" })).toEqual({});
  });
});

describe("syncToContact — enrich-only merge", () => {
  it("does NOT overwrite an existing field with a blank (null/undefined) — preserves Contact data", async () => {
    mockDb.contact.findUnique.mockResolvedValue({ eventIds: ["evA"] });
    await syncToContact({ ...base, eventId: "evB", organization: null, phone: "+971", city: undefined });

    const data = mockDb.contact.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("organization"); // null skipped → existing kept
    expect(data).not.toHaveProperty("city"); // undefined skipped
    expect(data.phone).toBe("+971"); // real value still written
    expect(data.firstName).toBe("Krishna"); // required fields always sync
    expect(data.eventIds).toEqual(["evA", "evB"]); // new event appended
  });

  it("skips empty-string values too", async () => {
    mockDb.contact.findUnique.mockResolvedValue({ eventIds: [] });
    await syncToContact({ ...base, eventId: "evB", organization: "" });
    expect(mockDb.contact.update.mock.calls[0][0].data).not.toHaveProperty("organization");
  });

  it("still writes/updates real values (enrich works, not just preserve)", async () => {
    mockDb.contact.findUnique.mockResolvedValue({ eventIds: [] });
    await syncToContact({ ...base, eventId: "evB", organization: "Acme", specialty: "Cardiology" });
    const data = mockDb.contact.update.mock.calls[0][0].data;
    expect(data.organization).toBe("Acme");
    expect(data.specialty).toBe("Cardiology");
  });

  it("creates a new contact (lowercased email, eventId seeded, blanks skipped)", async () => {
    mockDb.contact.findUnique.mockResolvedValue(null);
    await syncToContact({ ...base, eventId: "evB", organization: "Acme", phone: null });
    const data = mockDb.contact.create.mock.calls[0][0].data;
    expect(data.email).toBe("krishna@x.com");
    expect(data.eventIds).toEqual(["evB"]);
    expect(data.organization).toBe("Acme");
    expect(data).not.toHaveProperty("phone"); // null skipped even on create
  });

  it("no-eventId path uses upsert and skips blanks in the update branch", async () => {
    await syncToContact({ ...base, organization: null, jobTitle: "Prof" });
    const args = mockDb.contact.upsert.mock.calls[0][0];
    expect(args.update).not.toHaveProperty("organization");
    expect(args.update.jobTitle).toBe("Prof");
  });
});

// Step 0b of docs/ORG_FIELDS_PLAN.md: callers stop typing the payload by hand.
const COPIED = CONTACT_SYNC_OPTIONAL_FIELDS.filter((f) => f !== "registrationType");

describe("contactSyncFromAttendee", () => {
  const attendee = {
    email: "a@x.com", firstName: "Ana", lastName: "Lima",
    title: "DR" as const, role: "PHYSICIAN" as const, additionalEmail: "pa@x.com", organization: "Tawam", jobTitle: "Consultant",
    phone: "+971 1", photo: "/uploads/p.jpg", city: "Al Ain", state: "Abu Dhabi", zipCode: "0000", country: "UAE", bio: "Bio",
    specialty: "Others", customSpecialty: "Sleep medicine",
    associationName: "ESC", memberId: "M1", studentId: "S1", studentIdExpiry: new Date("2027-01-01"),
  };
  const to = { organizationId: "org1", eventId: "e1" };

  it("carries every copied field, each from the row, and nothing else", () => {
    const payload = contactSyncFromAttendee(attendee, { ...to, category: "Physician" }) as unknown as Record<string, unknown>;
    for (const field of COPIED) expect(payload[field]).toBe(attendee[field]);
    expect(payload).toMatchObject({ organizationId: "org1", eventId: "e1", email: "a@x.com", firstName: "Ana", lastName: "Lima", registrationType: "Physician" });
    expect(Object.keys(payload).sort()).toEqual([...CONTACT_SYNC_OPTIONAL_FIELDS, "organizationId", "eventId", "email", "firstName", "lastName"].sort());
  });

  it("does not pass on columns the sync does not take, when handed a whole row", () => {
    const row = { ...attendee, id: "a1", tags: ["vip"], dietaryReqs: "none", customFields: {}, createdAt: new Date() };
    const payload = contactSyncFromAttendee(row, { ...to, category: null });
    expect(payload).not.toHaveProperty("id");
    expect(payload).not.toHaveProperty("tags");
    expect(payload).not.toHaveProperty("dietaryReqs");
  });

  it("the category is what the caller says, never the row's own type", () => {
    // An attendee row on the Faculty type holds "Faculty"; the builder does not read it.
    const row = { ...attendee, registrationType: "Faculty" };
    expect(contactSyncFromAttendee(row, { ...to, category: null }).registrationType).toBeNull();
    expect(contactSyncFromAttendee(row, { ...to, category: "Allied Health" }).registrationType).toBe("Allied Health");
    // And "Faculty" said by a caller is still never a category.
    expect(contactSyncFromAttendee(row, { ...to, category: "Faculty" }).registrationType).toBeNull();
  });

  it("`only` sends the fields an edit changed and leaves the rest of the row unsaid", () => {
    // The row's photo and bio were copied in when the registration was made;
    // an edit of the phone must not put them over a newer photo on the contact.
    const payload = contactSyncFromAttendee(attendee, { ...to, category: null, only: ["phone", "role", "dietaryReqs", "firstName"] });
    expect(payload).toMatchObject({ phone: "+971 1", role: "PHYSICIAN", email: "a@x.com", firstName: "Ana", lastName: "Lima" });
    expect(payload).not.toHaveProperty("photo");
    expect(payload).not.toHaveProperty("bio");
    expect(payload).not.toHaveProperty("organization");
    expect(payload).not.toHaveProperty("dietaryReqs");
    // The rest of the row goes along to fill blanks only, never the category.
    expect(payload.fillBlanks).toMatchObject({ photo: "/uploads/p.jpg", bio: "Bio", organization: "Tawam", state: "Abu Dhabi" });
    expect(payload.fillBlanks).not.toHaveProperty("phone");
    expect(payload.fillBlanks).not.toHaveProperty("registrationType");
  });

  it("a row just created sends everything to replace, and nothing to fill", () => {
    expect(contactSyncFromAttendee(attendee, { ...to, category: null })).not.toHaveProperty("fillBlanks");
  });

  it("a row with fewer columns does not compile", () => {
    const { role: _role, ...withoutRole } = attendee;
    void _role;
    // @ts-expect-error the builder demands every copied column: a select that left Role out is refused
    contactSyncFromAttendee(withoutRole, { ...to, category: null });
    // @ts-expect-error the category must be said
    contactSyncFromAttendee(attendee, to);
  });
});

describe("contactSyncFromSpeaker", () => {
  const speaker = {
    email: "s@x.com", firstName: "Sam", lastName: "Okoye",
    title: "PROF" as const, role: "ACADEMIA" as const, additionalEmail: "pa@x.com", organization: "AUB", jobTitle: "Chair",
    phone: "+961 1", photo: "/uploads/s.jpg", city: "Beirut", state: "Beirut", zipCode: "1107", country: "Lebanon", bio: "Bio",
    specialty: "Others", customSpecialty: "Imaging", registrationType: "Faculty",
  };
  const SPEAKER_COPIED = COPIED.filter((f) => f in speaker);

  it("carries every copied field a speaker has", () => {
    const payload = contactSyncFromSpeaker(speaker, { organizationId: "org1", eventId: "e1" }) as unknown as Record<string, unknown>;
    expect(SPEAKER_COPIED).toHaveLength(COPIED.length - 4); // all but association, member ID, student ID and its expiry
    for (const field of SPEAKER_COPIED) expect(payload[field]).toBe((speaker as Record<string, unknown>)[field]);
  });

  it("never passes on an attendee's fields, even when a merged object carries them", () => {
    const merged = { ...speaker, memberId: "M1", studentId: "S1", associationName: "ESC" };
    const payload = contactSyncFromSpeaker(merged, { organizationId: "org1" });
    expect(payload).not.toHaveProperty("memberId");
    expect(payload).not.toHaveProperty("studentId");
    expect(payload).not.toHaveProperty("associationName");
  });

  it("never writes Faculty as the contact's category: it would replace Physician, and that value feeds Mailchimp", () => {
    expect(contactSyncFromSpeaker(speaker, { organizationId: "org1" }).registrationType).toBeNull();
    expect(contactSyncFromSpeaker({ ...speaker, registrationType: "faculty " }, { organizationId: "org1" }).registrationType).toBeNull();
    expect(contactSyncFromSpeaker({ ...speaker, registrationType: null }, { organizationId: "org1" }).registrationType).toBeNull();
    expect(contactSyncFromSpeaker({ ...speaker, registrationType: "Physician" }, { organizationId: "org1" }).registrationType).toBe("Physician");
  });

  it("a row with fewer columns does not compile", () => {
    const { state: _state, ...withoutState } = speaker;
    void _state;
    // @ts-expect-error the builder demands every copied column a speaker has
    contactSyncFromSpeaker(withoutState, { organizationId: "org1" });
  });
});

describe("contactSyncFromSpeakerInput (a speaker about to be created)", () => {
  it("sends what the input holds and leaves out what it does not", () => {
    const payload = contactSyncFromSpeakerInput(
      { eventId: "e1", organizationId: "org1", email: "s@x.com", firstName: "Sam", lastName: "Okoye", role: "ACADEMIA", state: "Beirut", zipCode: "1107", additionalEmail: "pa@x.com", registrationType: "Faculty", tags: ["vip"], website: "x.com", status: "INVITED" },
      { organizationId: "org1", eventId: "e1" },
    );
    expect(payload).toMatchObject({ organizationId: "org1", eventId: "e1", email: "s@x.com", role: "ACADEMIA", state: "Beirut", zipCode: "1107", additionalEmail: "pa@x.com" });
    expect(payload.photo).toBeUndefined();
    expect(payload.registrationType).toBeNull();
    // Only the sync's own keys: the input's tags, website and status are a speaker's, not a contact's.
    const allowed = new Set<string>([...CONTACT_SYNC_OPTIONAL_FIELDS, "organizationId", "eventId", "email", "firstName", "lastName"]);
    expect(Object.keys(payload).filter((k) => !allowed.has(k))).toEqual([]);
  });
});

describe("contact-sync-payload.ts stays pure", () => {
  it("imports no database and no logger, so a test that stubs the write still runs the real builders", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/contact-sync-payload.ts"), "utf8");
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["@/lib/faculty-filter", "@/lib/person-field-contract", "@prisma/client"]);
    expect(source).toMatch(/^import type \{[^}]+\} from "@prisma\/client";$/m);
  });
});

describe("changedContactFields", () => {
  const row = { phone: "+971 1", organization: "Clinic", photo: null, studentIdExpiry: new Date("2027-01-01"), state: "" };

  it("names the fields whose value differs, and only those", () => {
    expect(changedContactFields(row, { ...row, phone: "+971 2", photo: "/uploads/new.jpg" }).sort()).toEqual(["phone", "photo"]);
  });

  it("the same value sent again is not a change: null, undefined and blank are one, text is trimmed, a date is its instant", () => {
    expect(changedContactFields(row, { phone: " +971 1 ", organization: "Clinic", photo: undefined, studentIdExpiry: new Date("2027-01-01"), state: null })).toEqual([]);
  });
});

describe("syncToContact: fillBlanks (Nov 13, 2026)", () => {
  const edit = { ...base, eventId: "e2", phone: "+971 2", fillBlanks: { photo: "/uploads/row.jpg", organization: "Row Clinic", role: "PHYSICIAN", phone: "+971 0" } };

  it("fills only what the contact has empty, and never puts the row's value over one it holds", async () => {
    mockDb.contact.findUnique.mockResolvedValue({ eventIds: ["e1"], photo: "/uploads/newer.jpg", organization: null, role: "" });
    await syncToContact(edit);
    // It reads the contact's own values for exactly the fields it may fill.
    expect(mockDb.contact.findUnique.mock.calls[0][0].select).toEqual({ eventIds: true, photo: true, organization: true, role: true });
    const written = mockDb.contact.update.mock.calls[0][0].data;
    expect(written).toMatchObject({ phone: "+971 2", organization: "Row Clinic", role: "PHYSICIAN", eventIds: ["e1", "e2"] });
    expect(written).not.toHaveProperty("photo");
  });

  it("a field the write itself sets is replaced, whatever fillBlanks says about it", async () => {
    mockDb.contact.findUnique.mockResolvedValue({ eventIds: ["e2"], photo: null, organization: null, role: null });
    await syncToContact(edit);
    expect(mockDb.contact.update.mock.calls[0][0].data.phone).toBe("+971 2");
  });

  it("a contact that does not exist yet is created with the whole row", async () => {
    mockDb.contact.findUnique.mockResolvedValue(null);
    await syncToContact(edit);
    expect(mockDb.contact.create.mock.calls[0][0].data).toMatchObject({ phone: "+971 2", photo: "/uploads/row.jpg", organization: "Row Clinic", role: "PHYSICIAN" });
  });

  it("never fills the category: Faculty must not arrive by this road", async () => {
    mockDb.contact.findUnique.mockResolvedValue({ eventIds: [] });
    await syncToContact({ ...base, eventId: "e2", fillBlanks: { registrationType: "Faculty" } as never });
    expect(mockDb.contact.update.mock.calls[0][0].data).not.toHaveProperty("registrationType");
  });

  it("with no event, reads the contact only when there is something to fill", async () => {
    await syncToContact({ ...base, phone: "+971 2" });
    expect(mockDb.contact.findUnique).not.toHaveBeenCalled();

    mockDb.contact.findUnique.mockResolvedValue({ id: "c1", photo: "/uploads/newer.jpg", organization: null });
    await syncToContact({ ...base, phone: "+971 2", fillBlanks: { photo: "/uploads/row.jpg", organization: "Row Clinic" } });
    const args = mockDb.contact.upsert.mock.calls[1][0];
    expect(args.update).toMatchObject({ phone: "+971 2", organization: "Row Clinic" });
    expect(args.update).not.toHaveProperty("photo");
    expect(args.create).toMatchObject({ photo: "/uploads/row.jpg", organization: "Row Clinic" });
  });
});
