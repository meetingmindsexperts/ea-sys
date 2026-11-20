/**
 * Two facts the Speakers page needs about each speaker's registration (owner,
 * Nov 20, 2026; plan docs/ABSTRACT_AUTHOR_REGISTRATION_PLAN.md step 5):
 * whether it is on the Faculty type (invited, whatever they submitted), and
 * whether they hold one at all (an accepted author with none has no badge).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockOrgContext, logger } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockOrgContext: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  mockDb: {
    event: { findFirst: vi.fn() },
    speaker: { findMany: vi.fn() },
    registration: { findMany: vi.fn() },
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Map<string, string>() }),
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
// An attendee-side caller's event is found through the operator lane (it has no organisation of its own).
vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: mockDb, tenantTransaction: (fn: unknown) => fn }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/api-auth", () => ({ getOrgContext: () => mockOrgContext() }));
vi.mock("@/services/speaker-service", () => ({ updateSpeaker: vi.fn(), createSpeaker: vi.fn() }));

const FACULTY = { name: "Faculty", isFaculty: true };
const PHYSICIAN = { name: "Physician", isFaculty: false };
const ACCEPTED = [{ id: "a", title: "T", status: "ACCEPTED" }];
const speaker = (id: string, email: string, over: Record<string, unknown> = {}) => ({
  id, email, firstName: id, registrationType: null, sourceRegistrationId: null, sourceRegistration: null, submitterSource: null, abstracts: [], sessionProposals: [], ...over,
});
type Row = { id: string; onFacultyType: boolean; facultyByHand: boolean; hasRegistration?: boolean };

async function list(): Promise<{ status: number; rows: Row[] }> {
  const { GET } = await import("@/app/api/events/[eventId]/speakers/route");
  const res = await GET(new Request("http://x/api/events/e1/speakers"), { params: Promise.resolve({ eventId: "e1" }) });
  return { status: res.status, rows: (await res.json()) as Row[] };
}

const organiser = { user: { id: "u1", role: "ORGANIZER", organizationId: "org1" } };
/** As the real `getOrgContext` answers for each caller: a session with an organisation gets a context too. */
const sessionContext = { organizationId: "org1", userId: "u1", role: "ORGANIZER", fromApiKey: false };

describe("GET /speakers: the registration facts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrgContext.mockResolvedValue(sessionContext);
    mockAuth.mockResolvedValue(organiser);
    mockDb.event.findFirst.mockResolvedValue({ id: "e1", organizationId: "org1", eventType: "CONFERENCE", staffAssignments: [] });
    mockDb.speaker.findMany.mockResolvedValue([
      speaker("invited", "invited@x.com", { sourceRegistrationId: "r1", sourceRegistration: { serialId: 1, status: "CONFIRMED", createdSource: "SPEAKER_COMPANION", ticketType: FACULTY }, abstracts: ACCEPTED }),
      speaker("made-faculty", "made@x.com", { sourceRegistrationId: "r4", submitterSource: "abstract", sourceRegistration: { serialId: 4, status: "CONFIRMED", createdSource: "FACULTY_ADMIN", ticketType: FACULTY } }),
      speaker("author", "author@x.com", { sourceRegistrationId: "r2", submitterSource: "abstract", sourceRegistration: { serialId: 2, status: "CONFIRMED", createdSource: "PUBLIC_SUBMITTER", ticketType: PHYSICIAN }, abstracts: ACCEPTED }),
      speaker("cancelled", "gone@x.com", { sourceRegistrationId: "r3", submitterSource: "abstract", sourceRegistration: { serialId: 3, status: "CANCELLED", createdSource: "FACULTY_ADMIN", ticketType: FACULTY }, abstracts: ACCEPTED }),
      speaker("by-address", "Late@X.com", { submitterSource: "abstract", abstracts: ACCEPTED }),
      speaker("nobody", "nobody@x.com", { submitterSource: "abstract", abstracts: ACCEPTED }),
      speaker("not-accepted", "waiting@x.com", { submitterSource: "abstract", abstracts: [{ id: "b", title: "T", status: "SUBMITTED" }] }),
    ]);
    // The pointers that are live, then the addresses that are registered.
    mockDb.registration.findMany.mockImplementation(async (args: { where: { id?: unknown } }) =>
      args.where.id ? [{ id: "r1" }, { id: "r2" }] : [{ attendee: { email: "late@x.com" } }],
    );
  });

  it("says who is on the Faculty type and whether by hand, from a live registration only", async () => {
    const { status, rows } = await list();
    expect(status).toBe(200);
    expect(rows.map((r) => [r.id, r.onFacultyType, r.facultyByHand])).toEqual([
      ["invited", true, false],
      ["made-faculty", true, true],
      ["author", false, false],
      // A cancelled Faculty registration is not one, however it was made.
      ["cancelled", false, false],
      ["by-address", false, false],
      ["nobody", false, false],
      ["not-accepted", false, false],
    ]);
    // How the registration was made is read to decide and never sent.
    for (const r of rows) expect(JSON.stringify(r)).not.toContain("createdSource");
  });

  it("says whether each ACCEPTED author holds a registration, and reads only what that needs", async () => {
    const { rows } = await list();
    expect(rows.map((r) => [r.id, r.hasRegistration])).toEqual([
      ["invited", true],
      // Not an accepted author: not asked about, not said.
      ["made-faculty", undefined],
      ["author", true],
      ["cancelled", false],
      // Registered afterwards, never pointed at: found by the same address, whatever its case.
      ["by-address", true],
      ["nobody", false],
      ["not-accepted", undefined],
    ]);
    const [pointers, addresses] = mockDb.registration.findMany.mock.calls.map((c) => c[0].where);
    // Live registrations of THIS event, and only the accepted authors' own pointers.
    expect(pointers).toEqual({ eventId: "e1", id: { in: ["r1", "r2", "r3"] }, status: { not: "CANCELLED" } });
    expect(addresses.eventId).toBe("e1");
    expect(addresses.status).toEqual({ not: "CANCELLED" });
    // By address only for the accepted authors whose pointer is not live; an exact match, never a pattern.
    expect(addresses.OR).toHaveLength(3);
    expect(addresses.OR[1]).toEqual({ attendee: { email: { equals: "Late@X.com", mode: "insensitive" } } });
  });

  it("an event with no accepted abstract costs no extra read", async () => {
    mockDb.speaker.findMany.mockResolvedValue([speaker("s", "s@x.com", { abstracts: [{ id: "b", title: "T", status: "SUBMITTED" }] })]);
    const { rows } = await list();
    expect(mockDb.registration.findMany).not.toHaveBeenCalled();
    expect(rows[0]).not.toHaveProperty("hasRegistration");
  });

  // Review of 54404a7a (MED): the first version of this test passed with the session check deleted.
  it.each([
    ["an API key (the website sync)", { organizationId: "org1", userId: null, role: null, fromApiKey: true }],
    ["a mobile token", { organizationId: "org1", userId: "u9", role: "ORGANIZER", fromApiKey: false }],
  ])("%s is not given the has-registration answer, and no registrations are read for it", async (_name, context) => {
    mockAuth.mockResolvedValue(null);
    mockOrgContext.mockResolvedValue(context);
    const { status, rows } = await list();
    expect(status).toBe(200);
    expect(rows.length).toBeGreaterThan(0);
    expect(mockDb.registration.findMany).not.toHaveBeenCalled();
    for (const r of rows) expect(r).not.toHaveProperty("hasRegistration");
  });

  it("a submitter reading their own row is not told either", async () => {
    mockAuth.mockResolvedValue({ user: { id: "sub1", role: "SUBMITTER", organizationId: null } });
    mockOrgContext.mockResolvedValue(null);
    const { status, rows } = await list();
    expect(status).toBe(200);
    expect(mockDb.speaker.findMany.mock.calls[0][0].where).toMatchObject({ userId: "sub1" });
    expect(mockDb.registration.findMany).not.toHaveBeenCalled();
    for (const r of rows) expect(r).not.toHaveProperty("hasRegistration");
  });

  it("the roster is still served when that extra read fails, without the field, and the failure is logged", async () => {
    mockDb.registration.findMany.mockRejectedValue(new Error("db down"));
    const { status, rows } = await list();
    expect(status).toBe(200);
    expect(rows).toHaveLength(7);
    for (const r of rows) expect(r).not.toHaveProperty("hasRegistration");
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "events/speakers:live-registrations-failed", eventId: "e1" }));
  });
});
