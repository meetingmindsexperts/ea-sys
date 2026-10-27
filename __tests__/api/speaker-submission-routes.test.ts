/**
 * The speaker detail and the track detail carry abstracts. speakers.read or
 * sessions.read alone does not show them (owner, Oct 27, 2026); the track
 * names its speakers without their contact details or fee.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    speaker: { findFirst: vi.fn() },
    track: { findFirst: vi.fn() },
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Map<string, string>(),
    }),
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: unknown) => fn }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));

const EVENT = { id: "e1", organizationId: "org1", eventType: "CONFERENCE", staffAssignments: [] };
const as = (keys: string[]) => ({ user: { id: "u2", role: "BASE", organizationId: "org1", procurementPermissions: keys } });

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(EVENT);
});

describe("GET /api/events/[eventId]/speakers/[speakerId]", () => {
  const call = async () => {
    const { GET } = await import("@/app/api/events/[eventId]/speakers/[speakerId]/route");
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ eventId: "e1", speakerId: "s1" }) });
    return (await res.json()) as Record<string, unknown>;
  };

  beforeEach(() => {
    mockDb.speaker.findFirst.mockResolvedValue({
      id: "s1",
      firstName: "Jane",
      abstracts: [{ id: "a1", title: "Secret title", status: "ACCEPTED", content: "Full text" }],
      sourceRegistration: null,
      _count: { sessions: 1, abstracts: 1 },
    });
  });

  it("leaves out the abstracts without abstracts.read", async () => {
    mockAuth.mockResolvedValue(as(["speakers.read@ALL"]));
    const body = await call();
    expect(body.firstName).toBe("Jane");
    expect(body).not.toHaveProperty("abstracts");
    expect(body._count).toEqual({ sessions: 1 });
  });

  it("shows them with abstracts.read", async () => {
    mockAuth.mockResolvedValue(as(["speakers.read@ALL", "abstracts.read@ALL"]));
    const body = await call();
    expect(body.abstracts).toHaveLength(1);
  });
});

describe("GET /api/events/[eventId]/tracks/[trackId]", () => {
  const call = async () => {
    const { GET } = await import("@/app/api/events/[eventId]/tracks/[trackId]/route");
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ eventId: "e1", trackId: "t1" }) });
    return (await res.json()) as Record<string, unknown>;
  };

  beforeEach(() => {
    mockDb.track.findFirst.mockResolvedValue({ id: "t1", name: "Track", eventSessions: [], _count: { eventSessions: 0, abstracts: 2 } });
  });

  it("does not fetch the abstracts without abstracts.read, and drops their count", async () => {
    mockAuth.mockResolvedValue(as(["sessions.read@ALL"]));
    const body = await call();
    const query = mockDb.track.findFirst.mock.calls[0][0];
    expect(query.include.abstracts).toBe(false);
    expect(body._count).toEqual({ eventSessions: 0 });
  });

  it("names speakers without their contact details or fee", async () => {
    mockAuth.mockResolvedValue(as(["sessions.read@ALL", "abstracts.read@ALL"]));
    await call();
    const query = mockDb.track.findFirst.mock.calls[0][0];
    const sessionSpeaker = query.include.eventSessions.include.speakers.include.speaker.select;
    expect(sessionSpeaker).not.toHaveProperty("email");
    expect(sessionSpeaker).not.toHaveProperty("honorariumAmount");
    expect(query.include.abstracts.select.speaker.select).toEqual(sessionSpeaker);
  });
});
