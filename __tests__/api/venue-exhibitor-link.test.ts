/**
 * The exhibitor floor plan link (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md section 10): what the map leaves out (G2,
 * G7), the organiser's route (create, replace, switch off, with the REAL permission code), and the public route
 * (a wrong, switched-off or another event's token all answer the same 404; staff-only items never leave).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PLAN_FIXTURES } from "@/lib/venue/layout-fixtures";
import { exhibitorMap, exhibitorPlan, floorPlanSharePath } from "@/lib/venue/exhibitor-view";
import { setFixture } from "@/lib/venue/plan-edit";
import type { VenuePlan } from "@/lib/venue/plan";

const { mockAuth, mockDb, rateLimit } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    venueShareLink: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn(async () => ({})) },
    user: { findMany: vi.fn(async () => [{ id: "u-ADMIN", firstName: "Alex", lastName: "Admin" }]) },
  },
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
vi.mock("@/lib/security", async (orig) => ({ ...(await orig<typeof import("@/lib/security")>()), checkRateLimit: rateLimit, getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/public-event", () => ({ publicEventWhere: vi.fn(async () => ({})), eventMatchesRequestTenant: vi.fn(async () => true) }));
vi.mock("@/services/venue-programme-service", () => ({
  loadVenueProgramme: vi.fn(async () => ({ v: 1, tz: "Asia/Dubai", sessions: [], sponsors: [{ id: "sp-1", name: "Pfizer" }] })),
}));

import { GET as staffGET, POST as staffPOST } from "@/app/api/events/[eventId]/venue/share-link/route";
import { GET as publicGET } from "@/app/api/public/events/[slug]/floor-plan/[token]/route";

type Res = { status: number; headers: Headers; json: () => Promise<Record<string, unknown>> };
const as = (role: string) => mockAuth.mockResolvedValue({ user: { id: `u-${role}`, role, organizationId: "org-1" } });
const staffParams = { params: Promise.resolve({ eventId: "evt-1" }) };
const post = (action: string) => staffPOST(new Request("http://x", { method: "POST", body: JSON.stringify({ action }) }), staffParams) as Promise<Res>;
const TOKEN = "t".repeat(43);
const open = (token = TOKEN) => publicGET(new Request("http://x"), { params: Promise.resolve({ slug: "conrad-demo", token }) }) as Promise<Res>;

const { rooms, plan } = PLAN_FIXTURES["drawn-placed-stands"];
// A stand with a staff note, and two drawings: one ticked for exhibitors, one not.
const noted = setFixture(plan, "stand-n000002", { note: "Pfizer wants power at the back" });
const withDrawings: VenuePlan = {
  ...noted,
  underlays: [
    { path: "/uploads/venue-drawings/evt-1/3f2b1c4e-5a6d-4e7f-8a9b-0c1d2e3f4a5b.jpg", name: "Ground.jpg", px: [1000, 700], mpp: 0.1, at: [0, 0], opacity: 0.7, exhibitors: true },
    { floor: "level-1", path: "/uploads/venue-drawings/evt-1/4f2b1c4e-5a6d-4e7f-8a9b-0c1d2e3f4a5b.jpg", name: "L1.jpg", px: [1000, 700], mpp: 0.1, at: [0, 0], opacity: 0.7 },
  ],
};

describe("what the exhibitor map leaves out", () => {
  it("staff-only fixtures, notes and drawings not ticked for exhibitors", () => {
    const shown = exhibitorPlan(withDrawings);
    expect(shown.fixtures.some((f) => f.kind === "av-console")).toBe(false);
    expect(shown.fixtures.some((f) => f.kind === "program-wall")).toBe(true);
    expect(JSON.stringify(shown)).not.toContain("power at the back");
    expect(shown.underlays?.map((u) => u.name)).toEqual(["Ground.jpg"]);
    const map = exhibitorMap(rooms, withDrawings, "Demo");
    expect(map.layout.items.some((it) => it.t === "fixture" && it.kind === "av-console")).toBe(false);
    expect(map.layout.items.filter((it) => it.t === "stand").length).toBeGreaterThan(0);
    expect(map.drawings).toHaveLength(1);
    expect("people" in map.layout).toBe(false);
  });

  it("numbers the stands exactly as staff see them, though a staff-only fixture stood on some (review of 6e482da2)", async () => {
    const { buildVenueLayout } = await import("@/lib/venue/plan-layout");
    const { standNumber, standSponsor } = await import("@/lib/venue/stands");
    const base = PLAN_FIXTURES["drawn-congress-west-entrance"];
    const auto = buildVenueLayout(base.rooms, base.plan, { eventName: "x" }).layout;
    const over = auto.items.find((it) => it.t === "stand")!.foot as { x0: number; z0: number; x1: number; z1: number };
    const withAv: VenuePlan = { ...base.plan, fixtures: [...base.plan.fixtures, { id: "av-1", kind: "av-console", rect: [over.x0, over.z0, over.x1, over.z1], dir: "n", name: "AV" }] };
    const sponsors = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, name: `Sponsor ${i + 1}` }));
    const read = (items: { t: string }[]) =>
      items.filter((it): it is import("@/lib/venue/stands").StandItem => it.t === "stand").map((s) => `${standNumber(s)}:${standSponsor(s, sponsors)?.name}@${JSON.stringify(s.foot)}`);
    const staff = buildVenueLayout(base.rooms, withAv, { eventName: "x" }).layout;
    const shown = exhibitorMap(base.rooms, withAv, "x").layout;
    expect(read(shown.items)).toEqual(read(staff.items));
    expect(shown.items.some((it) => it.t === "fixture" && it.kind === "av-console")).toBe(false);
  });

  it("the link's path", () => {
    expect(floorPlanSharePath("conrad-demo", "abc")).toBe("/e/conrad-demo/floor-plan/abc");
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("VENUE_MODULE_ENABLED", "true");
  mockDb.event.findFirst.mockResolvedValue({
    id: "evt-1", slug: "conrad-demo", organizationId: "org-1", name: "Conrad Demo", startDate: new Date("2027-03-01"), endDate: new Date("2027-03-02"),
    timezone: "Asia/Dubai", venue: "Conrad", city: "Dubai", country: "UAE", bannerImage: null, bannerImageMobile: null, organization: { name: "MMG" },
    settings: { venue: { rooms: { list: rooms, updatedAt: 10, updatedBy: "u" }, plan: { plan: withDrawings, updatedAt: 20, updatedBy: "u" } } },
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("the organiser's route", () => {
  const row = (over: Partial<{ token: string; enabled: boolean }> = {}) => ({ id: "link-1", token: TOKEN, enabled: true, updatedAt: new Date(0), updatedById: "u-ADMIN", ...over });

  it("404 while the module is off; 401 signed out; 403 to change it without events.update", async () => {
    vi.stubEnv("VENUE_MODULE_ENABLED", "");
    as("ADMIN");
    expect(((await staffGET(new Request("http://x"), staffParams)) as Res).status).toBe(404);
    vi.stubEnv("VENUE_MODULE_ENABLED", "true");
    mockAuth.mockResolvedValue(null);
    expect((await post("create")).status).toBe(401);
    as("MEMBER");
    expect((await post("create")).status).toBe(403);
    expect(mockDb.venueShareLink.create).not.toHaveBeenCalled();
  });

  it("seeing the link is holding the secret: an organiser may, a read-only member may not", async () => {
    as("MEMBER");
    expect(((await staffGET(new Request("http://x"), staffParams)) as Res).status).toBe(403);
    as("ORGANIZER");
    mockDb.venueShareLink.findUnique.mockResolvedValueOnce(null);
    const res = (await staffGET(new Request("http://x"), staffParams)) as Res;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ link: null });
  });

  it("two Create clicks at once: the second returns the first's link, not an error", async () => {
    as("ADMIN");
    mockDb.venueShareLink.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(row());
    mockDb.venueShareLink.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    const res = await post("create");
    expect(res.status).toBe(200);
    expect(((await res.json()).link as { path: string }).path).toContain(TOKEN);
  });

  it("creates the link once, stamped with the event's organisation", async () => {
    as("ADMIN");
    mockDb.venueShareLink.findUnique.mockResolvedValueOnce(null);
    mockDb.venueShareLink.create.mockResolvedValueOnce(row());
    const res = await post("create");
    expect(res.status).toBe(200);
    expect(mockDb.venueShareLink.create.mock.calls[0][0].data).toMatchObject({ eventId: "evt-1", organizationId: "org-1" });
    expect(((await res.json()).link as { path: string }).path).toBe(`/e/conrad-demo/floor-plan/${TOKEN}`);
  });

  it("replace gives a new token; switching off keeps it; nothing to change before it exists", async () => {
    as("ADMIN");
    mockDb.venueShareLink.findUnique.mockResolvedValue(row());
    mockDb.venueShareLink.update.mockResolvedValue(row({ token: "n".repeat(43) }));
    await post("replace");
    expect(mockDb.venueShareLink.update.mock.calls[0][0].data.token).not.toBe(TOKEN);
    // On or off as it was: a link switched off before launch stays off.
    expect("enabled" in mockDb.venueShareLink.update.mock.calls[0][0].data).toBe(false);
    mockDb.venueShareLink.update.mockResolvedValue(row({ enabled: false }));
    await post("disable");
    expect(mockDb.venueShareLink.update.mock.calls[1][0].data).toEqual({ enabled: false, updatedById: "u-ADMIN" });
    mockDb.venueShareLink.findUnique.mockResolvedValue(null);
    expect((await post("enable")).status).toBe(409);
  });

  it("refuses an unknown action", async () => {
    as("ADMIN");
    expect((await post("delete")).status).toBe(400);
  });
});

describe("the public route", () => {
  it("serves the exhibitor map for an active link, with no staff-only item and no notes", async () => {
    mockDb.venueShareLink.findUnique.mockResolvedValueOnce({ id: "l1", eventId: "evt-1", enabled: true });
    const res = await open();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    const text = JSON.stringify(body);
    expect(text).not.toContain("av-console");
    expect(text).not.toContain("power at the back");
    expect(body.updatedAt).toBe(new Date(20).toISOString());
    expect(body.sponsors).toEqual([{ id: "sp-1", name: "Pfizer" }]);
    expect((body.drawings as { src: string }[])[0].src).toBe(`/api/public/events/conrad-demo/floor-plan/${TOKEN}/drawing?floor=ground`);
  });

  it("an unknown token, another event's, a switched-off one or a malformed one: the same 404", async () => {
    for (const link of [null, { id: "l1", eventId: "evt-2", enabled: true }, { id: "l1", eventId: "evt-1", enabled: false }]) {
      mockDb.venueShareLink.findUnique.mockResolvedValueOnce(link);
      const res = await open();
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("LINK_INACTIVE");
    }
    expect((await open("short")).status).toBe(404);
  });

  it("dark while the module is off; 429 past the limit", async () => {
    vi.stubEnv("VENUE_MODULE_ENABLED", "");
    expect((await open()).status).toBe(404);
    vi.stubEnv("VENUE_MODULE_ENABLED", "true");
    rateLimit.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 30 });
    expect((await open()).status).toBe(429);
  });
});
