/**
 * GET /api/events/:eventId/venue/room-sheet with the REAL permission code, and the sheet itself
 * (src/lib/venue/room-sheet-pdf.ts; section 11, step 3): dark while the module is off, anyone who sees the event
 * may download, an unknown room is refused in plain words, the venue's PDF budget is shared, and the sheet is a
 * real PDF for every setup with the hotel's numbers (the stage gap, the seats).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateLayout } from "@/lib/venue/layout";
import { LAYOUT_FIXTURES } from "@/lib/venue/layout-fixtures";
import { renderRoomSheetPdf, roomFilePart, roomSheetFacts } from "@/lib/venue/room-sheet-pdf";

const { mockAuth, mockDb, rateLimit } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { event: { findFirst: vi.fn() } },
  rateLimit: vi.fn((o: { key: string }) => ({ allowed: !!o, retryAfterSeconds: 0 })),
}));

vi.mock("next/server", () => {
  class NextResponse {
    status: number;
    headers: Headers;
    body: unknown;
    constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = new Headers(init?.headers);
    }
    static json(b: unknown, i?: { status?: number; headers?: Record<string, string> }) {
      const r = new NextResponse(b, i);
      return Object.assign(r, { json: async () => b });
    }
  }
  return { NextResponse };
});
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/security", async (orig) => ({ ...(await orig<typeof import("@/lib/security")>()), checkRateLimit: rateLimit }));

import { GET } from "@/app/api/events/[eventId]/venue/room-sheet/route";

type Res = { status: number; headers: Headers; body: unknown; json?: () => Promise<Record<string, unknown>> };
const params = { params: Promise.resolve({ eventId: "evt-1" }) };
const as = (role: string) => mockAuth.mockResolvedValue({ user: { id: `u-${role}`, role, organizationId: "org-1" } });
const get = (q = "") => GET(new Request(`http://localhost/x${q}`), params) as Promise<Res>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("VENUE_MODULE_ENABLED", "true");
  mockDb.event.findFirst.mockResolvedValue({
    id: "evt-1", name: "MEHFC 2027", slug: "mehfc-27", organizationId: "org-1",
    settings: { venue: { rooms: { list: LAYOUT_FIXTURES.setups, updatedAt: 5, updatedBy: "u" } } },
    startDate: new Date("2027-01-15T05:00:00Z"), endDate: new Date("2027-01-16T15:00:00Z"), timezone: "Asia/Dubai", venue: "Raffles", city: "Dubai",
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/events/:eventId/venue/room-sheet", () => {
  it("404 while the module is off; 401 without a session; 403 for a role that cannot see events", async () => {
    vi.stubEnv("VENUE_MODULE_ENABLED", "");
    as("ADMIN");
    expect((await get("?room=plenary-0")).status).toBe(404);
    vi.stubEnv("VENUE_MODULE_ENABLED", "true");
    mockAuth.mockResolvedValue(null);
    expect((await get("?room=plenary-0")).status).toBe(401);
    as("HR_USER");
    expect((await get("?room=plenary-0")).status).toBe(403);
  });

  it("a member downloads a room's sheet, named after the event and the room", async () => {
    as("MEMBER");
    const res = await get("?room=plenary-0");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="mehfc-27-plenary-1-setup.pdf"');
    expect(Buffer.from(res.body as Uint8Array).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("refuses no room, a room id that is not one, and a room not in the saved list", async () => {
    as("ADMIN");
    expect((await get()).status).toBe(400);
    expect((await get("?room=../x")).status).toBe(400);
    const res = await get("?room=hall-9");
    expect(res.status).toBe(404);
    expect((await res.json!()).code).toBe("ROOM_NOT_FOUND");
  });

  it("asks for saved rooms first", async () => {
    as("ADMIN");
    mockDb.event.findFirst.mockResolvedValueOnce({ ...(await mockDb.event.findFirst()), settings: {} });
    const res = await get("?room=plenary-0");
    expect(res.status).toBe(409);
    expect((await res.json!()).code).toBe("NO_ROOMS");
  });

  it("shares the floor plan PDF's hourly budget", async () => {
    as("ADMIN");
    rateLimit.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 60 });
    expect((await get("?room=plenary-0")).status).toBe(429);
    expect(rateLimit.mock.calls.at(-1)?.[0].key).toBe("venue-plan-pdf:u-ADMIN");
  });
});

describe("the sheet", () => {
  const layout = generateLayout(LAYOUT_FIXTURES.setups, { eventName: "x" });

  it("gives the Al Wasl Ballroom's numbers: 112 seats, 2.5 m from the stage to the first table", () => {
    const facts = roomSheetFacts(layout, "plenary-0")!;
    expect(facts.seats).toBe(112);
    expect(facts.gap?.metres).toBe(2.5);
  });

  it("is a PDF for every room, whatever its setup, and none for a walkway", async () => {
    for (const z of layout.zones.filter((q) => q.kind !== "corridor")) {
      const pdf = await renderRoomSheetPdf({ layout, zoneId: z.id, eventName: "MEHFC 2027", dateLine: "15 January 2027", place: "Raffles, Dubai", generatedAt: new Date(0) });
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    }
    expect(roomSheetFacts(layout, "corridor")).toBeNull();
  });

  it("review of f10bdb84: a stage deeper than it is wide still faces the room; the gap is to the seats in front", async () => {
    const { generateLayout: gen } = await import("@/lib/venue/layout");
    const { TEMPLATES } = await import("@/lib/venue/rooms");
    for (const setup of ["theatre", "classroom"] as const) {
      const rooms = TEMPLATES.congress.rooms.map((r) => (r.id === "hall-a" ? { ...r, setup, stage: { w: 3, d: 5 } } : r));
      const facts = roomSheetFacts(gen(rooms, { eventName: "x" }), "hall-a")!;
      expect(facts.gap).not.toBeNull();
      expect(facts.gap!.metres).toBe(setup === "theatre" ? 1.52 : 2.5);
    }
  });

  it("refuses a room nobody sits in", async () => {
    as("ADMIN");
    const res = await get("?room=foyer-0");
    expect(res.status).toBe(400);
    expect((await res.json!()).code).toBe("ROOM_NOT_SEATED");
  });

  it("names the file part from the room's name", () => {
    expect(roomFilePart("Al Wasl Ballroom (R2)")).toBe("al-wasl-ballroom-r2");
    expect(roomFilePart("***")).toBe("room");
  });
});
