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
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: unknown) => fn }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/api-auth", () => ({ getOrgContext: () => mockOrgContext() }));
vi.mock("@/services/speaker-service", () => ({ updateSpeaker: vi.fn(), createSpeaker: vi.fn() }));

const FACULTY = { name: "Faculty", isFaculty: true };
const PHYSICIAN = { name: "Physician", isFaculty: false };
const speaker = (id: string, email: string, over: Record<string, unknown> = {}) => ({
  id, email, firstName: id, registrationType: null, sourceRegistrationId: null, sourceRegistration: null, abstracts: [], sessionProposals: [], ...over,
});
type Row = { id: string; onFacultyType: boolean; hasRegistration?: boolean };

async function list(): Promise<{ status: number; rows: Row[] }> {
  const { GET } = await import("@/app/api/events/[eventId]/speakers/route");
  const res = await GET(new Request("http://x/api/events/e1/speakers"), { params: Promise.resolve({ eventId: "e1" }) });
  return { status: res.status, rows: (await res.json()) as Row[] };
}

describe("GET /speakers: the registration facts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrgContext.mockResolvedValue(null);
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "ORGANIZER", organizationId: "org1" } });
    mockDb.event.findFirst.mockResolvedValue({ id: "e1", organizationId: "org1", eventType: "CONFERENCE", staffAssignments: [] });
    mockDb.speaker.findMany.mockResolvedValue([
      speaker("invited", "invited@x.com", { sourceRegistrationId: "r1", sourceRegistration: { serialId: 1, status: "CONFIRMED", ticketType: FACULTY } }),
      speaker("author", "author@x.com", { sourceRegistrationId: "r2", sourceRegistration: { serialId: 2, status: "CONFIRMED", ticketType: PHYSICIAN } }),
      speaker("cancelled", "gone@x.com", { sourceRegistrationId: "r3", sourceRegistration: { serialId: 3, status: "CANCELLED", ticketType: FACULTY } }),
      speaker("by-address", "Late@X.com"),
      speaker("nobody", "nobody@x.com"),
    ]);
    mockDb.registration.findMany.mockResolvedValue([
      { id: "r1", attendee: { email: "invited@x.com" } },
      { id: "r2", attendee: { email: "author@x.com" } },
      { id: "r9", attendee: { email: "late@x.com" } },
    ]);
  });

  it("says who is on the Faculty type (a live registration only) and who holds a registration at all", async () => {
    const { status, rows } = await list();
    expect(status).toBe(200);
    expect(rows.map((r) => [r.id, r.onFacultyType, r.hasRegistration])).toEqual([
      ["invited", true, true],
      ["author", false, true],
      // A cancelled Faculty registration is not one: neither fact.
      ["cancelled", false, false],
      // Registered afterwards, never pointed at: found by the same address, whatever its case.
      ["by-address", false, true],
      ["nobody", false, false],
    ]);
    // Live registrations of THIS event only.
    expect(mockDb.registration.findMany.mock.calls[0][0].where).toEqual({ eventId: "e1", status: { not: "CANCELLED" } });
  });

  it("an API key (the website sync) is not given the has-registration answer, and no registrations are read for it", async () => {
    mockAuth.mockResolvedValue(null);
    mockOrgContext.mockResolvedValue({ organizationId: "org1", userId: null, scopes: null });
    const { status, rows } = await list();
    expect(status).toBe(200);
    expect(mockDb.registration.findMany).not.toHaveBeenCalled();
    for (const r of rows) expect(r).not.toHaveProperty("hasRegistration");
  });

  it("the roster is still served when that extra read fails, without the field, and the failure is logged", async () => {
    mockDb.registration.findMany.mockRejectedValue(new Error("db down"));
    const { status, rows } = await list();
    expect(status).toBe(200);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r).not.toHaveProperty("hasRegistration");
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "events/speakers:live-registrations-failed", eventId: "e1" }));
  });
});
