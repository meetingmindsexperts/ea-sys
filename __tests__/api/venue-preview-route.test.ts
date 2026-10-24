/**
 * POST /e/:slug/venue/preview (floor plan editor phase 2, "Preview in 3D"):
 * the event team walks an unsaved plan. Same-origin only; events.update;
 * the venue module on and rooms saved, the venue need not be opened; the plan
 * checked as a save checks it; the page offline (no runtime, no person's id)
 * with the preview strip; nothing stored.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockAuth, mockDb } = vi.hoisted(() => ({ mockAuth: vi.fn(), mockDb: { event: { findFirst: vi.fn(), update: vi.fn() } } }));

vi.mock("next/server", () => {
  class NextResponse {
    status: number;
    headers: Headers;
    constructor(public body: string | null, init?: { status?: number; headers?: Record<string, string> }) {
      this.status = init?.status ?? 200;
      this.headers = new Headers(init?.headers);
    }
    static json(b: unknown, i?: { status?: number }) { return new NextResponse(JSON.stringify(b), i); }
  }
  return { NextResponse };
});
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn, error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
const { loadVenueProgramme } = vi.hoisted(() => ({ loadVenueProgramme: vi.fn() }));
vi.mock("@/services/venue-programme-service", () => ({ loadVenueProgramme }));

import { POST } from "@/app/e/[slug]/venue/preview/route";
import { generateLayout } from "@/lib/venue/layout";
import { planFromLayout, type VenuePlan } from "@/lib/venue/plan";
import { setDoor } from "@/lib/venue/plan-edit";
import { TEMPLATES } from "@/lib/venue/rooms";

const rooms = TEMPLATES.congress.rooms;
const autoPlan = (): VenuePlan => planFromLayout(generateLayout(rooms, { eventName: "" }));
const EVENT = {
  id: "evt-1", slug: "c27", name: "Congress 2027", startDate: new Date("2027-04-10T06:00:00Z"), endDate: new Date("2027-04-12T06:00:00Z"),
  venue: "Hall", timezone: "Asia/Dubai", eventType: "CONFERENCE", organizationId: "org-1", code: null, specialty: null, organization: { name: "MMG" },
  // Rooms saved, venue NOT opened: a preview does not need it open.
  settings: { venue: { rooms: { list: rooms, updatedAt: 1, updatedBy: "u-1" } } },
  staffAssignments: [],
};

let seq = 0;
function post(body: unknown, opts: { origin?: string | null; raw?: string } = {}) {
  const form = new URLSearchParams();
  if (opts.raw !== undefined) form.set("plan", opts.raw);
  else if (body !== undefined) form.set("plan", JSON.stringify(body));
  // As behind nginx: the request's own URL is the container's, the Host header is the public one.
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", host: "events.example.test" };
  const origin = opts.origin === undefined ? "https://events.example.test" : opts.origin;
  if (origin) headers.origin = origin;
  return POST(new Request("http://0.0.0.0:3000/e/c27/venue/preview", { method: "POST", headers, body: form }), { params: Promise.resolve({ slug: "c27" }) }) as unknown as Promise<{
    status: number;
    body: string;
    headers: Headers;
  }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("VENUE_MODULE_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://events.example.test");
  // A new user per test keeps the per-person rate limit out of the other tests.
  mockAuth.mockResolvedValue({ user: { id: `u-${++seq}`, role: "ADMIN", organizationId: "org-1", name: "Wren" } });
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  loadVenueProgramme.mockResolvedValue({ v: 1, tz: "Asia/Dubai", sessions: [], sponsors: [] });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /e/:slug/venue/preview", () => {
  it("renders the unsaved plan offline, marked as a preview, and stores nothing", async () => {
    const plan = setDoor(autoPlan(), "foyer", { wall: "w" }, true);
    const res = await post(plan);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.body).toContain("Preview of unsaved changes");
    // Offline: no runtime, so nothing about this person is sent and nothing can be saved.
    expect(res.body).not.toContain('<script src="/venue-runtime.js">');
    expect(res.body).not.toContain("window.EHC_VENUE=");
    expect(res.body).not.toContain('"userId"');
    // The drawn entrance (west wall) is the layout served.
    const layout = JSON.parse(res.body.match(/window\.EHC_LAYOUT=(.*?);window\.EHC_EVENT=/)![1]);
    expect(layout.walls.some((w: { axis: string; opens: { glass?: boolean }[] }) => w.axis === "z" && w.opens.some((o) => o.glass))).toBe(true);
    expect(mockDb.event.update).not.toHaveBeenCalled();
  });

  it("refuses a form from another site", async () => {
    expect((await post(autoPlan(), { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(autoPlan(), { origin: null })).status).toBe(403);
    expect((await post(autoPlan(), { origin: "null" })).status).toBe(403);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "venue:preview:cross-origin" }));
  });

  it("judges the origin by the forwarded Host, not the container's own address", async () => {
    expect((await post(autoPlan(), { origin: "https://events.example.test" })).status).toBe(200);
    expect((await post(autoPlan(), { origin: "http://0.0.0.0:3000" })).status).toBe(403);
  });

  it("is for the event team only (events.update)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u-member", role: "MEMBER", organizationId: "org-1", name: "M" } });
    expect((await post(autoPlan())).status).toBe(403);
  });

  it("is not found while the venue module is off or the rooms are not saved", async () => {
    vi.stubEnv("VENUE_MODULE_ENABLED", "");
    expect((await post(autoPlan())).status).toBe(404);
    vi.stubEnv("VENUE_MODULE_ENABLED", "true");
    mockDb.event.findFirst.mockResolvedValue({ ...EVENT, settings: {} });
    expect((await post(autoPlan())).status).toBe(404);
  });

  it("refuses a large body by its length, before reading it", async () => {
    const res = (await POST(
      new Request("http://0.0.0.0:3000/e/c27/venue/preview", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", host: "events.example.test", origin: "https://events.example.test", "content-length": "500000" },
        body: "plan=%7B%7D",
      }),
      { params: Promise.resolve({ slug: "c27" }) },
    )) as unknown as { status: number };
    expect(res.status).toBe(413);
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
  });

  it("refuses a missing, malformed, oversized or invalid plan with a logged reason", async () => {
    expect((await post(undefined)).status).toBe(400);
    expect((await post(undefined, { raw: "{not json" })).status).toBe(400);
    expect((await post(undefined, { raw: "x".repeat(100_001) })).status).toBe(413);
    const bad = await post({ ...autoPlan(), v: 2 });
    expect(bad.status).toBe(400);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "venue:preview:invalid-plan" }));
  });

  it("refuses a plan that cannot be walked, listing why with room names escaped", async () => {
    const hostile = rooms.map((r) => (r.kind === "lounge" ? { ...r, name: "<img src=x onerror=alert(1)>" } : r));
    mockDb.event.findFirst.mockResolvedValue({ ...EVENT, settings: { venue: { rooms: { list: hostile, updatedAt: 1, updatedBy: "u-1" } } } });
    const res = await post(setDoor(autoPlan(), "lounge", { wall: "e" }));
    expect(res.status).toBe(422);
    expect(res.body).toContain("opens onto the outside");
    expect(res.body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(res.body).not.toContain("<img src=x");
  });
});
