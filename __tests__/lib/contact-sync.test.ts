/**
 * syncToContact — enrich-only merge. A sync fills in / updates Contact fields
 * with real data but NEVER clears an already-populated field with a blank
 * (null / ""), so a sparse later sync (e.g. a new-event registration that
 * leaves optional fields blank) can't wipe richer data from an earlier event.
 * Required name fields + eventIds always sync. To clear a field, edit the
 * Contact directly (not via this sync).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
