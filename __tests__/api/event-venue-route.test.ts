/**
 * /api/events/:eventId/venue (D9) with the REAL permission code: dark while
 * VENUE_MODULE_ENABLED is off, anyone who sees the event can read, only
 * events.update saves, a save from an older version is refused, and the
 * rooms are saved inside Event.settings.venue without touching its other keys.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TEMPLATES } from "@/lib/venue/rooms";

const { mockAuth, mockDb, settingsStore } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { event: { findFirst: vi.fn() } },
  settingsStore: { current: {} as Record<string, unknown> },
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/event-settings", () => ({
  updateEventSettings: async (_id: string, patch: (cur: Record<string, unknown>) => Record<string, unknown>) => {
    settingsStore.current = patch(settingsStore.current);
    return settingsStore.current;
  },
}));

import { GET, PUT } from "@/app/api/events/[eventId]/venue/route";

const params = { params: Promise.resolve({ eventId: "evt-1" }) };
const as = (role: string) => mockAuth.mockResolvedValue({ user: { id: `u-${role}`, role, organizationId: "org-1" } });
const rooms = TEMPLATES.summit.rooms;
const put = (body: unknown) => PUT(new Request("http://localhost/x", { method: "PUT", body: JSON.stringify(body) }), params) as Promise<{ status: number; json: () => Promise<Record<string, unknown>> }>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("VENUE_MODULE_ENABLED", "true");
  settingsStore.current = { venue: { ai: { on: false }, filter: { on: true } }, sponsors: ["kept"] };
  mockDb.event.findFirst.mockImplementation(async () => ({ id: "evt-1", organizationId: "org-1", settings: settingsStore.current }));
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/events/:eventId/venue", () => {
  it("404 for everyone while the module is off", async () => {
    vi.stubEnv("VENUE_MODULE_ENABLED", "");
    as("ADMIN");
    expect((await GET(new Request("http://localhost/x"), params)).status).toBe(404);
    expect((await put({ rooms, version: 0 })).status).toBe(404);
  });

  it("a member reads the rooms; only events.update saves them", async () => {
    as("MEMBER");
    expect(await (await GET(new Request("http://localhost/x"), params)).json()).toEqual({ rooms: null, version: 0 });
    expect((await put({ rooms, version: 0 })).status).toBe(403);
    as("ORGANIZER");
    const res = await put({ rooms, version: 0 });
    expect(res.status).toBe(200);
    expect((await res.json()).rooms).toEqual(rooms);
  });

  it("saves inside settings.venue and keeps the venue's other settings and the rest of the event's", async () => {
    as("ADMIN");
    await put({ rooms, version: 0 });
    const s = settingsStore.current as { venue: Record<string, unknown>; sponsors: unknown };
    expect(s.venue.ai).toEqual({ on: false });
    expect(s.venue.filter).toEqual({ on: true });
    expect(s.sponsors).toEqual(["kept"]);
    expect((s.venue.rooms as { list: unknown }).list).toEqual(rooms);
  });

  it("409 when someone saved after this editor loaded", async () => {
    as("ADMIN");
    const first = await (await put({ rooms, version: 0 })).json();
    expect((await put({ rooms, version: 0 })).status).toBe(409);
    expect((await put({ rooms, version: first.version })).status).toBe(200);
  });

  it("400 with every reason for a list the floor plan cannot lay out", async () => {
    as("ADMIN");
    const res = await put({ rooms: rooms.filter((r) => r.kind !== "foyer").map((r) => ({ ...r, name: "Same" })), version: 0 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_ROOMS");
    expect(body.issues).toEqual(expect.arrayContaining(["The venue needs a foyer", 'Two rooms are called "Same"; give each its own name']));
  });

  it("looks the event up through the permission's own where (404 when it cannot be seen)", async () => {
    as("ADMIN");
    mockDb.event.findFirst.mockResolvedValue(null);
    expect((await GET(new Request("http://localhost/x"), params)).status).toBe(404);
    expect(mockDb.event.findFirst.mock.calls[0][0].where).toMatchObject({ id: "evt-1", organizationId: "org-1" });
  });
});
