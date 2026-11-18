import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Contacts become speakers with all their details (Nov 18, 2026). On prod an
 * organiser asked the in-app agent to add three faculty "from the master
 * contact": `list_contacts` found no one by full name, showed only a name, an
 * address and the organisation (no id), and `create_speaker` published six of
 * the fields its executor takes. The agent made three thin speakers and said
 * the contacts held no job title or country, which they did.
 */

const { mockDb, mockImport } = vi.hoisted(() => ({
  mockDb: { contact: { findMany: vi.fn() } },
  mockImport: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: {} }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/services/speaker-service", async (orig) => ({
  ...(await orig<typeof import("@/services/speaker-service")>()),
  importSpeakersFromContacts: (...a: unknown[]) => mockImport(...a),
}));

import { CONTACT_EXECUTORS } from "@/lib/agent/tools/contacts";
import { SPEAKER_EXECUTORS } from "@/lib/agent/tools/speakers";
import { TOOL_PERMISSIONS } from "@/lib/permissions/tool-permissions";

const ctx = { eventId: "ev1", userId: "u1", organizationId: "org1", source: "agent", counters: { creates: 0, emailsSent: 0 } } as never;

const contact = (over: Record<string, unknown> = {}) => ({
  id: "c1", title: "PROF", email: "yawal@squ.edu.om", additionalEmail: null, firstName: "Yasser", lastName: "Wali",
  organization: "Sultan Qaboos University", jobTitle: "Head, Pediatric Hematology", role: "PHYSICIAN", specialty: "Hematology",
  customSpecialty: null, phone: "+968", photo: "/uploads/photos/y.png", city: "Muscat", state: null, zipCode: null, country: "Oman",
  bio: "b".repeat(500), tags: [],
  ...over,
});

/** What `registerAllMcpTools` hands a server: name, description and parameter shape. */
async function registered(): Promise<Map<string, { description: string; shape: Record<string, unknown> }>> {
  const tools = new Map<string, { description: string; shape: Record<string, unknown> }>();
  const stub = {
    tool: (name: string, description: string, shape: Record<string, unknown>) => void tools.set(name, { description, shape }),
    resource: () => {},
    prompt: () => {},
  };
  const { registerAllMcpTools } = await import("@/lib/agent/register-mcp-tools");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerAllMcpTools(stub as any, "org1");
  return tools;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.contact.findMany.mockResolvedValue([contact()]);
});

describe("list_contacts", () => {
  it("finds a full name: every word must match a name, an address or the organisation", async () => {
    await CONTACT_EXECUTORS.list_contacts({ search: "Yasser  Wali" }, ctx);
    const where = mockDb.contact.findMany.mock.calls[0][0].where;
    expect(where.organizationId).toBe("org1");
    expect(where.AND).toHaveLength(2);
    expect(where.AND[0].OR.map((o: Record<string, unknown>) => Object.keys(o)[0])).toEqual(["firstName", "lastName", "email", "organization"]);
    expect(where.AND[1].OR[1]).toEqual({ lastName: { contains: "Wali", mode: "insensitive" } });
  });

  it("returns the id and every person field, the full bio for a narrow search", async () => {
    const res = (await CONTACT_EXECUTORS.list_contacts({ search: "yawal@squ.edu.om" }, ctx)) as { contacts: Record<string, unknown>[] };
    expect(res.contacts[0]).toMatchObject({ id: "c1", title: "PROF", jobTitle: "Head, Pediatric Hematology", country: "Oman", city: "Muscat", specialty: "Hematology", phone: "+968" });
    expect(res.contacts[0].bio).toHaveLength(500);
    const select = mockDb.contact.findMany.mock.calls[0][0].select;
    for (const f of ["id", "title", "jobTitle", "role", "specialty", "phone", "photo", "city", "state", "zipCode", "country", "bio"]) expect(select[f]).toBe(true);
  });

  it("cuts bios to a preview above ten results and says so", async () => {
    mockDb.contact.findMany.mockResolvedValue(Array.from({ length: 11 }, (_, i) => contact({ id: `c${i}` })));
    const res = (await CONTACT_EXECUTORS.list_contacts({}, ctx)) as { contacts: Record<string, unknown>[]; note?: string };
    expect(String(res.contacts[0].bio).length).toBe(201);
    expect(res.contacts[0].bioTruncated).toBe(true);
    expect(res.note).toContain("Bios are cut");
  });
});

describe("import_speakers_from_contacts", () => {
  it("hands the contact ids, once each, to the Speakers page's own import", async () => {
    mockImport.mockResolvedValue({
      ok: true, created: 1, skipped: 1, createdEmails: ["yawal@squ.edu.om"], skippedEmails: ["dr_mors@msn.com"],
      missingContactIds: ["nope"], registrations: { created: 1, linked: 0, failed: 0 },
    });
    const res = (await SPEAKER_EXECUTORS.import_speakers_from_contacts({ contactIds: ["c1", "c1", " c2 ", "nope"] }, ctx)) as Record<string, unknown>;
    expect(mockImport).toHaveBeenCalledWith({ eventId: "ev1", organizationId: "org1", userId: "u1", contactIds: ["c1", "c2", "nope"], source: "agent" });
    expect(res).toMatchObject({ success: true, created: 1, skipped: 1, skippedEmails: ["dr_mors@msn.com"], notFoundContactIds: ["nope"], facultyRegistrations: 1 });
    expect(String(res.skippedNote)).toContain("update_speaker");
  });

  it("refuses no ids, and says when the event is not found", async () => {
    expect(((await SPEAKER_EXECUTORS.import_speakers_from_contacts({}, ctx)) as { code: string }).code).toBe("MISSING_CONTACT_IDS");
    mockImport.mockResolvedValue({ ok: false, code: "EVENT_NOT_FOUND", message: "Event not found" });
    expect(((await SPEAKER_EXECUTORS.import_speakers_from_contacts({ contactIds: ["c1"] }, ctx)) as { code: string }).code).toBe("EVENT_NOT_FOUND");
  });

  it("asks the same key as the Speakers page's import", () => {
    expect(TOOL_PERMISSIONS.import_speakers_from_contacts).toBe("speakers.import");
  });
});

describe("what the agent is offered", () => {
  it("create_speaker takes every field its executor writes", async () => {
    const shape = (await registered()).get("create_speaker")!.shape;
    for (const f of ["role", "phone", "photo", "city", "state", "zipCode", "country", "specialty", "customSpecialty"]) expect(shape).toHaveProperty(f);
  });

  it("update_speaker takes state and zip code", async () => {
    const shape = (await registered()).get("update_speaker")!.shape;
    expect(shape).toHaveProperty("state");
    expect(shape).toHaveProperty("zipCode");
  });

  it("list_contacts points at the import, so a contact is never retyped", async () => {
    const tools = await registered();
    expect(tools.get("list_contacts")!.description).toContain("import_speakers_from_contacts");
    expect(tools.get("import_speakers_from_contacts")!.shape).toHaveProperty("contactIds");
  });
});
