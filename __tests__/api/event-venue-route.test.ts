/**
 * /api/events/:eventId/venue (D9) with the REAL permission code: dark while
 * VENUE_MODULE_ENABLED is off, anyone who sees the event can read, only
 * events.update saves, a save from an older version is refused, and the
 * rooms are saved inside Event.settings.venue without touching its other keys.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TEMPLATES } from "@/lib/venue/rooms";
import { generateLayout } from "@/lib/venue/layout";
import { planFromLayout } from "@/lib/venue/plan";

const { mockAuth, mockDb, settingsStore } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { event: { findFirst: vi.fn() }, blueprint: { findFirst: vi.fn() } },
  settingsStore: { current: {} as Record<string, unknown> },
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
const SUMMARY = { sessions: [{ title: "Opening", location: null, track: "Main Stage" }], sponsors: 2 };
vi.mock("@/services/venue-programme-service", () => ({ loadProgrammeSummary: vi.fn(async () => SUMMARY) }));
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
    expect(await (await GET(new Request("http://localhost/x"), params)).json()).toEqual({ rooms: null, version: 0, open: false, slug: undefined, programme: SUMMARY, blueprint: null, plan: null });
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

  it("offers the approved Blueprint's spaces as rooms, only with the module on and blueprints.view", async () => {
    mockDb.blueprint.findFirst.mockResolvedValue({
      id: "bp_1", title: "BHS 2026", ref: "EB-1",
      data: { spaces: [{ name: "Plenary Hall", layout: "Theatre", cap: "400" }, { name: "Coffee lounge", cap: "60" }], basics: { attendance: "450" } },
    });
    const get = async () => (await (await GET(new Request("http://localhost/x"), params)).json()) as { blueprint: { rooms: { name: string; kind: string }[]; notes: string[] } | null };
    as("ADMIN");
    expect((await get()).blueprint).toBeNull(); // module off
    vi.stubEnv("BLUEPRINT_MODULE_ENABLED", "true");
    const bp = (await get()).blueprint!;
    expect(bp.rooms.map((r) => [r.name, r.kind])).toEqual([["Foyer", "foyer"], ["Plenary Hall", "plenary"], ["Coffee lounge", "lounge"]]);
    expect(bp.notes).toContain("A foyer is added: every venue has an entrance with registration and information desks.");
    expect(mockDb.blueprint.findFirst.mock.calls[0][0].where).toEqual({ eventId: "evt-1", organizationId: "org-1" });
    as("ONSITE"); // can open the event's venue tab, cannot see blueprints
    mockDb.blueprint.findFirst.mockClear();
    const onsite = await GET(new Request("http://localhost/x"), params);
    if (onsite.status === 200) expect(((await onsite.json()) as { blueprint: unknown }).blueprint).toBeNull();
    expect(mockDb.blueprint.findFirst).not.toHaveBeenCalled();
  });

  it("opens the venue only once rooms are saved, and reports it", async () => {
    as("ADMIN");
    const res = await put({ open: true });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NO_ROOMS");
    await put({ rooms, version: 0 });
    expect(await (await put({ open: true })).json()).toEqual({ open: true });
    expect(await (await GET(new Request("http://localhost/x"), params)).json()).toMatchObject({ open: true });
    as("MEMBER");
    expect((await put({ open: false })).status).toBe(403);
  });
});

describe("/api/events/:eventId/venue drawn plans", () => {
  const savedRooms = async () => {
    as("ORGANIZER");
    const res = await put({ rooms, version: 0 });
    expect(res.status).toBe(200);
  };
  const drawn = () => planFromLayout(generateLayout(rooms, { eventName: "" }));

  it("refuses a plan before the rooms are saved", async () => {
    as("ORGANIZER");
    const res = await put({ plan: drawn(), planVersion: 0 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NO_ROOMS");
  });

  it("saves a plan, reports it in use, and keeps the other venue keys", async () => {
    await savedRooms();
    const res = await put({ plan: drawn(), planVersion: 0 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.planVersion).toBeGreaterThan(0);
    const venue = settingsStore.current.venue as Record<string, unknown>;
    expect(venue.ai).toEqual({ on: false });
    expect(venue.rooms).toBeTruthy();
    const got = await (await GET(new Request("http://localhost/x"), params)).json();
    expect((got.plan as { mode: string; version: number }).mode).toBe("drawn");
    expect((got.plan as { version: number }).version).toBe(body.planVersion);
  });

  it("refuses an older version, an overlap with its reason, and anyone without events.update", async () => {
    await savedRooms();
    const first = await (await put({ plan: drawn(), planVersion: 0 })).json();
    expect((await put({ plan: drawn(), planVersion: 0 })).status).toBe(409);
    const bad = drawn();
    bad.rooms[1] = { ...bad.rooms[1], rect: bad.rooms[2].rect };
    const res = await put({ plan: bad, planVersion: first.planVersion as number });
    expect(res.status).toBe(400);
    expect(((await res.json()).issues as string[]).join(" ")).toMatch(/overlap/);
    as("MEMBER");
    expect((await put({ plan: drawn(), planVersion: first.planVersion as number })).status).toBe(403);
  });

  it("plan null goes back to automatic", async () => {
    await savedRooms();
    const first = await (await put({ plan: drawn(), planVersion: 0 })).json();
    const res = await put({ plan: null, planVersion: first.planVersion as number });
    expect(res.status).toBe(200);
    expect((settingsStore.current.venue as Record<string, unknown>).plan).toBeUndefined();
  });

  it("removing a room from the list drops its placement, and the venue falls back to automatic until it fits", async () => {
    await savedRooms();
    await put({ plan: drawn(), planVersion: 0 });
    const roomsVersion = (await (await GET(new Request("http://localhost/x"), params)).json()).version as number;
    const fewer = rooms.filter((r) => r.kind !== "lounge");
    expect((await put({ rooms: fewer, version: roomsVersion })).status).toBe(200);
    const plan = ((settingsStore.current.venue as Record<string, unknown>).plan as { plan: { rooms: { id: string }[] } }).plan;
    // The plan keeps its drawing order; it now places exactly the rooms still on the list.
    expect(plan.rooms.map((r) => r.id).sort()).toEqual(fewer.map((r) => r.id).sort());
  });
});
